/**
 * Visualize command - Interactive impact visualization
 */

import { resolve, join } from "path";
import { existsSync } from "fs";
import open from "open";
import { FlowStorage } from "../flow/storage.js";
import { analyzeImpact } from "./impact.js";
import { exportImpactForVisualization } from "./export-impact.js";
import { startVisualizationServer } from "../web/impact-server.js";

const PORT = 37421; // Uncommon port to avoid conflicts

export async function visualizeImpact(path: string, options: { verbose?: boolean }): Promise<void> {
  const rootPath = resolve(path);
  const dbPath = join(rootPath, ".codemap", "graph.db");
  const impactDataPath = join(rootPath, ".codemap", "impact.json");

  if (!existsSync(dbPath)) {
    throw new Error("Not initialized. Run 'codemap index' first.");
  }

  console.log("\n  🔍 Analyzing impact...");

  // Run impact analysis
  const result = await analyzeImpact({ path: rootPath, verbose: options.verbose || false });

  if (result.changedFiles.length === 0) {
    console.log("  ℹ️  No changes detected. Nothing to visualize.\n");
    return;
  }

  // Export impact data
  console.log("  📊 Exporting visualization data...");
  const storage = new FlowStorage(dbPath);
  exportImpactForVisualization(result, storage, rootPath);
  storage.close();

  // Start server
  console.log("  🚀 Starting visualization server...");

  await startVisualizationServer({
    port: PORT,
    impactDataPath,
    projectPath: rootPath,
  });

  // Open browser
  console.log("  🌐 Opening browser...\n");
  await open(`http://localhost:${PORT}`);

  console.log("  Press Ctrl+C to stop the server\n");

  // Keep the process running
  await new Promise(() => {});
}
