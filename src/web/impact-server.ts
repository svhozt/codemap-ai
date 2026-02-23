/**
 * Express server for serving impact visualization
 */

import express from "express";
import type { Server } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerOptions {
  port: number;
  impactDataPath: string;
  projectPath: string;
  /** Interface to listen on. Defaults to 127.0.0.1 so the page is not reachable from the network. */
  host?: string;
}

/** Directory holding the built web app (web-dist/ next to dist/ in the package). */
export function findWebDist(): string | null {
  const candidates = [
    join(__dirname, "../web-dist"), // dist/<chunk>.js -> <package>/web-dist
    join(__dirname, "../../web-dist"), // src/web/impact-server.ts when run from source
  ];
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}

export function startVisualizationServer(options: ServerOptions): Promise<Server> {
  return new Promise((resolve, reject) => {
    const app = express();
    const webDistPath = findWebDist();

    // API endpoint to get impact data
    app.get("/api/impact", (_req, res) => {
      try {
        if (!existsSync(options.impactDataPath)) {
          res.status(404).json({ error: "Impact data not found. Run 'codemap visualize' again." });
          return;
        }
        res.type("application/json").send(readFileSync(options.impactDataPath, "utf-8"));
      } catch (error) {
        res.status(500).json({ error: `Failed to read impact data: ${String(error)}` });
      }
    });

    // API endpoint to get project path
    app.get("/api/project-path", (_req, res) => {
      res.json({ path: options.projectPath });
    });

    if (webDistPath) {
      app.use(express.static(webDistPath));
    }

    // Serve index.html for all other routes (SPA)
    app.use((_req, res) => {
      if (webDistPath) {
        res.sendFile(join(webDistPath, "index.html"));
      } else {
        res
          .status(500)
          .type("text/plain")
          .send("The web app is missing from this installation (web-dist/). Reinstall codemap-ai, or run `npm run build:web` in a source checkout.");
      }
    });

    const server = app.listen(options.port, options.host ?? "127.0.0.1", () => resolve(server));

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${options.port} is already in use. Pass --port <number> to use another one.`));
      } else {
        reject(error);
      }
    });
  });
}
