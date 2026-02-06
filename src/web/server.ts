/**
 * Web server for visualization
 */

import express from "express";
import { join } from "path";
import { existsSync } from "fs";
import { GraphStorage } from "../graph/storage.js";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function startServer(dbPath: string, port: number = 3333): void {
  const app = express();
  const storage = new GraphStorage(dbPath);

  // Find the web directory - try multiple possible locations
  const possiblePaths = [
    join(__dirname, "../../web"),           // Development: from dist/
    join(__dirname, "../web"),              // Installed: from dist/
    join(__dirname, "../../../web"),        // NPX: deeper nesting
  ];

  let webDir = possiblePaths[0];
  for (const p of possiblePaths) {
    if (existsSync(join(p, "index.html"))) {
      webDir = p;
      break;
    }
  }

  // Serve static files
  app.use(express.static(webDir));

  // API endpoints
  app.get("/api/graph", (req, res) => {
    try {
      const graph = storage.exportForVisualization();
      res.json(graph);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get("/api/stats", (req, res) => {
    try {
      const stats = storage.getStats();
      const rootPath = storage.getMeta("rootPath");
      const analyzedAt = storage.getMeta("analyzedAt");
      res.json({ ...stats, rootPath, analyzedAt });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get("/api/search", (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        res.json([]);
        return;
      }
      const nodes = storage.searchNodes(query);
      res.json(nodes.slice(0, 50));
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get("/api/node/:id", (req, res) => {
    try {
      const node = storage.getNode(decodeURIComponent(req.params.id));
      if (!node) {
        res.status(404).json({ error: "Node not found" });
        return;
      }

      const edgesFrom = storage.getEdgesFrom(node.id);
      const edgesTo = storage.getEdgesTo(node.id);

      res.json({ node, edgesFrom, edgesTo });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get("/api/file/:path(*)", (req, res) => {
    try {
      const filePath = decodeURIComponent(req.params.path);
      const nodes = storage.getNodesByFile(filePath);
      const deps = storage.getFileDependencies(filePath);
      res.json({ nodes, dependencies: deps });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.listen(port, () => {
    console.log(`\n  CodeMap visualization server running at:`);
    console.log(`  http://localhost:${port}\n`);
  });

  // Cleanup on exit
  process.on("SIGINT", () => {
    storage.close();
    process.exit(0);
  });
}
