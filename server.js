import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const port = 3109;

app.get("/projects", (req, res) => {
  try {
    const projectsDir = path.join(process.cwd(), "projects");
    const projects = [];

    // Read all directories in the projects folder
    const projectFolders = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    // For each project folder, read the manifest.json
    projectFolders.forEach((projectName) => {
      const manifestPath = path.join(projectsDir, projectName, "manifest.json");

      if (fs.existsSync(manifestPath)) {
        const manifestContent = fs.readFileSync(manifestPath, "utf8");
        const manifest = JSON.parse(manifestContent);

        // Read media files from the media folder
        const mediaPath = path.join(projectsDir, projectName, "media");
        let media = [];

        if (fs.existsSync(mediaPath)) {
          const mediaFiles = fs
            .readdirSync(mediaPath)
            .filter((file) => {
              // Only include common media file extensions
              const ext = path.extname(file).toLowerCase();
              return [
                ".jpg",
                ".jpeg",
                ".png",
                ".gif",
                ".mp4",
                ".mov",
                ".avi",
                ".webm"
              ].includes(ext);
            })
            .sort(); // Sort alphabetically

          // Convert filenames to full URLs
          media = mediaFiles.map(
            (filename) => `/media/${projectName}/${filename}`
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
    });

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
