import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";

const app = express();
const port = 3109;

// CORS configuration
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    "http://localhost:8080",
    "https://fcc.lol",
    "https://www.fcc.lol"
  ],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Cache for projects data
let projectsCache = null;
let lastCacheUpdate = null;
let isUpdatingCache = false;
const CACHE_FILE = "projects-cache.json";

// Function to fetch projects from remote storage
async function fetchProjectsFromRemote() {
  const baseUrl = "https://static.fcc.lol/portfolio-storage";
  const projects = [];

  // Fetch the directory index from the remote URL
  const response = await fetch(`${baseUrl}/`);
  if (!response.ok) {
    throw new Error(`Failed to fetch directory index: ${response.status}`);
  }

  const html = await response.text();

  // Parse the HTML to extract project directories
  // Look for links that point to directories (end with /)
  const projectFolders = [];
  const linkRegex = /<a href="([^"]+\/)">/g;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const folderName = match[1].replace("/", ""); // Remove trailing slash
    if (folderName && folderName !== ".." && folderName !== ".") {
      projectFolders.push(folderName);
    }
  }

  // For each project folder, fetch the manifest.json
  for (const projectName of projectFolders) {
    try {
      const manifestUrl = `${baseUrl}/${projectName}/manifest.json`;
      const manifestResponse = await fetch(manifestUrl);

      if (manifestResponse.ok) {
        const manifest = await manifestResponse.json();

        // Fetch media files from the media folder
        const mediaUrl = `${baseUrl}/${projectName}/media/`;
        let media = [];
        let primaryImage = null; // Initialize primaryImage

        try {
          const mediaResponse = await fetch(mediaUrl);
          if (mediaResponse.ok) {
            const mediaHtml = await mediaResponse.text();

            // Parse media files from the HTML
            const mediaFileRegex = /<a href="([^"]+)">/g;
            const mediaFiles = [];
            const imageFiles = [];
            const videoFiles = [];
            let mediaMatch;

            while ((mediaMatch = mediaFileRegex.exec(mediaHtml)) !== null) {
              const filename = mediaMatch[1];
              // Only include common media file extensions
              const ext = path.extname(filename).toLowerCase();
              if (
                [
                  ".jpg",
                  ".jpeg",
                  ".png",
                  ".gif",
                  ".mp4",
                  ".mov",
                  ".avi",
                  ".webm"
                ].includes(ext)
              ) {
                mediaFiles.push(filename);

                // Separate images from videos
                if ([".jpg", ".jpeg", ".png", ".gif"].includes(ext)) {
                  imageFiles.push(filename);
                } else {
                  videoFiles.push(filename);
                }
              }
            }

            // Sort alphabetically and convert to full URLs
            const allMedia = mediaFiles
              .sort()
              .map((filename) => `${baseUrl}/${projectName}/media/${filename}`);

            // Get the first image as primary image
            primaryImage =
              imageFiles.length > 0
                ? `${baseUrl}/${projectName}/media/${imageFiles.sort()[0]}`
                : null;

            // Combine all media
            media = allMedia;
          }
        } catch (mediaError) {
          console.warn(
            `Could not fetch media for ${projectName}:`,
            mediaError.message
          );
        }

        // Format the date to ISO format if it exists
        let formattedDate = null;
        if (manifest.date) {
          // Parse common date formats and convert to YYYY-MM-DD
          const dateStr = manifest.date;
          let date;

          // Handle "Month Day, Year" format
          if (dateStr.includes(",")) {
            date = new Date(dateStr);
          } else {
            // Handle other formats
            date = new Date(dateStr);
          }

          if (!isNaN(date.getTime())) {
            formattedDate = date.toISOString().split("T")[0]; // YYYY-MM-DD format
          }
        }

        // Create a new object with id first, then the rest of the manifest, and media
        const projectWithId = {
          id: projectName,
          ...manifest,
          date: formattedDate || manifest.date, // Use formatted date or fallback to original
          media,
          primaryImage
        };

        projects.push(projectWithId);
      }
    } catch (projectError) {
      console.warn(
        `Could not fetch project ${projectName}:`,
        projectError.message
      );
    }
  }

  return projects;
}

// Function to save cache to file
function saveCacheToFile() {
  try {
    const cacheData = {
      projects: projectsCache,
      lastUpdate: lastCacheUpdate,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
    console.log("Cache saved to file");
  } catch (error) {
    console.error("Error saving cache to file:", error);
  }
}

// Function to load cache from file
function loadCacheFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      projectsCache = cacheData.projects;
      lastCacheUpdate = cacheData.lastUpdate;
      console.log(
        `Cache loaded from file with ${projectsCache?.length || 0} projects`
      );
      return true;
    }
  } catch (error) {
    console.error("Error loading cache from file:", error);
  }
  return false;
}

// Function to update cache in background
async function updateCacheInBackground() {
  if (isUpdatingCache) {
    return; // Already updating
  }

  isUpdatingCache = true;
  try {
    console.log("Updating projects cache in background...");
    const newProjects = await fetchProjectsFromRemote();
    projectsCache = newProjects;
    lastCacheUpdate = Date.now();
    saveCacheToFile(); // Save to file after updating
    console.log(
      `Cache updated successfully with ${newProjects.length} projects`
    );
  } catch (error) {
    console.error("Error updating cache:", error);
  } finally {
    isUpdatingCache = false;
  }
}

app.get("/projects", async (req, res) => {
  try {
    // Always serve from cache if available
    if (projectsCache) {
      console.log("Serving projects from cache");
      res.json(projectsCache);

      // Always update cache in background
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      console.log("No cache available, fetching fresh projects data");
      const projects = await fetchProjectsFromRemote();
      projectsCache = projects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(); // Save to file after updating
      res.json(projects);
    }
  } catch (error) {
    console.error("Error reading projects:", error);

    // If we have cache, serve it as fallback
    if (projectsCache) {
      console.log("Serving cache due to error");
      res.json(projectsCache);
    } else {
      res.status(500).json({ error: "Failed to read projects" });
    }
  }
});

// Load cache from file on startup
loadCacheFromFile();

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
