import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import imageSize from "image-size";
import { execFile } from "child_process";
import { promisify } from "util";
import dotenv from "dotenv";
import sharp from "sharp";

// Load environment variables
dotenv.config();

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

// Middleware to authenticate admin routes
function authenticateAdmin(req, res, next) {
  const { fccAdminApiKey } = req.query;
  const expectedKey = process.env.FCC_ADMIN_API_KEY;

  if (!expectedKey) {
    return res.status(500).json({
      error: "Server configuration error",
      message: "FCC_ADMIN_API_KEY environment variable not set"
    });
  }

  if (!fccAdminApiKey) {
    return res.status(401).json({
      error: "Authentication required",
      message: "Missing fccAdminApiKey parameter"
    });
  }

  if (fccAdminApiKey !== expectedKey) {
    return res.status(403).json({
      error: "Authentication failed",
      message: "Invalid API key"
    });
  }

  next();
}

// Cache for projects data
let projectsCache = null;
let lastCacheUpdate = null;
let isUpdatingCache = false;
const CACHE_FILE = "projects-cache.json";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

// Function to get image dimensions from URL
async function getImageDimensions(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const dimensions = imageSize(buffer);

    return {
      width: dimensions.width,
      height: dimensions.height
    };
  } catch (error) {
    console.warn(`Could not get dimensions for ${url}:`, error.message);
    return null;
  }
}

const execFileAsync = promisify(execFile);

// Helper function to escape HTML for safe insertion into meta tags
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Helper function to generate HTML with Open Graph tags for projects
function generatePageHtml(project, projectId) {
  const baseUrl = "https://fcc.lol";
  const apiUrl = `https://portfolio-api.fcc.lol`;

  const title = project.title || project.name || "Untitled Project";
  const description = project.description || `Project by FCC Studio`;
  const shareImageUrl =
    project.primaryImage?.url || `${apiUrl}/projects/${projectId}/share-image`;
  const projectUrl = `${baseUrl}/${projectId}`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    
    <!-- Basic meta tags -->
    <meta name="description" content="${escapeHtml(description)}" />
    
    <!-- Open Graph meta tags -->
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${projectUrl}" />
    <meta property="og:site_name" content="FCC Studio" />
    <meta property="og:image" content="${shareImageUrl}" />
    <meta property="og:image:type" content="image/jpeg" />
    
    <!-- Twitter Card meta tags -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${shareImageUrl}" />
    
    <!-- Redirect to main app after a short delay (for any missed crawlers) -->
    <script>
      setTimeout(() => {
        window.location.href = '${baseUrl}/${projectId}';
      }, 1000);
    </script>
  </head>
  <body>
    <div style="text-align: center; padding: 2rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <p style="color: #666;">Loading project...</p>
      <p style="color: #999; font-size: 0.9rem;">
        If you're not redirected, <a href="/${projectId}">click here</a>
      </p>
    </div>
  </body>
</html>`;
}

// Helper function to generate HTML for homepage
function generateHomepageHtml() {
  const baseUrl = "https://fcc.lol";
  const apiUrl = `https://portfolio-api.fcc.lol`;

  const title = "FCC Studio - Creative Portfolio";
  const description =
    "Explore our latest creative projects, from design to development and everything in between.";
  const shareImageUrl = `${apiUrl}/homepage/share-image`;
  const homepageUrl = baseUrl;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    
    <!-- Basic meta tags -->
    <meta name="description" content="${escapeHtml(description)}" />
    
    <!-- Open Graph meta tags -->
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${homepageUrl}" />
    <meta property="og:site_name" content="FCC Studio" />
    <meta property="og:image" content="${shareImageUrl}" />
    <meta property="og:image:type" content="image/jpeg" />
    
    <!-- Twitter Card meta tags -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${shareImageUrl}" />
    
    <!-- Redirect to main app after a short delay (for any missed crawlers) -->
    <script>
      setTimeout(() => {
        window.location.href = '${baseUrl}';
      }, 1000);
    </script>
  </head>
  <body>
    <div style="text-align: center; padding: 2rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <p style="color: #666;">Loading portfolio...</p>
      <p style="color: #999; font-size: 0.9rem;">
        If you're not redirected, <a href="/">click here</a>
      </p>
    </div>
  </body>
</html>`;
}

// Helper function to generate HTML for tag pages
function generateTagPageHtml(tagName, projectCount) {
  const baseUrl = "https://fcc.lol";
  const apiUrl = `https://portfolio-api.fcc.lol`;

  const title = `${tagName} Projects - FCC Studio`;
  const description = `Explore ${projectCount} project${
    projectCount !== 1 ? "s" : ""
  } tagged with "${tagName}" from FCC Studio.`;
  const shareImageUrl = `${apiUrl}/tag/${encodeURIComponent(
    tagName
  )}/share-image`;
  const tagUrl = `${baseUrl}/tag/${tagName}`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    
    <!-- Basic meta tags -->
    <meta name="description" content="${escapeHtml(description)}" />
    
    <!-- Open Graph meta tags -->
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${tagUrl}" />
    <meta property="og:site_name" content="FCC Studio" />
    <meta property="og:image" content="${shareImageUrl}" />
    <meta property="og:image:type" content="image/jpeg" />
    
    <!-- Twitter Card meta tags -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${shareImageUrl}" />
    
    <!-- Redirect to main app after a short delay (for any missed crawlers) -->
    <script>
      setTimeout(() => {
        window.location.href = '${baseUrl}/tag/${tagName}';
      }, 1000);
    </script>
  </head>
  <body>
    <div style="text-align: center; padding: 2rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <p style="color: #666;">Loading projects...</p>
      <p style="color: #999; font-size: 0.9rem;">
        If you're not redirected, <a href="/tag/${tagName}">click here</a>
      </p>
    </div>
  </body>
</html>`;
}

// Helper function to generate HTML for person pages
function generatePersonPageHtml(personName, projectCount) {
  const baseUrl = "https://fcc.lol";
  const apiUrl = `https://portfolio-api.fcc.lol`;

  const title = `${personName} - FCC Studio`;
  const description = `View ${projectCount} project${
    projectCount !== 1 ? "s" : ""
  } by ${personName} at FCC Studio.`;
  const shareImageUrl = `${apiUrl}/person/${encodeURIComponent(
    personName
  )}/share-image`;
  const personUrl = `${baseUrl}/person/${personName}`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    
    <!-- Basic meta tags -->
    <meta name="description" content="${escapeHtml(description)}" />
    
    <!-- Open Graph meta tags -->
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${personUrl}" />
    <meta property="og:site_name" content="FCC Studio" />
    <meta property="og:image" content="${shareImageUrl}" />
    <meta property="og:image:type" content="image/jpeg" />
    
    <!-- Twitter Card meta tags -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${shareImageUrl}" />
    
    <!-- Redirect to main app after a short delay (for any missed crawlers) -->
    <script>
      setTimeout(() => {
        window.location.href = '${baseUrl}/person/${personName}';
      }, 1000);
    </script>
  </head>
  <body>
    <div style="text-align: center; padding: 2rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <p style="color: #666;">Loading projects...</p>
      <p style="color: #999; font-size: 0.9rem;">
        If you're not redirected, <a href="/person/${personName}">click here</a>
      </p>
    </div>
  </body>
</html>`;
}

// Function to get video dimensions from URL
async function getVideoDimensions(url) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", url],
      {
        timeout: 30000 // 30 second timeout
      }
    );

    const info = JSON.parse(stdout);

    // Check if ffprobe returned valid data
    if (!info || !info.streams || !Array.isArray(info.streams)) {
      throw new Error(`Invalid ffprobe response: ${JSON.stringify(info)}`);
    }

    // Find the video stream
    const videoStream = info.streams.find(
      (stream) => stream.codec_type === "video"
    );

    if (videoStream && videoStream.width && videoStream.height) {
      return {
        width: videoStream.width,
        height: videoStream.height
      };
    } else {
      throw new Error("No video stream found or dimensions not available");
    }
  } catch (error) {
    console.warn(`Could not get video dimensions for ${url}:`, error.message);
    return null;
  }
}

// Function to sort projects by date, newest first
function sortProjectsByDate(projects) {
  return [...projects].sort((a, b) => {
    // Handle cases where date might be null or undefined
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1; // Projects without dates go to the end
    if (!b.date) return -1; // Projects without dates go to the end

    // Compare dates in descending order (newest first)
    return new Date(b.date) - new Date(a.date);
  });
}

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
    if (
      folderName &&
      folderName !== ".." &&
      folderName !== "." &&
      folderName !== "_template"
    ) {
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

            // Sort alphabetically and process media files with dimensions
            const sortedMediaFiles = mediaFiles.sort();
            const allMedia = [];

            for (const filename of sortedMediaFiles) {
              const url = `${baseUrl}/${projectName}/media/${filename}`;
              const ext = path.extname(filename).toLowerCase();

              if ([".jpg", ".jpeg", ".png", ".gif"].includes(ext)) {
                // This is an image - get dimensions
                const dimensions = await getImageDimensions(url);
                allMedia.push({
                  url,
                  type: "image",
                  filename,
                  dimensions
                });
              } else {
                // This is a video - get dimensions
                const dimensions = await getVideoDimensions(url);
                allMedia.push({
                  url,
                  type: "video",
                  filename,
                  dimensions
                });
              }
            }

            // Get the first image as primary image with dimensions
            if (imageFiles.length > 0) {
              const firstImageFilename = imageFiles.sort()[0];
              const primaryImageUrl = `${baseUrl}/${projectName}/media/${firstImageFilename}`;
              const primaryImageDimensions = await getImageDimensions(
                primaryImageUrl
              );

              primaryImage = {
                url: primaryImageUrl,
                filename: firstImageFilename,
                dimensions: primaryImageDimensions
              };
            }

            // Set media to the processed array
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
      return true;
    }
  } catch (error) {
    console.error("Error loading cache from file:", error);
  }
  return false;
}

// Function to remove media array from projects (keep only primaryImage)
function removeMediaFromProjects(projects) {
  return projects.map((project) => {
    const { media, ...projectWithoutMedia } = project;
    return projectWithoutMedia;
  });
}

// Function to filter projects by person name
function filterProjectsByPerson(projects, personName) {
  const lowerPersonName = personName.toLowerCase();
  return projects.filter((project) => {
    // Check credits array only
    if (project.credits && Array.isArray(project.credits)) {
      return project.credits.some(
        (credit) => credit.name && credit.name.toLowerCase() === lowerPersonName
      );
    }

    return false;
  });
}

// Function to get all unique tags from projects
function getAllTags(projects) {
  const tagSet = new Set();

  projects.forEach((project) => {
    if (project.tags && Array.isArray(project.tags)) {
      project.tags.forEach((tag) => {
        if (tag && typeof tag === "string") {
          tagSet.add(tag.trim());
        }
      });
    }
  });

  return Array.from(tagSet).sort();
}

// Function to filter projects by tag
function filterProjectsByTag(projects, tagName) {
  const lowerTagName = tagName.toLowerCase();
  return projects.filter((project) => {
    if (project.tags && Array.isArray(project.tags)) {
      return project.tags.some(
        (tag) =>
          tag && typeof tag === "string" && tag.toLowerCase() === lowerTagName
      );
    }
    return false;
  });
}

// Function to check if cache is stale
function isCacheStale() {
  if (!lastCacheUpdate) return true;
  return Date.now() - lastCacheUpdate > CACHE_TTL;
}

// Function to update cache in background (only if stale)
async function updateCacheInBackground() {
  if (isUpdatingCache || !isCacheStale()) {
    return; // Already updating or cache is still fresh
  }

  console.log("Cache is stale, updating in background...");
  isUpdatingCache = true;
  try {
    const newProjects = await fetchProjectsFromRemote();
    projectsCache = newProjects;
    lastCacheUpdate = Date.now();
    saveCacheToFile(); // Save to file after updating
    console.log("Cache updated successfully");
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
      res.json(sortProjectsByDate(projectsCache));

      // Always update cache in background
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const projects = await fetchProjectsFromRemote();
      projectsCache = projects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(); // Save to file after updating

      res.json(sortProjectsByDate(projects));
    }
  } catch (error) {
    console.error("Error reading projects:", error);

    // If we have cache, serve it as fallback
    if (projectsCache) {
      res.json(sortProjectsByDate(projectsCache));
    } else {
      res.status(500).json({ error: "Failed to read projects" });
    }
  }
});

app.get("/projects/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;

    // Always serve from cache if available
    if (projectsCache) {
      const project = projectsCache.find((p) => p.id === projectId);

      if (project) {
        res.json(project);
      } else {
        res.status(404).json({ error: "Project not found" });
      }

      // Always update cache in background
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const projects = await fetchProjectsFromRemote();
      projectsCache = projects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(); // Save to file after updating

      const project = projects.find((p) => p.id === projectId);
      if (project) {
        res.json(project);
      } else {
        res.status(404).json({ error: "Project not found" });
      }
    }
  } catch (error) {
    console.error(`Error reading project ${req.params.projectId}:`, error);

    // If we have cache, serve it as fallback
    if (projectsCache) {
      const project = projectsCache.find((p) => p.id === req.params.projectId);
      if (project) {
        res.json(project);
      } else {
        res.status(404).json({ error: "Project not found" });
      }
    } else {
      res.status(500).json({ error: "Failed to read project" });
    }
  }
});

// Get projects by person/author
app.get("/projects/person/:personName", async (req, res) => {
  try {
    const { personName } = req.params;

    // Always serve from cache if available
    if (projectsCache) {
      const personProjects = filterProjectsByPerson(projectsCache, personName);
      const personProjectsWithoutMedia =
        removeMediaFromProjects(personProjects);
      res.json(sortProjectsByDate(personProjectsWithoutMedia));

      // Always update cache in background
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const projects = await fetchProjectsFromRemote();
      projectsCache = projects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(); // Save to file after updating

      // Filter projects by person
      const personProjects = filterProjectsByPerson(projects, personName);
      const personProjectsWithoutMedia =
        removeMediaFromProjects(personProjects);
      res.json(sortProjectsByDate(personProjectsWithoutMedia));
    }
  } catch (error) {
    console.error(
      `Error reading projects for person ${req.params.personName}:`,
      error
    );

    // If we have cache, serve it as fallback
    if (projectsCache) {
      const personProjects = filterProjectsByPerson(
        projectsCache,
        req.params.personName
      );
      const personProjectsWithoutMedia =
        removeMediaFromProjects(personProjects);
      res.json(sortProjectsByDate(personProjectsWithoutMedia));
    } else {
      res.status(500).json({ error: "Failed to read projects" });
    }
  }
});

// Get all unique tags from projects
app.get("/tags", async (req, res) => {
  try {
    // Always serve from cache if available
    if (projectsCache) {
      const tags = getAllTags(projectsCache);
      res.json(tags);

      // Always update cache in background
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const projects = await fetchProjectsFromRemote();
      projectsCache = projects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(); // Save to file after updating

      const tags = getAllTags(projects);
      res.json(tags);
    }
  } catch (error) {
    console.error("Error reading tags:", error);

    // If we have cache, serve it as fallback
    if (projectsCache) {
      const tags = getAllTags(projectsCache);
      res.json(tags);
    } else {
      res.status(500).json({ error: "Failed to read tags" });
    }
  }
});

// Get projects by tag
app.get("/projects/tag/:tagName", async (req, res) => {
  try {
    const { tagName } = req.params;

    // Always serve from cache if available
    if (projectsCache) {
      const tagProjects = filterProjectsByTag(projectsCache, tagName);
      const tagProjectsWithoutMedia = removeMediaFromProjects(tagProjects);
      res.json(sortProjectsByDate(tagProjectsWithoutMedia));

      // Always update cache in background
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const projects = await fetchProjectsFromRemote();
      projectsCache = projects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(); // Save to file after updating

      // Filter projects by tag
      const tagProjects = filterProjectsByTag(projects, tagName);
      const tagProjectsWithoutMedia = removeMediaFromProjects(tagProjects);
      res.json(sortProjectsByDate(tagProjectsWithoutMedia));
    }
  } catch (error) {
    console.error(
      `Error reading projects for tag ${req.params.tagName}:`,
      error
    );

    // If we have cache, serve it as fallback
    if (projectsCache) {
      const tagProjects = filterProjectsByTag(
        projectsCache,
        req.params.tagName
      );
      const tagProjectsWithoutMedia = removeMediaFromProjects(tagProjects);
      res.json(sortProjectsByDate(tagProjectsWithoutMedia));
    } else {
      res.status(500).json({ error: "Failed to read projects" });
    }
  }
});

// Manual cache refresh endpoint (for administrative purposes)
app.get("/admin/refresh-cache", authenticateAdmin, async (req, res) => {
  try {
    if (isUpdatingCache) {
      return res.status(429).json({
        error: "Cache update already in progress",
        message: "Please wait for the current update to complete"
      });
    }

    console.log("Manual cache refresh requested");
    isUpdatingCache = true;

    const newProjects = await fetchProjectsFromRemote();
    projectsCache = newProjects;
    lastCacheUpdate = Date.now();
    saveCacheToFile();

    console.log("Manual cache refresh completed successfully");
    res.json({
      success: true,
      message: "Cache refreshed successfully",
      projectCount: newProjects.length,
      timestamp: new Date(lastCacheUpdate).toISOString()
    });
  } catch (error) {
    console.error("Error during manual cache refresh:", error);
    res.status(500).json({
      error: "Failed to refresh cache",
      message: error.message
    });
  } finally {
    isUpdatingCache = false;
  }
});

// Cache status endpoint
app.get("/admin/cache-status", authenticateAdmin, (req, res) => {
  const cacheAge = lastCacheUpdate ? Date.now() - lastCacheUpdate : null;
  const isStale = isCacheStale();

  res.json({
    hasCachedData: !!projectsCache,
    projectCount: projectsCache ? projectsCache.length : 0,
    lastUpdate: lastCacheUpdate
      ? new Date(lastCacheUpdate).toISOString()
      : null,
    cacheAgeMs: cacheAge,
    cacheAgeMinutes: cacheAge ? Math.round(cacheAge / 60000) : null,
    isStale,
    isUpdating: isUpdatingCache,
    ttlMs: CACHE_TTL,
    ttlMinutes: CACHE_TTL / 60000
  });
});

// Homepage prerender route for social media crawlers
app.get("/projects/prerender", async (req, res) => {
  try {
    // Generate HTML with proper meta tags for homepage
    const html = generateHomepageHtml();

    // Set content type and send HTML
    res.set("Content-Type", "text/html");
    res.send(html);

    // Update cache in background if needed
    if (projectsCache) {
      updateCacheInBackground();
    }
  } catch (error) {
    console.error("Error prerendering homepage:", error);
    res.status(500).send("Internal server error");
  }
});

// Tag page prerender route for social media crawlers
app.get("/projects/prerender/tag/:tagName", async (req, res) => {
  try {
    const { tagName } = req.params;

    // Get projects from cache
    if (!projectsCache) {
      // If no cache, generate basic HTML without project count
      const html = generateTagPageHtml(tagName, 0);
      res.set("Content-Type", "text/html");
      res.send(html);
      return;
    }

    // Filter projects by tag to get count
    const tagProjects = filterProjectsByTag(projectsCache, tagName);
    const projectCount = tagProjects.length;

    // Generate HTML with proper meta tags
    const html = generateTagPageHtml(tagName, projectCount);

    // Set content type and send HTML
    res.set("Content-Type", "text/html");
    res.send(html);

    // Update cache in background
    updateCacheInBackground();
  } catch (error) {
    console.error("Error prerendering tag page:", error);
    res.status(500).send("Internal server error");
  }
});

// Person page prerender route for social media crawlers
app.get("/projects/prerender/person/:personName", async (req, res) => {
  try {
    const { personName } = req.params;

    // Get projects from cache
    if (!projectsCache) {
      // If no cache, generate basic HTML without project count
      const html = generatePersonPageHtml(personName, 0);
      res.set("Content-Type", "text/html");
      res.send(html);
      return;
    }

    // Filter projects by person to get count
    const personProjects = filterProjectsByPerson(projectsCache, personName);
    const projectCount = personProjects.length;

    // Generate HTML with proper meta tags
    const html = generatePersonPageHtml(personName, projectCount);

    // Set content type and send HTML
    res.set("Content-Type", "text/html");
    res.send(html);

    // Update cache in background
    updateCacheInBackground();
  } catch (error) {
    console.error("Error prerendering person page:", error);
    res.status(500).send("Internal server error");
  }
});

// Prerender route for social media crawlers
app.get("/projects/prerender/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;

    // Always serve from cache if available
    if (projectsCache) {
      const project = projectsCache.find((p) => p.id === projectId);

      if (project) {
        // Generate HTML with proper meta tags
        const html = generatePageHtml(project, projectId);

        // Set content type and send HTML
        res.set("Content-Type", "text/html");
        res.send(html);
      } else {
        res.status(404).send("Project not found");
      }

      // Always update cache in background
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const projects = await fetchProjectsFromRemote();
      projectsCache = projects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(); // Save to file after updating

      const project = projects.find((p) => p.id === projectId);
      if (project) {
        // Generate HTML with proper meta tags
        const html = generatePageHtml(project, projectId);

        // Set content type and send HTML
        res.set("Content-Type", "text/html");
        res.send(html);
      } else {
        res.status(404).send("Project not found");
      }
    }
  } catch (error) {
    console.error("Error prerendering project:", error);
    res.status(500).send("Internal server error");
  }
});

// Homepage share image endpoint
app.get("/homepage/share-image", async (req, res) => {
  try {
    // Get projects from cache
    if (!projectsCache) {
      return res.status(400).json({ error: "No projects data available" });
    }

    // Get sorted projects and extract primary images
    const sortedProjects = sortProjectsByDate(projectsCache);
    const images = [];

    for (const project of sortedProjects) {
      if (project.primaryImage?.url && images.length < 4) {
        images.push(project.primaryImage.url);
      }
    }

    if (images.length === 0) {
      return res
        .status(400)
        .json({ error: "No primary images found in projects" });
    }

    // Download and process images
    const imageBuffers = [];
    const baseUrl = "https://static.fcc.lol/portfolio-storage";

    for (const imageUrl of images) {
      try {
        let imagePath;

        if (imageUrl.startsWith(baseUrl)) {
          // Extract the relative path from the full URL
          const relativePath = imageUrl.replace(baseUrl + "/", "");
          // For homepage, we'll fetch from remote URLs directly
          const response = await fetch(imageUrl);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            imageBuffers.push(imageBuffer);
          }
        }
      } catch (error) {
        console.error(`[DEBUG] Error processing image ${imageUrl}:`, error);
      }
    }

    if (imageBuffers.length === 0) {
      return res.status(400).json({ error: "No valid images found" });
    }

    // Create composite image based on number of images
    let composite;
    const canvasWidth = 1200;
    const canvasHeight = 630;

    if (imageBuffers.length === 1) {
      // Single image - resize to fill canvas
      composite = sharp(imageBuffers[0]).resize(canvasWidth, canvasHeight, {
        fit: "cover",
        position: "center",
        withoutEnlargement: false
      });
    } else if (imageBuffers.length === 2) {
      // Two images - split vertically
      const halfWidth = canvasWidth / 2;
      const [img1, img2] = await Promise.all([
        sharp(imageBuffers[0])
          .resize(halfWidth, canvasHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[1])
          .resize(halfWidth, canvasHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer()
      ]);

      composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).composite([
        { input: img1, left: 0, top: 0 },
        { input: img2, left: halfWidth, top: 0 }
      ]);
    } else if (imageBuffers.length === 3) {
      // Three images - one large on left, two stacked on right
      const halfWidth = canvasWidth / 2;
      const halfHeight = canvasHeight / 2;

      const [img1, img2, img3] = await Promise.all([
        sharp(imageBuffers[0])
          .resize(halfWidth, canvasHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[1])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[2])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer()
      ]);

      composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).composite([
        { input: img1, left: 0, top: 0 },
        { input: img2, left: halfWidth, top: 0 },
        { input: img3, left: halfWidth, top: halfHeight }
      ]);
    } else {
      // Four or more images - 2x2 grid
      const halfWidth = canvasWidth / 2;
      const halfHeight = canvasHeight / 2;

      const [img1, img2, img3, img4] = await Promise.all([
        sharp(imageBuffers[0])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[1])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[2])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[3])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer()
      ]);

      composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).composite([
        { input: img1, left: 0, top: 0 },
        { input: img2, left: halfWidth, top: 0 },
        { input: img3, left: 0, top: halfHeight },
        { input: img4, left: halfWidth, top: halfHeight }
      ]);
    }

    // Generate final image
    const outputBuffer = await composite.jpeg({ quality: 85 }).toBuffer();

    // Set headers to serve the image directly
    res.set({
      "Content-Type": "image/jpeg",
      "Content-Length": outputBuffer.length,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Content-Disposition": `inline; filename="homepage-share.jpg"`
    });

    // Send the image buffer directly
    res.send(outputBuffer);
  } catch (error) {
    console.error("Error generating homepage share image:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Tag page share image endpoint
app.get("/tag/:tagName/share-image", async (req, res) => {
  try {
    const { tagName } = req.params;

    // Get projects from cache
    if (!projectsCache) {
      return res.status(400).json({ error: "No projects data available" });
    }

    // Filter projects by tag and extract primary images
    const tagProjects = filterProjectsByTag(projectsCache, tagName);
    const sortedProjects = sortProjectsByDate(tagProjects);
    const images = [];

    for (const project of sortedProjects) {
      if (project.primaryImage?.url && images.length < 4) {
        images.push(project.primaryImage.url);
      }
    }

    if (images.length === 0) {
      return res.status(400).json({
        error: `No primary images found in projects with tag "${tagName}"`
      });
    }

    // Download and process images
    const imageBuffers = [];
    const baseUrl = "https://static.fcc.lol/portfolio-storage";

    for (const imageUrl of images) {
      try {
        if (imageUrl.startsWith(baseUrl)) {
          const response = await fetch(imageUrl);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            imageBuffers.push(imageBuffer);
          }
        }
      } catch (error) {
        console.error(`[DEBUG] Error processing image ${imageUrl}:`, error);
      }
    }

    if (imageBuffers.length === 0) {
      return res.status(400).json({ error: "No valid images found" });
    }

    // Create composite image based on number of images (same logic as homepage)
    let composite;
    const canvasWidth = 1200;
    const canvasHeight = 630;

    if (imageBuffers.length === 1) {
      composite = sharp(imageBuffers[0]).resize(canvasWidth, canvasHeight, {
        fit: "cover",
        position: "center",
        withoutEnlargement: false
      });
    } else if (imageBuffers.length === 2) {
      const halfWidth = canvasWidth / 2;
      const [img1, img2] = await Promise.all([
        sharp(imageBuffers[0])
          .resize(halfWidth, canvasHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[1])
          .resize(halfWidth, canvasHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer()
      ]);

      composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).composite([
        { input: img1, left: 0, top: 0 },
        { input: img2, left: halfWidth, top: 0 }
      ]);
    } else if (imageBuffers.length === 3) {
      const halfWidth = canvasWidth / 2;
      const halfHeight = canvasHeight / 2;

      const [img1, img2, img3] = await Promise.all([
        sharp(imageBuffers[0])
          .resize(halfWidth, canvasHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[1])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[2])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer()
      ]);

      composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).composite([
        { input: img1, left: 0, top: 0 },
        { input: img2, left: halfWidth, top: 0 },
        { input: img3, left: halfWidth, top: halfHeight }
      ]);
    } else {
      const halfWidth = canvasWidth / 2;
      const halfHeight = canvasHeight / 2;

      const [img1, img2, img3, img4] = await Promise.all([
        sharp(imageBuffers[0])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[1])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[2])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[3])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer()
      ]);

      composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).composite([
        { input: img1, left: 0, top: 0 },
        { input: img2, left: halfWidth, top: 0 },
        { input: img3, left: 0, top: halfHeight },
        { input: img4, left: halfWidth, top: halfHeight }
      ]);
    }

    // Generate final image
    const outputBuffer = await composite.jpeg({ quality: 85 }).toBuffer();

    // Set headers to serve the image directly
    res.set({
      "Content-Type": "image/jpeg",
      "Content-Length": outputBuffer.length,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Content-Disposition": `inline; filename="${tagName}-share.jpg"`
    });

    // Send the image buffer directly
    res.send(outputBuffer);
  } catch (error) {
    console.error("Error generating tag share image:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Person page share image endpoint
app.get("/person/:personName/share-image", async (req, res) => {
  try {
    const { personName } = req.params;

    // Get projects from cache
    if (!projectsCache) {
      return res.status(400).json({ error: "No projects data available" });
    }

    // Filter projects by person and extract primary images
    const personProjects = filterProjectsByPerson(projectsCache, personName);
    const sortedProjects = sortProjectsByDate(personProjects);
    const images = [];

    for (const project of sortedProjects) {
      if (project.primaryImage?.url && images.length < 4) {
        images.push(project.primaryImage.url);
      }
    }

    if (images.length === 0) {
      return res.status(400).json({
        error: `No primary images found in projects by "${personName}"`
      });
    }

    // Download and process images
    const imageBuffers = [];
    const baseUrl = "https://static.fcc.lol/portfolio-storage";

    for (const imageUrl of images) {
      try {
        if (imageUrl.startsWith(baseUrl)) {
          const response = await fetch(imageUrl);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            imageBuffers.push(imageBuffer);
          }
        }
      } catch (error) {
        console.error(`[DEBUG] Error processing image ${imageUrl}:`, error);
      }
    }

    if (imageBuffers.length === 0) {
      return res.status(400).json({ error: "No valid images found" });
    }

    // Create composite image based on number of images (same logic as homepage)
    let composite;
    const canvasWidth = 1200;
    const canvasHeight = 630;

    if (imageBuffers.length === 1) {
      composite = sharp(imageBuffers[0]).resize(canvasWidth, canvasHeight, {
        fit: "cover",
        position: "center",
        withoutEnlargement: false
      });
    } else if (imageBuffers.length === 2) {
      const halfWidth = canvasWidth / 2;
      const [img1, img2] = await Promise.all([
        sharp(imageBuffers[0])
          .resize(halfWidth, canvasHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[1])
          .resize(halfWidth, canvasHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer()
      ]);

      composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).composite([
        { input: img1, left: 0, top: 0 },
        { input: img2, left: halfWidth, top: 0 }
      ]);
    } else if (imageBuffers.length === 3) {
      const halfWidth = canvasWidth / 2;
      const halfHeight = canvasHeight / 2;

      const [img1, img2, img3] = await Promise.all([
        sharp(imageBuffers[0])
          .resize(halfWidth, canvasHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[1])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[2])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer()
      ]);

      composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).composite([
        { input: img1, left: 0, top: 0 },
        { input: img2, left: halfWidth, top: 0 },
        { input: img3, left: halfWidth, top: halfHeight }
      ]);
    } else {
      const halfWidth = canvasWidth / 2;
      const halfHeight = canvasHeight / 2;

      const [img1, img2, img3, img4] = await Promise.all([
        sharp(imageBuffers[0])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[1])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[2])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer(),
        sharp(imageBuffers[3])
          .resize(halfWidth, halfHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer()
      ]);

      composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).composite([
        { input: img1, left: 0, top: 0 },
        { input: img2, left: halfWidth, top: 0 },
        { input: img3, left: 0, top: halfHeight },
        { input: img4, left: halfWidth, top: halfHeight }
      ]);
    }

    // Generate final image
    const outputBuffer = await composite.jpeg({ quality: 85 }).toBuffer();

    // Set headers to serve the image directly
    res.set({
      "Content-Type": "image/jpeg",
      "Content-Length": outputBuffer.length,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Content-Disposition": `inline; filename="${personName}-share.jpg"`
    });

    // Send the image buffer directly
    res.send(outputBuffer);
  } catch (error) {
    console.error("Error generating person share image:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Load cache from file on startup
loadCacheFromFile();

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
