import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const port = 3109;

app.get("/projects", async (req, res) => {
  try {
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

          try {
            const mediaResponse = await fetch(mediaUrl);
            if (mediaResponse.ok) {
              const mediaHtml = await mediaResponse.text();

              // Parse media files from the HTML
              const mediaFileRegex = /<a href="([^"]+)">/g;
              const mediaFiles = [];
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
                }
              }

              // Sort alphabetically and convert to full URLs
              media = mediaFiles
                .sort()
                .map(
                  (filename) => `${baseUrl}/${projectName}/media/${filename}`
                );
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
            media
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

    res.json(projects);
  } catch (error) {
    console.error("Error reading projects:", error);
    res.status(500).json({ error: "Failed to read projects" });
  }
});

// Serve media files from projects
app.get("/media/:projectId/:filename", (req, res) => {
  try {
    const { projectId, filename } = req.params;
    const mediaPath = path.join(
      process.cwd(),
      "projects",
      projectId,
      "media",
      filename
    );

    // Check if the file exists
    if (!fs.existsSync(mediaPath)) {
      return res.status(404).json({ error: "Media file not found" });
    }

    // Serve the file
    res.sendFile(mediaPath);
  } catch (error) {
    console.error("Error serving media file:", error);
    res.status(500).json({ error: "Failed to serve media file" });
  }
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
