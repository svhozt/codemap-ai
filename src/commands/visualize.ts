/**
 * Visualize command - Interactive impact visualization
 */

import { resolve, join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import { FlowStorage } from "../flow/storage.js";
import { analyzeImpact } from "./impact.js";
import { exportImpactForVisualization } from "./export-impact.js";
import { startVisualizationServer } from "../web/impact-server.js";

export const DEFAULT_PORT = 37421; // Uncommon port to avoid conflicts

export interface VisualizeOptions {
  verbose?: boolean;
  /** Port to serve on (default 37421). */
  port?: number | string;
  /** Do not open a browser (useful over SSH or in scripts). */
  open?: boolean;
}

export async function visualizeImpact(path: string, options: VisualizeOptions = {}): Promise<void> {
  const rootPath = resolve(path);
  const dbPath = join(rootPath, ".codemap", "graph.db");

  if (!existsSync(dbPath)) {
    throw new Error("Not initialized. Run 'codemap init' first.");
  }

  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  console.log(chalk.blue.bold("\n  CodeMap Impact Visualization\n"));
  console.log(chalk.gray("  Analyzing changes..."));

  const result = await analyzeImpact({ path: rootPath, verbose: options.verbose || false });

  if (result.changedFiles.length === 0) {
    console.log(chalk.green("  No changes detected. Nothing to visualize.\n"));
    return;
  }

  const storage = new FlowStorage(dbPath);
  let impactDataPath: string;
  try {
    impactDataPath = exportImpactForVisualization(result, storage, rootPath);
  } finally {
    storage.close();
  }
  console.log(chalk.gray(`  Impact data written to ${impactDataPath}`));

  const server = await startVisualizationServer({ port, impactDataPath, projectPath: rootPath });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://localhost:${actualPort}`;

  console.log(chalk.green(`\n  Visualization running at ${chalk.bold(url)}`));
  console.log(chalk.gray("  Press Ctrl+C to stop\n"));

  if (options.open !== false) {
    try {
      const { default: open } = await import("open");
      await open(url);
    } catch {
      console.log(chalk.yellow(`  Could not open a browser. Open ${url} yourself.\n`));
    }
  }

  // Keep running until interrupted, then shut down cleanly.
  await new Promise<void>((done) => {
    const stop = (): void => {
      server.close(() => done());
      // Connections kept alive by the browser must not block exit.
      setTimeout(() => done(), 1000).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
