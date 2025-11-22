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
    "https://www.fcc.lol",
    "https://rolodex-os.fcc.lol",
    "https://www.rolodex-os.fcc.lol"
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

// Cache configuration
const CACHE_FILE = "projects-cache.json"; // Internal cache with metadata
const PROJECTS_SORTED_FILE = "projects-sorted.json"; // Sorted projects for serving
const PROJECTS_DIR = "projects"; // Individual project JSON files
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_PROJECTS_CACHE_SIZE = 50 * 1024 * 1024; // 50MB limit for projects cache
const MAX_IMAGE_BUFFERS_IN_MEMORY = 3; // Max concurrent image buffers for processing

// Single in-memory cache (one copy only, not per-request)
let projectsCache = null;
let lastCacheUpdate = null;
let isUpdatingCache = false;

// File-based cache directory for share images (no in-memory caching)
const SHARE_IMAGE_CACHE_DIR = "share-images";

// Memory monitoring functions
function getMemoryUsage() {
  const memUsage = process.memoryUsage();
  return {
    rss: Math.round(memUsage.rss / 1024 / 1024), // MB
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
    external: Math.round(memUsage.external / 1024 / 1024), // MB
    arrayBuffers: Math.round(memUsage.arrayBuffers / 1024 / 1024) // MB
  };
}

function logMemoryUsage(context) {
  const memory = getMemoryUsage();
  console.log(
    `[MEMORY] ${context}: RSS=${memory.rss}MB, Heap=${memory.heapUsed}/${memory.heapTotal}MB, External=${memory.external}MB, ArrayBuffers=${memory.arrayBuffers}MB`
  );
}

function checkMemoryPressure() {
  const memory = getMemoryUsage();
  const memoryPressure = memory.heapUsed / memory.heapTotal;

  if (memoryPressure > 0.85) {
    console.warn(
      `[MEMORY] High memory pressure detected: ${Math.round(
        memoryPressure * 100
      )}%`
    );

    // Clear file-based caches if memory pressure is critical
    if (memoryPressure > 0.9) {
      console.warn("[MEMORY] Critical memory pressure, clearing file caches");
      clearShareImageCache();

      if (global.gc) {
        global.gc();
        logMemoryUsage("After emergency cleanup");
      }
    }

    return true;
  }
  return false;
}

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

// Shared constants
const SITE_DESCRIPTION =
  "FCC Studio is a technology and art collective that makes fun software and hardware.";
const BASE_URL = "https://fcc.lol";
const API_URL = "https://portfolio-api.fcc.lol";

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

// Helper function to generate HTML with Open Graph tags
function generateHtml(
  title,
  description,
  shareImageUrl,
  pageUrl,
  redirectPath
) {
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
    <meta property="og:url" content="${pageUrl}" />
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
        window.location.href = '${BASE_URL}${redirectPath}';
      }, 1000);
    </script>
  </head>
  <body>
    <div style="text-align: center; padding: 2rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <p style="color: #666;">Loading...</p>
      <p style="color: #999; font-size: 0.9rem;">
        If you're not redirected, <a href="${redirectPath}">click here</a>
      </p>
    </div>
  </body>
</html>`;
}

// Helper function to generate HTML with Open Graph tags for projects
function generatePageHtml(project, projectId) {
  const title = project.title || project.name || "Untitled Project";
  const description = project.description || SITE_DESCRIPTION;
  const shareImageUrl = project.primaryImage?.url;
  const projectUrl = `${BASE_URL}/${projectId}`;

  return generateHtml(
    title,
    description,
    shareImageUrl,
    projectUrl,
    `/project/${projectId}`
  );
}

// Helper function to generate HTML for homepage
function generateHomepageHtml() {
  const title = "FCC Studio";
  const shareImageUrl = `${API_URL}/homepage/share-image`;

  return generateHtml(title, SITE_DESCRIPTION, shareImageUrl, BASE_URL, "/");
}

// Helper function to generate HTML for tag pages
function generateTagPageHtml(tagName, projectCount) {
  const title = `FCC Studio – Projects with #${tagName}`;
  const shareImageUrl = `${API_URL}/tag/${encodeURIComponent(
    tagName
  )}/share-image`;
  const tagUrl = `${BASE_URL}/tag/${tagName}`;

  return generateHtml(
    title,
    SITE_DESCRIPTION,
    shareImageUrl,
    tagUrl,
    `/tag/${tagName}`
  );
}

// Helper function to generate HTML for person pages
function generatePersonPageHtml(personName, projectCount) {
  // Capitalize the first letter of the person name
  const capitalizedPersonName =
    personName.charAt(0).toUpperCase() + personName.slice(1);
  const title = `FCC Studio – Projects with ${capitalizedPersonName}`;
  const shareImageUrl = `${API_URL}/person/${encodeURIComponent(
    personName
  )}/share-image`;
  const personUrl = `${BASE_URL}/person/${personName}`;

  return generateHtml(
    title,
    SITE_DESCRIPTION,
    shareImageUrl,
    personUrl,
    `/person/${personName}`
  );
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
                  ".webm",
                  ".md"
                ].includes(ext)
              ) {
                mediaFiles.push(filename);

                // Separate images from videos and Markdown files
                if ([".jpg", ".jpeg", ".png", ".gif"].includes(ext)) {
                  imageFiles.push(filename);
                } else if ([".mp4", ".mov", ".avi", ".webm"].includes(ext)) {
                  videoFiles.push(filename);
                }
                // Markdown files will be handled separately in the processing loop
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
              } else if ([".mp4", ".mov", ".avi", ".webm"].includes(ext)) {
                // This is a video - get dimensions
                const dimensions = await getVideoDimensions(url);
                allMedia.push({
                  url,
                  type: "video",
                  filename,
                  dimensions
                });
              } else if (ext === ".md") {
                // This is a Markdown file - fetch content and add as notes type
                try {
                  const mdResponse = await fetch(url);
                  let content = "";
                  if (mdResponse.ok) {
                    content = await mdResponse.text();
                  }
                  allMedia.push({
                    url,
                    type: "notes",
                    filename,
                    content
                  });
                } catch (error) {
                  console.warn(
                    `Could not fetch markdown content for ${filename}:`,
                    error.message
                  );
                  // Still add the file but without content
                  allMedia.push({
                    url,
                    type: "notes",
                    filename,
                    content: ""
                  });
                }
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
function saveCacheToFile(projects) {
  try {
    // Save full cache with metadata
    const cacheData = {
      projects: projects,
      lastUpdate: Date.now(),
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));

    // Save sorted projects array for direct serving (no metadata wrapper)
    const sortedProjects = sortProjectsByDate(projects);
    fs.writeFileSync(
      PROJECTS_SORTED_FILE,
      JSON.stringify(sortedProjects, null, 2)
    );

    // Ensure projects directory exists
    if (!fs.existsSync(PROJECTS_DIR)) {
      fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    }

    // Save each project as an individual file
    projects.forEach((project) => {
      const projectFile = path.join(PROJECTS_DIR, `${project.id}.json`);
      fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
    });

    console.log(
      `Projects cache saved: ${projects.length} projects (+ individual files)`
    );
  } catch (error) {
    console.error("Error saving cache to file:", error);
  }
}

// Function to load projects from file cache (loads into in-memory cache)
function loadProjectsFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      projectsCache = cacheData.projects || [];
      lastCacheUpdate = cacheData.lastUpdate;
      console.log(`Loaded ${projectsCache.length} projects into memory cache`);
      return true;
    }
  } catch (error) {
    console.error("Error loading projects from file:", error);
  }
  return false;
}

// Function to load cache metadata on startup
function loadCacheMetadata() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      lastCacheUpdate = cacheData.lastUpdate;
      console.log(
        `Cache metadata loaded. Last update: ${new Date(
          lastCacheUpdate
        ).toISOString()}`
      );
      return true;
    }
  } catch (error) {
    console.error("Error loading cache metadata:", error);
  }
  return false;
}

// Get projects (from memory cache or load if needed)
function getProjects() {
  if (!projectsCache) {
    loadProjectsFromFile();
  }
  return projectsCache;
}

// Function to get projects from file (without loading into memory cache)
function getProjectsFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      return cacheData.projects || [];
    }
  } catch (error) {
    console.error("Error reading projects from file:", error);
  }
  return null;
}

// Function to ensure share image cache directory exists
function ensureShareImageCacheDir() {
  try {
    if (!fs.existsSync(SHARE_IMAGE_CACHE_DIR)) {
      fs.mkdirSync(SHARE_IMAGE_CACHE_DIR, { recursive: true });
    }
  } catch (error) {
    console.error("Error creating share image cache directory:", error);
  }
}

// Function to get share image cache file path
function getShareImageCachePath(type, identifier = null) {
  ensureShareImageCacheDir();
  if (type === "homepage") {
    return path.join(SHARE_IMAGE_CACHE_DIR, "homepage.jpg");
  } else if (type === "tag") {
    return path.join(SHARE_IMAGE_CACHE_DIR, `tag-${identifier}.jpg`);
  } else if (type === "person") {
    return path.join(SHARE_IMAGE_CACHE_DIR, `person-${identifier}.jpg`);
  } else if (type === "space") {
    return path.join(SHARE_IMAGE_CACHE_DIR, "space.jpg");
  }
  return null;
}

// Function to check if share image cache is valid
function isShareImageCacheValid(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) {
      return false;
    }

    // Check if the cache file is newer than the last projects cache update
    const cacheStats = fs.statSync(cachePath);
    const cacheTime = cacheStats.mtime.getTime();

    return lastCacheUpdate && cacheTime > lastCacheUpdate;
  } catch (error) {
    console.error("Error checking share image cache validity:", error);
    return false;
  }
}

// Function to clear all share image cache (file-based only)
function clearShareImageCache() {
  try {
    if (fs.existsSync(SHARE_IMAGE_CACHE_DIR)) {
      const files = fs.readdirSync(SHARE_IMAGE_CACHE_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(SHARE_IMAGE_CACHE_DIR, file));
      }
      console.log(`Share image cache cleared: ${files.length} files deleted`);
    }
  } catch (error) {
    console.error("Error clearing share image cache:", error);
  }
}

// Function to get the first studio photo
async function getFirstStudioPhoto() {
  try {
    const studioPhotosUrl = "https://static.fcc.lol/studio-photos/";
    const response = await fetch(studioPhotosUrl);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch studio photos directory: ${response.status}`
      );
    }

    const html = await response.text();

    // Parse the HTML to extract image files
    const imageRegex = /<a href="([^"]+\.(jpg|jpeg|png|gif))">/gi;
    const images = [];
    let match;

    while ((match = imageRegex.exec(html)) !== null) {
      const filename = match[1];
      // Skip parent directory links
      if (filename !== "../" && filename !== "./") {
        images.push(filename);
      }
    }

    // Sort images and return the first one
    if (images.length > 0) {
      const sortedImages = images.sort();
      const firstImage = sortedImages[0];
      return `${studioPhotosUrl}${firstImage}`;
    }

    return null;
  } catch (error) {
    console.error("Error fetching studio photos:", error);
    return null;
  }
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
    projectsCache = newProjects; // Update in-memory copy
    lastCacheUpdate = Date.now();

    // Save to files (creates both projects-cache.json and projects.json)
    saveCacheToFile(newProjects);

    // Clear share image cache since projects data has changed
    clearShareImageCache();

    console.log("Cache updated successfully");
  } catch (error) {
    console.error("Error updating cache:", error);
  } finally {
    isUpdatingCache = false;
  }
}

app.get("/projects", async (req, res) => {
  try {
    // Serve the static sorted JSON file directly - zero memory!
    if (fs.existsSync(PROJECTS_SORTED_FILE)) {
      res.sendFile(path.resolve(PROJECTS_SORTED_FILE));

      // Update cache in background if stale
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const freshProjects = await fetchProjectsFromRemote();
      lastCacheUpdate = Date.now();
      saveCacheToFile(freshProjects); // This creates projects-sorted.json
      res.sendFile(path.resolve(PROJECTS_SORTED_FILE));
    }
  } catch (error) {
    console.error("Error serving projects:", error);
    res.status(500).json({ error: "Failed to serve projects" });
  }
});

// Homepage prerender route for social media crawlers
app.get("/homepage/prerender", async (req, res) => {
  try {
    // Generate HTML with proper meta tags for homepage
    const html = generateHomepageHtml();

    // Set content type and send HTML
    res.set("Content-Type", "text/html");
    res.send(html);

    // Update cache in background if needed
    updateCacheInBackground();
  } catch (error) {
    console.error("Error prerendering homepage:", error);
    res.status(500).send("Internal server error");
  }
});

app.get("/projects/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const projectFile = path.join(PROJECTS_DIR, `${projectId}.json`);

    // Serve the individual project file directly - zero memory!
    if (fs.existsSync(projectFile)) {
      res.sendFile(path.resolve(projectFile));

      // Update cache in background if stale
      updateCacheInBackground();
    } else {
      // Project file doesn't exist - maybe cache is stale or invalid ID
      const projects = getProjects();
      if (projects) {
        const project = projects.find((p) => p.id === projectId);
        if (project) {
          res.json(project);
        } else {
          res.status(404).json({ error: "Project not found" });
        }
      } else {
        // No cache - fetch fresh
        const freshProjects = await fetchProjectsFromRemote();
        projectsCache = freshProjects;
        lastCacheUpdate = Date.now();
        saveCacheToFile(freshProjects);

        const project = freshProjects.find((p) => p.id === projectId);
        if (project) {
          res.json(project);
        } else {
          res.status(404).json({ error: "Project not found" });
        }
      }
    }
  } catch (error) {
    console.error(`Error reading project ${req.params.projectId}:`, error);
    res.status(500).json({ error: "Failed to read project" });
  }
});

// Get projects by person/author
app.get("/projects/person/:personName", async (req, res) => {
  try {
    const { personName } = req.params;

    // Get from in-memory cache
    const projects = getProjects();

    if (projects) {
      const personProjects = filterProjectsByPerson(projects, personName);
      res.json(sortProjectsByDate(personProjects));

      // Update cache in background if stale
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const freshProjects = await fetchProjectsFromRemote();
      projectsCache = freshProjects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(freshProjects);

      const personProjects = filterProjectsByPerson(freshProjects, personName);
      res.json(sortProjectsByDate(personProjects));
    }
  } catch (error) {
    console.error(
      `Error reading projects for person ${req.params.personName}:`,
      error
    );

    // Try fallback to file
    const fallbackProjects = getProjectsFromFile();
    if (fallbackProjects) {
      const personProjects = filterProjectsByPerson(
        fallbackProjects,
        req.params.personName
      );
      res.json(sortProjectsByDate(personProjects));
    } else {
      res.status(500).json({ error: "Failed to read projects" });
    }
  }
});

// Get all unique tags from projects
app.get("/tags", async (req, res) => {
  try {
    // Get from in-memory cache
    const projects = getProjects();

    if (projects) {
      const tags = getAllTags(projects);
      res.json(tags);

      // Update cache in background if stale
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const freshProjects = await fetchProjectsFromRemote();
      projectsCache = freshProjects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(freshProjects);

      const tags = getAllTags(freshProjects);
      res.json(tags);
    }
  } catch (error) {
    console.error("Error reading tags:", error);

    // Try fallback to file
    const fallbackProjects = getProjectsFromFile();
    if (fallbackProjects) {
      const tags = getAllTags(fallbackProjects);
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

    // Get from in-memory cache
    const projects = getProjects();

    if (projects) {
      const tagProjects = filterProjectsByTag(projects, tagName);
      res.json(sortProjectsByDate(tagProjects));

      // Update cache in background if stale
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      const freshProjects = await fetchProjectsFromRemote();
      projectsCache = freshProjects;
      lastCacheUpdate = Date.now();
      saveCacheToFile(freshProjects);

      const tagProjects = filterProjectsByTag(freshProjects, tagName);
      res.json(sortProjectsByDate(tagProjects));
    }
  } catch (error) {
    console.error(
      `Error reading projects for tag ${req.params.tagName}:`,
      error
    );

    // Try fallback to file
    const fallbackProjects = getProjectsFromFile();
    if (fallbackProjects) {
      const tagProjects = filterProjectsByTag(
        fallbackProjects,
        req.params.tagName
      );
      res.json(sortProjectsByDate(tagProjects));
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
    lastCacheUpdate = Date.now();
    saveCacheToFile(newProjects);

    // Clear share image cache since projects data has changed
    clearShareImageCache();

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
  const projects = getProjectsFromFile();

  res.json({
    hasCachedData: !!projects,
    projectCount: projects ? projects.length : 0,
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

// Prerender route for social media crawlers
app.get("/projects/prerender/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get from in-memory cache
    const projects = getProjects();

    if (projects) {
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

      // Update cache in background if stale
      updateCacheInBackground();
    } else {
      // No cache available - fetch fresh data
      projects = await fetchProjectsFromRemote();
      lastCacheUpdate = Date.now();
      saveCacheToFile(projects);

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

// Tag page prerender route for social media crawlers
app.get("/projects/prerender/tag/:tagName", async (req, res) => {
  try {
    const { tagName } = req.params;

    // Get from in-memory cache
    const projects = getProjects();

    if (!projects) {
      // If no cache, generate basic HTML without project count
      const html = generateTagPageHtml(tagName, 0);
      res.set("Content-Type", "text/html");
      res.send(html);
      return;
    }

    // Filter projects by tag to get count
    const tagProjects = filterProjectsByTag(projects, tagName);
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

    // Get from in-memory cache
    const projects = getProjects();

    if (!projects) {
      // If no cache, generate basic HTML without project count
      const html = generatePersonPageHtml(personName, 0);
      res.set("Content-Type", "text/html");
      res.send(html);
      return;
    }

    // Filter projects by person to get count
    const personProjects = filterProjectsByPerson(projects, personName);
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

// Space page prerender route for social media crawlers
app.get("/space/prerender", async (req, res) => {
  try {
    const title = "FCC Studio – Space";
    const description = "Visit our creative space and studio.";
    const shareImageUrl = `${API_URL}/space/share-image`;
    const spaceUrl = `${BASE_URL}/space`;

    const html = generateHtml(
      title,
      description,
      shareImageUrl,
      spaceUrl,
      "/space"
    );

    // Set content type and send HTML
    res.set("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("Error prerendering space page:", error);
    res.status(500).send("Internal server error");
  }
});

// About page prerender route for social media crawlers
app.get("/about/prerender", async (req, res) => {
  try {
    const title = "FCC Studio – About";
    const description = SITE_DESCRIPTION;
    const shareImageUrl = `${API_URL}/homepage/share-image`;
    const aboutUrl = `${BASE_URL}/about`;

    const html = generateHtml(
      title,
      description,
      shareImageUrl,
      aboutUrl,
      "/about"
    );

    // Set content type and send HTML
    res.set("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("Error prerendering about page:", error);
    res.status(500).send("Internal server error");
  }
});

// Individual project share image endpoint
app.get("/projects/:projectId/share-image", async (req, res) => {
  try {
    const { projectId } = req.params;

    // Load from file and find the specific project
    const projects = getProjectsFromFile();
    if (!projects) {
      return res.status(400).json({ error: "No projects data available" });
    }

    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Use the project's primary image
    if (!project.primaryImage?.url) {
      return res
        .status(400)
        .json({ error: "No primary image found for this project" });
    }

    // Download and process the image with memory management
    const baseUrl = "https://static.fcc.lol/portfolio-storage";
    let imageBuffer = null;
    let outputBuffer = null;

    try {
      if (project.primaryImage.url.startsWith(baseUrl)) {
        checkMemoryPressure(); // Check memory before download

        const response = await fetch(project.primaryImage.url);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          imageBuffer = Buffer.from(arrayBuffer);
        }
      }
    } catch (error) {
      console.error(
        `Error processing image ${project.primaryImage.url}:`,
        error
      );
      return res.status(500).json({ error: "Failed to process image" });
    } finally {
      // Cleanup in finally block
      if (imageBuffer && !outputBuffer) {
        imageBuffer = null;
      }
    }

    if (!imageBuffer) {
      return res.status(400).json({ error: "No valid image found" });
    }

    try {
      // Resize image to standard share image dimensions
      const canvasWidth = 1200;
      const canvasHeight = 630;

      outputBuffer = await sharp(imageBuffer)
        .resize(canvasWidth, canvasHeight, {
          fit: "cover",
          position: "center",
          withoutEnlargement: false
        })
        .jpeg({ quality: 85 })
        .toBuffer();

      // Clean up original buffer immediately after processing
      imageBuffer = null;
    } catch (error) {
      console.error(`Error resizing image:`, error);
      return res.status(500).json({ error: "Failed to resize image" });
    } finally {
      imageBuffer = null;
      if (global.gc) global.gc();
    }

    // Set headers to serve the image directly
    res.set({
      "Content-Type": "image/jpeg",
      "Content-Length": outputBuffer.length,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Content-Disposition": `inline; filename="${projectId}-share.jpg"`
    });

    // Send the image buffer directly
    res.send(outputBuffer);
  } catch (error) {
    console.error("Error generating project share image:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Homepage share image endpoint
app.get("/homepage/share-image", async (req, res) => {
  try {
    // Check if we have a valid cached version
    const cachePath = getShareImageCachePath("homepage");
    if (isShareImageCacheValid(cachePath)) {
      console.log("Serving cached homepage share image from file");
      res.set({
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        "Content-Disposition": `inline; filename="homepage-share.jpg"`
      });
      // Stream file directly from disk - no memory buffering
      const fileStream = fs.createReadStream(cachePath);
      fileStream.pipe(res);
      return;
    }

    // Load from file
    const projects = getProjectsFromFile();
    if (!projects) {
      return res.status(400).json({ error: "No projects data available" });
    }

    console.log("Generating new homepage share image");

    // Get sorted projects and extract primary images (up to 6 for 3x2 grid)
    const sortedProjects = sortProjectsByDate(projects);
    const images = [];

    for (const project of sortedProjects) {
      if (project.primaryImage?.url && images.length < 6) {
        images.push(project.primaryImage.url);
      }
    }

    if (images.length === 0) {
      return res
        .status(400)
        .json({ error: "No primary images found in projects" });
    }

    // Process images in batches to limit memory usage
    const baseUrl = "https://static.fcc.lol/portfolio-storage";
    const canvasWidth = 1200;
    const canvasHeight = 630;
    const cellWidth = canvasWidth / 3;
    const cellHeight = canvasHeight / 2;

    // Helper function to process a single image with memory cleanup
    async function processImage(imageUrl, index) {
      let imageBuffer = null;
      try {
        if (!imageUrl.startsWith(baseUrl)) return null;

        const response = await fetch(imageUrl);
        if (!response.ok) return null;

        const arrayBuffer = await response.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);

        // Process image immediately and return processed buffer
        const processedBuffer = await sharp(imageBuffer)
          .resize(cellWidth, cellHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer();

        // Clean up original buffer immediately
        imageBuffer = null;

        return processedBuffer;
      } catch (error) {
        console.error(`Error processing image ${imageUrl}:`, error);
        return null;
      } finally {
        // Explicit cleanup
        imageBuffer = null;
        if (global.gc) global.gc();
      }
    }

    // Process images in batches of MAX_IMAGE_BUFFERS_IN_MEMORY
    const processedImages = [];
    for (
      let i = 0;
      i < Math.min(images.length, 6);
      i += MAX_IMAGE_BUFFERS_IN_MEMORY
    ) {
      const batch = images.slice(i, i + MAX_IMAGE_BUFFERS_IN_MEMORY);
      const batchResults = await Promise.all(
        batch.map((imageUrl) => processImage(imageUrl, i))
      );

      // Add non-null results
      processedImages.push(...batchResults.filter((img) => img !== null));

      // Clean up batch results from memory
      for (let result of batchResults) {
        result = null;
      }
    }

    if (processedImages.length === 0) {
      return res.status(400).json({ error: "No valid images found" });
    }

    // Create composite with 3x2 grid layout
    const compositeInputs = [];

    // Fill the grid row by row
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const imageIndex = row * 3 + col;
        if (imageIndex < processedImages.length) {
          compositeInputs.push({
            input: processedImages[imageIndex],
            left: col * cellWidth,
            top: row * cellHeight
          });
        }
      }
    }

    let composite = sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    }).composite(compositeInputs);

    // Generate final image and save directly to file
    await composite.jpeg({ quality: 85 }).toFile(cachePath);
    console.log(`Homepage share image generated and saved to: ${cachePath}`);

    // Clean up processed images from memory immediately
    processedImages.forEach((img, index) => {
      processedImages[index] = null;
    });
    processedImages.length = 0;
    composite = null;

    // Trigger garbage collection
    if (global.gc) global.gc();

    // Stream the file from disk - no need to keep in memory
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      "Content-Disposition": `inline; filename="homepage-share.jpg"`
    });

    const fileStream = fs.createReadStream(cachePath);
    fileStream.on("error", (err) => {
      console.error("Error streaming generated file:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream generated image" });
      }
    });
    fileStream.pipe(res);
  } catch (error) {
    console.error("Error generating homepage share image:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Tag page share image endpoint
app.get("/tag/:tagName/share-image", async (req, res) => {
  try {
    const { tagName } = req.params;

    // Check if we have a valid cached version
    const cachePath = getShareImageCachePath("tag", tagName);
    if (isShareImageCacheValid(cachePath)) {
      console.log(`Serving cached tag share image for: ${tagName}`);
      res.set({
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        "Content-Disposition": `inline; filename="${tagName}-share.jpg"`
      });
      // Stream file directly from disk - no memory buffering
      const fileStream = fs.createReadStream(cachePath);
      fileStream.on("error", (err) => {
        console.error("Error streaming cached file:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream cached image" });
        }
      });
      fileStream.pipe(res);
      return;
    }

    // Load from file
    const projects = getProjectsFromFile();
    if (!projects) {
      return res.status(400).json({ error: "No projects data available" });
    }

    console.log(`Generating new tag share image for: ${tagName}`);

    // Filter projects by tag and extract primary images
    const tagProjects = filterProjectsByTag(projects, tagName);
    const sortedProjects = sortProjectsByDate(tagProjects);
    const images = [];

    for (const project of sortedProjects) {
      if (project.primaryImage?.url && images.length < 6) {
        images.push(project.primaryImage.url);
      }
    }

    if (images.length === 0) {
      return res.status(400).json({
        error: `No primary images found in projects with tag "${tagName}"`
      });
    }

    // Process images in batches to limit memory usage
    const baseUrl = "https://static.fcc.lol/portfolio-storage";
    const canvasWidth = 1200;
    const canvasHeight = 630;
    const cellWidth = canvasWidth / 3;
    const cellHeight = canvasHeight / 2;

    // Helper function to process a single image with memory cleanup
    async function processImage(imageUrl, index) {
      let imageBuffer = null;
      try {
        if (!imageUrl.startsWith(baseUrl)) return null;

        const response = await fetch(imageUrl);
        if (!response.ok) return null;

        const arrayBuffer = await response.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);

        // Process image immediately and return processed buffer
        const processedBuffer = await sharp(imageBuffer)
          .resize(cellWidth, cellHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer();

        // Clean up original buffer immediately
        imageBuffer = null;

        return processedBuffer;
      } catch (error) {
        console.error(`Error processing image ${imageUrl}:`, error);
        return null;
      } finally {
        // Explicit cleanup
        imageBuffer = null;
        if (global.gc) global.gc();
      }
    }

    // Process images in batches of MAX_IMAGE_BUFFERS_IN_MEMORY
    const processedImages = [];
    for (
      let i = 0;
      i < Math.min(images.length, 6);
      i += MAX_IMAGE_BUFFERS_IN_MEMORY
    ) {
      const batch = images.slice(i, i + MAX_IMAGE_BUFFERS_IN_MEMORY);
      const batchResults = await Promise.all(
        batch.map((imageUrl) => processImage(imageUrl, i))
      );

      // Add non-null results
      processedImages.push(...batchResults.filter((img) => img !== null));

      // Clean up batch results from memory
      for (let result of batchResults) {
        result = null;
      }
    }

    if (processedImages.length === 0) {
      return res.status(400).json({ error: "No valid images found" });
    }

    // Create composite with 3x2 grid layout
    const compositeInputs = [];

    // Fill the grid row by row
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const imageIndex = row * 3 + col;
        if (imageIndex < processedImages.length) {
          compositeInputs.push({
            input: processedImages[imageIndex],
            left: col * cellWidth,
            top: row * cellHeight
          });
        }
      }
    }

    let composite = sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    }).composite(compositeInputs);

    // Generate final image and save directly to file
    await composite.jpeg({ quality: 85 }).toFile(cachePath);
    console.log(`Tag share image generated and saved to: ${cachePath}`);

    // Clean up processed images from memory immediately
    processedImages.forEach((img, index) => {
      processedImages[index] = null;
    });
    processedImages.length = 0;
    composite = null;

    // Trigger garbage collection
    if (global.gc) global.gc();

    // Stream the file from disk - no need to keep in memory
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      "Content-Disposition": `inline; filename="${tagName}-share.jpg"`
    });

    const fileStream = fs.createReadStream(cachePath);
    fileStream.on("error", (err) => {
      console.error("Error streaming generated file:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream generated image" });
      }
    });
    fileStream.pipe(res);
  } catch (error) {
    console.error("Error generating tag share image:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Person page share image endpoint
app.get("/person/:personName/share-image", async (req, res) => {
  try {
    const { personName } = req.params;

    // Check if we have a valid cached version
    const cachePath = getShareImageCachePath("person", personName);
    if (isShareImageCacheValid(cachePath)) {
      console.log(`Serving cached person share image for: ${personName}`);
      res.set({
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        "Content-Disposition": `inline; filename="${personName}-share.jpg"`
      });
      // Stream file directly from disk - no memory buffering
      const fileStream = fs.createReadStream(cachePath);
      fileStream.on("error", (err) => {
        console.error("Error streaming cached file:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream cached image" });
        }
      });
      fileStream.pipe(res);
      return;
    }

    // Load from file
    const projects = getProjectsFromFile();
    if (!projects) {
      return res.status(400).json({ error: "No projects data available" });
    }

    console.log(`Generating new person share image for: ${personName}`);

    // Filter projects by person and extract primary images
    const personProjects = filterProjectsByPerson(projects, personName);
    const sortedProjects = sortProjectsByDate(personProjects);
    const images = [];

    for (const project of sortedProjects) {
      if (project.primaryImage?.url && images.length < 6) {
        images.push(project.primaryImage.url);
      }
    }

    if (images.length === 0) {
      return res.status(400).json({
        error: `No primary images found in projects by "${personName}"`
      });
    }

    // Process images in batches to limit memory usage
    const baseUrl = "https://static.fcc.lol/portfolio-storage";
    const canvasWidth = 1200;
    const canvasHeight = 630;
    const cellWidth = canvasWidth / 3;
    const cellHeight = canvasHeight / 2;

    // Helper function to process a single image with memory cleanup
    async function processImage(imageUrl, index) {
      let imageBuffer = null;
      try {
        if (!imageUrl.startsWith(baseUrl)) return null;

        const response = await fetch(imageUrl);
        if (!response.ok) return null;

        const arrayBuffer = await response.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);

        // Process image immediately and return processed buffer
        const processedBuffer = await sharp(imageBuffer)
          .resize(cellWidth, cellHeight, {
            fit: "cover",
            position: "center",
            withoutEnlargement: false
          })
          .toBuffer();

        // Clean up original buffer immediately
        imageBuffer = null;

        return processedBuffer;
      } catch (error) {
        console.error(`Error processing image ${imageUrl}:`, error);
        return null;
      } finally {
        // Explicit cleanup
        imageBuffer = null;
        if (global.gc) global.gc();
      }
    }

    // Process images in batches of MAX_IMAGE_BUFFERS_IN_MEMORY
    const processedImages = [];
    for (
      let i = 0;
      i < Math.min(images.length, 6);
      i += MAX_IMAGE_BUFFERS_IN_MEMORY
    ) {
      const batch = images.slice(i, i + MAX_IMAGE_BUFFERS_IN_MEMORY);
      const batchResults = await Promise.all(
        batch.map((imageUrl) => processImage(imageUrl, i))
      );

      // Add non-null results
      processedImages.push(...batchResults.filter((img) => img !== null));

      // Clean up batch results from memory
      for (let result of batchResults) {
        result = null;
      }
    }

    if (processedImages.length === 0) {
      return res.status(400).json({ error: "No valid images found" });
    }

    // Create composite with 3x2 grid layout
    const compositeInputs = [];

    // Fill the grid row by row
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const imageIndex = row * 3 + col;
        if (imageIndex < processedImages.length) {
          compositeInputs.push({
            input: processedImages[imageIndex],
            left: col * cellWidth,
            top: row * cellHeight
          });
        }
      }
    }

    let composite = sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    }).composite(compositeInputs);

    // Generate final image and save directly to file
    await composite.jpeg({ quality: 85 }).toFile(cachePath);
    console.log(`Person share image generated and saved to: ${cachePath}`);

    // Clean up processed images from memory immediately
    processedImages.forEach((img, index) => {
      processedImages[index] = null;
    });
    processedImages.length = 0;
    composite = null;

    // Trigger garbage collection
    if (global.gc) global.gc();

    // Stream the file from disk - no need to keep in memory
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      "Content-Disposition": `inline; filename="${personName}-share.jpg"`
    });

    const fileStream = fs.createReadStream(cachePath);
    fileStream.on("error", (err) => {
      console.error("Error streaming generated file:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream generated image" });
      }
    });
    fileStream.pipe(res);
  } catch (error) {
    console.error("Error generating person share image:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Space page share image endpoint
app.get("/space/share-image", async (req, res) => {
  try {
    // Check if we have a valid cached version
    const cachePath = getShareImageCachePath("space");
    if (isShareImageCacheValid(cachePath)) {
      console.log("Serving cached space share image from file");
      res.set({
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        "Content-Disposition": `inline; filename="space-share.jpg"`
      });
      // Stream file directly from disk - no memory buffering
      const fileStream = fs.createReadStream(cachePath);
      fileStream.on("error", (err) => {
        console.error("Error streaming cached file:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream cached image" });
        }
      });
      fileStream.pipe(res);
      return;
    }

    console.log("Generating new space share image");

    // Get the first studio photo
    const studioPhotoUrl = await getFirstStudioPhoto();
    if (!studioPhotoUrl) {
      return res.status(400).json({ error: "No studio photos found" });
    }

    // Download and process the image
    let imageBuffer;
    try {
      const response = await fetch(studioPhotoUrl);
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
      }
    } catch (error) {
      console.error(`Error processing studio photo ${studioPhotoUrl}:`, error);
      return res.status(500).json({ error: "Failed to process studio photo" });
    }

    if (!imageBuffer) {
      return res.status(400).json({ error: "No valid studio photo found" });
    }

    // Resize image to standard share image dimensions and save directly to file
    const canvasWidth = 1200;
    const canvasHeight = 630;

    await sharp(imageBuffer)
      .resize(canvasWidth, canvasHeight, {
        fit: "cover",
        position: "center",
        withoutEnlargement: false
      })
      .jpeg({ quality: 85 })
      .toFile(cachePath);

    console.log(`Space share image generated and saved to: ${cachePath}`);

    // Clean up buffer immediately
    imageBuffer = null;
    if (global.gc) global.gc();

    // Stream the file from disk - no need to keep in memory
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      "Content-Disposition": `inline; filename="space-share.jpg"`
    });

    const fileStream = fs.createReadStream(cachePath);
    fileStream.on("error", (err) => {
      console.error("Error streaming generated file:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream generated image" });
      }
    });
    fileStream.pipe(res);
  } catch (error) {
    console.error("Error generating space share image:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Load cache metadata on startup (not full data)
loadCacheMetadata();

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
