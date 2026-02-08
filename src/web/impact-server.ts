/**
 * Express server for serving impact visualization
 */

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerOptions {
  port: number;
  impactDataPath: string;
  projectPath: string;
}

export function startVisualizationServer(options: ServerOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const app = express();

    // Serve static files from web-dist
    // When compiled, __dirname is dist/, so ../web-dist is correct
    const webDistPath = join(__dirname, "../web-dist");
    app.use(express.static(webDistPath));

    // API endpoint to get impact data
    app.get("/api/impact", (req, res) => {
      try {
        if (!existsSync(options.impactDataPath)) {
          return res.status(404).json({ error: "Impact data not found" });
        }

        const data = readFileSync(options.impactDataPath, "utf-8");
        const impactData = JSON.parse(data);

        res.json(impactData);
      } catch (error) {
        console.error("Error reading impact data:", error);
        res.status(500).json({ error: "Failed to read impact data" });
      }
    });

    // API endpoint to get project path
    app.get("/api/project-path", (req, res) => {
      res.json({ path: options.projectPath });
    });

    // Serve index.html for all other routes (SPA)
    app.use((req, res) => {
      const indexPath = join(webDistPath, "index.html");
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send("Web dist not found. Please run: npm run build:web");
      }
    });

    const server = app.listen(options.port, () => {
      console.log(`\n🌐 Visualization server running at:`);
      console.log(`   http://localhost:${options.port}\n`);
      resolve();
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${options.port} is already in use`));
      } else {
        reject(error);
      }
    });
  });
}
