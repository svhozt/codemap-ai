/**
 * CodeMap CLI
 *
 *   codemap init       index the project and register the MCP server with Claude Code
 *   codemap index      build or update the call graph (incremental)
 *   codemap reindex    rebuild the call graph from scratch
 *   codemap impact     analyze the impact of uncommitted changes
 *   codemap visualize  show the impact analysis in the browser
 *   codemap mcp-server start the MCP server (used by Claude Code)
 */

import { Command } from "commander";
import { resolve, join } from "path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { FlowBuilder, FlowStorage, type FlowBuildResult } from "./flow/index.js";
import { DEFAULT_CONFIG } from "./types.js";
import { analyzeImpact, type ImpactResult } from "./commands/impact.js";
import { VERSION } from "./version.js";
import { isGitRepository, runGit } from "./utils/git.js";

// Import parsers to register them
import "./parsers/index.js";

const program = new Command();

const MCP_SERVER_NAME = "codemap";
/** How Claude Code starts the server. Claude Code sets CLAUDE_PROJECT_DIR to the project root. */
const MCP_SERVER_ENTRY = {
  type: "stdio",
  command: "npx",
  args: ["-y", "codemap-ai", "mcp-server", "--path", "${CLAUDE_PROJECT_DIR:-.}"],
};
const MANUAL_MCP_COMMAND = "claude mcp add codemap -- npx -y codemap-ai mcp-server";

interface IndexOptions {
  include?: string[];
  exclude?: string[];
  force?: boolean;
}

function fail(message: string): never {
  console.error(chalk.red(`\n  Error: ${message}\n`));
  process.exit(1);
}

/** Resolve and validate the project directory argument. */
function projectRoot(path: string): string {
  const rootPath = resolve(path);
  if (!existsSync(rootPath)) fail(`Directory not found: ${rootPath}`);
  if (!statSync(rootPath).isDirectory()) fail(`Not a directory: ${rootPath}`);
  return rootPath;
}

function attachSpinner(builder: FlowBuilder, spinner: Ora): void {
  builder.setProgressCallback((progress) => {
    switch (progress.phase) {
      case "discovering":
        spinner.text = "Discovering files...";
        break;
      case "parsing":
        spinner.text = `Parsing (${progress.current}/${progress.total}): ${progress.currentFile}`;
        break;
      case "resolving":
        spinner.text = "Resolving calls across files...";
        break;
      case "complete":
        spinner.succeed(chalk.green("Indexing complete!"));
        break;
    }
  });
}

/** Build (or update) the index of `rootPath`. Returns the result and the storage stats. */
async function runIndex(rootPath: string, options: IndexOptions, spinnerText: string) {
  const outputDir = join(rootPath, ".codemap");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const dbPath = join(outputDir, "graph.db");
  const storage = new FlowStorage(dbPath);

  // Reuse the patterns of the existing index unless new ones are given.
  const previous = storage.getIndexPatterns();
  const include = options.include ?? previous?.include ?? DEFAULT_CONFIG.include!;
  const exclude = options.exclude ?? previous?.exclude ?? DEFAULT_CONFIG.exclude!;
  const patternsChanged =
    previous !== null &&
    (JSON.stringify(previous.include) !== JSON.stringify(include) ||
      JSON.stringify(previous.exclude) !== JSON.stringify(exclude));

  const builder = new FlowBuilder(storage, {
    rootPath,
    include,
    exclude,
    forceReindex: options.force || false,
  });

  const spinner = ora(spinnerText).start();
  attachSpinner(builder, spinner);

  try {
    const result = await builder.build();
    if (spinner.isSpinning) spinner.succeed(chalk.green("Indexing complete!"));
    return { result, stats: storage.getStats(), dbPath, patternsChanged };
  } catch (error) {
    spinner.fail(chalk.red("Indexing failed"));
    throw error;
  } finally {
    storage.close();
  }
}

function printIndexResults(
  result: FlowBuildResult,
  stats: ReturnType<FlowStorage["getStats"]>,
  dbPath: string,
  options: { showSkipped: boolean }
): void {
  console.log(chalk.blue("\n  Results:\n"));
  console.log(`  ${chalk.bold("Indexed:")}    ${result.indexed} files`);
  if (options.showSkipped) {
    console.log(`  ${chalk.bold("Skipped:")}    ${result.skipped} files (unchanged)`);
  }
  if (result.removed > 0) {
    console.log(`  ${chalk.bold("Removed:")}    ${result.removed} files (deleted or excluded)`);
  }
  console.log(`  ${chalk.bold("Total:")}      ${stats.totalFiles} files, ${stats.totalNodes} symbols`);
  console.log(`  ${chalk.bold("Resolved:")}   ${result.resolved} function calls`);
  console.log(`  ${chalk.bold("Unresolved:")} ${result.unresolved} calls (external/dynamic)`);

  if (stats.httpEndpoints > 0) {
    console.log(chalk.cyan(`\n  ${chalk.bold("Framework Detection:")}`));
    console.log(`  ${chalk.bold("HTTP Endpoints:")} ${stats.httpEndpoints} routes detected`);
    if (stats.frameworkDependencies > 0) {
      console.log(
        `  ${chalk.bold("Dependencies:")}   ${stats.resolvedDependencies}/${stats.frameworkDependencies} resolved (FastAPI Depends)`
      );
    }
  }

  if (result.rebuilt) {
    console.log(chalk.yellow("\n  The index was written by an older version of codemap-ai and was rebuilt."));
  }

  if (result.tooLarge.length > 0) {
    console.log(chalk.gray(`\n  Skipped ${result.tooLarge.length} files larger than 200 KB`));
  }

  if (result.errors.length > 0) {
    console.log(chalk.yellow(`\n  Errors: ${result.errors.length} files failed`));
    for (const err of result.errors.slice(0, 5)) {
      console.log(chalk.gray(`    - ${err}`));
    }
    if (result.errors.length > 5) {
      console.log(chalk.gray(`    ... and ${result.errors.length - 5} more`));
    }
  }

  const totalCalls = result.resolved + result.unresolved;
  const resolveRate = totalCalls > 0 ? Math.round((result.resolved / totalCalls) * 100) : 0;
  console.log(chalk.gray(`\n  Call resolution rate: ${resolveRate}% (calls into external libraries stay unresolved)`));
  console.log(chalk.gray(`  Database saved to: ${dbPath}\n`));
}

/**
 * Register the MCP server for this project in `<project>/.mcp.json`
 * (Claude Code's project-scoped configuration). Existing entries are kept.
 */
function configureMCPServer(projectPath: string): { ok: boolean; file: string; message?: string } {
  const file = join(projectPath, ".mcp.json");
  try {
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8");
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, file, message: `${file} is not a JSON object` };
        }
        config = parsed;
      }
    }
    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      config.mcpServers = {};
    }
    config.mcpServers[MCP_SERVER_NAME] = MCP_SERVER_ENTRY;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, file, message: error instanceof Error ? error.message : String(error) };
  }
}

program
  .name("codemap")
  .description("CodeMap - Call graph analyzer for understanding code impact")
  .version(VERSION);

// ============ Index Command ============

program
  .command("index")
  .description("Build or update the call graph (only changed files are re-parsed)")
  .argument("[path]", "Path to the project root", ".")
  .option("-f, --force", "Force reindex all files (ignore cache)")
  .option("--include <patterns...>", "Glob patterns to include")
  .option("--exclude <patterns...>", "Glob patterns to exclude")
  .action(async (path: string, options: IndexOptions) => {
    const rootPath = projectRoot(path);

    console.log(chalk.blue.bold("\n  CodeMap Call Graph Indexer\n"));
    console.log(chalk.gray(`  Project: ${rootPath}\n`));

    try {
      const { result, stats, dbPath } = await runIndex(rootPath, options, "Discovering files...");
      printIndexResults(result, stats, dbPath, { showSkipped: true });

      console.log(chalk.cyan("  Next steps:"));
      console.log(chalk.gray("    • Register the MCP server: codemap init (or: " + MANUAL_MCP_COMMAND + ")"));
      console.log(chalk.gray("    • Check your changes: codemap impact\n"));
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });

// ============ Init Command ============

program
  .command("init")
  .description("Initialize CodeMap (index + register the MCP server for Claude Code)")
  .argument("[path]", "Path to the project root", ".")
  .option("--include <patterns...>", "Glob patterns to include")
  .option("--exclude <patterns...>", "Glob patterns to exclude")
  .option("--skip-mcp", "Skip MCP server configuration")
  .option("-f, --force", "Re-initialize even if already initialized")
  .action(async (path: string, options: IndexOptions & { skipMcp?: boolean }) => {
    const rootPath = projectRoot(path);
    const outputDir = join(rootPath, ".codemap");

    console.log(chalk.blue.bold("\n  CodeMap Initialization\n"));
    console.log(chalk.gray(`  Project: ${rootPath}\n`));

    // Check if already initialized
    if (existsSync(join(outputDir, "graph.db")) && !options.force) {
      console.log(chalk.yellow("  Already initialized. Use 'codemap reindex' to rebuild, or 'codemap init --force'.\n"));
      return;
    }

    try {
      const { result, stats, dbPath } = await runIndex(
        rootPath,
        { ...options, force: true },
        "Indexing codebase..."
      );
      printIndexResults(result, stats, dbPath, { showSkipped: false });

      // Configure MCP server
      if (!options.skipMcp) {
        const mcp = configureMCPServer(rootPath);
        if (mcp.ok) {
          console.log(chalk.green(`  ✓ MCP server registered in ${mcp.file}`));
          console.log(chalk.gray("    Claude Code asks you to approve it the next time you start it in this project.\n"));
        } else {
          console.log(chalk.yellow(`  ⚠ Could not write ${mcp.file}: ${mcp.message}`));
          console.log(chalk.gray(`    Register it manually: ${MANUAL_MCP_COMMAND}\n`));
        }
      }

      if (isGitRepository(rootPath) && runGit(rootPath, ["check-ignore", "-q", ".codemap/graph.db"]) === null) {
        console.log(chalk.gray("  Tip: add .codemap/ to your .gitignore - the index is local and should not be committed.\n"));
      }

      console.log(chalk.cyan("  Ready!"));
      console.log(chalk.gray("    Ask Claude: 'What would break if I change <function>?'\n"));
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });

// ============ Impact Command ============

function printImpact(result: ImpactResult, rootPath: string, verbose: boolean): void {
  for (const note of result.notes) {
    console.log(chalk.gray(`  ℹ ${note}`));
  }

  // Show changed files
  console.log(chalk.blue("\n  Modified Files:\n"));
  for (const file of result.changedFiles.slice(0, 10)) {
    console.log(chalk.gray(`    • ${file}`));
  }
  if (result.changedFiles.length > 10) {
    console.log(chalk.gray(`    ... and ${result.changedFiles.length - 10} more`));
  }

  // Show changed functions
  if (result.changedFunctions.length > 0) {
    console.log(chalk.blue("\n  Changed Functions:\n"));
    for (const func of result.changedFunctions) {
      const tag = func.changeType === "modified" ? "" : chalk.gray(` [${func.changeType}]`);
      console.log(chalk.gray(`    • ${func.functionName} (${func.file}:${func.lineNumber})`) + tag);
    }
  }

  // Show impact
  if (result.directCallers.size > 0) {
    console.log(chalk.blue("\n  Impact Analysis:\n"));
    for (const [funcName, callers] of result.directCallers.entries()) {
      console.log(chalk.yellow(`    ${funcName}:`));
      console.log(chalk.gray(`      ${callers.length} direct caller${callers.length === 1 ? "" : "s"}`));
      if (verbose) {
        for (const caller of callers.slice(0, 5)) {
          console.log(chalk.gray(`        • ${caller.name} (${relativeTo(rootPath, caller.file)}:${caller.line})`));
        }
        if (callers.length > 5) {
          console.log(chalk.gray(`        ... and ${callers.length - 5} more`));
        }
      }
    }
  }

  // Show affected endpoints
  if (result.affectedEndpoints.length > 0) {
    console.log(chalk.blue("\n  Affected HTTP Endpoints:\n"));
    for (const endpoint of result.affectedEndpoints) {
      console.log(chalk.gray(`    • ${endpoint}`));
    }
  }

  // Show import issues
  if (result.importIssues.size > 0) {
    const anyVisible = [...result.importIssues.values()].some(
      (issues) => issues.missing.length > 0 || (verbose && issues.unused.length > 0)
    );
    if (anyVisible) console.log(chalk.blue("\n  🔍 Import Analysis:\n"));
    for (const [file, issues] of result.importIssues.entries()) {
      if (issues.missing.length > 0) {
        console.log(chalk.red(`    ❌ CRITICAL: ${file} - Missing imports still in use:`));
        for (const missing of issues.missing.slice(0, 10)) {
          const usageInfo = missing.usedAt
            ? ` (used at lines: ${missing.usedAt.slice(0, 3).join(", ")}${missing.usedAt.length > 3 ? "..." : ""})`
            : "";
          console.log(chalk.gray(`       • ${missing.identifier}${usageInfo}`));
        }
        if (issues.missing.length > 10) {
          console.log(chalk.gray(`       ... and ${issues.missing.length - 10} more`));
        }
      }
      if (issues.unused.length > 0 && verbose) {
        console.log(chalk.yellow(`    ⚠️  ${file} - Unused imports:`));
        for (const unused of issues.unused.slice(0, 5)) {
          console.log(chalk.gray(`       • ${unused.identifier} (line ${unused.line})`));
        }
      }
    }
  }

  // Show removed call impacts
  if (result.removedCallImpacts.length > 0) {
    console.log(chalk.blue("\n  🚨 Removed Function Calls:\n"));

    const severityColors = {
      CRITICAL: chalk.red,
      HIGH: chalk.red,
      MEDIUM: chalk.yellow,
      LOW: chalk.gray,
    };

    for (const impact of result.removedCallImpacts) {
      const severityColor = severityColors[impact.severity];
      const callee = impact.removedCall.expression ?? impact.removedCall.callee;

      console.log(severityColor(`    ${impact.severity}: ${callee}()`));
      console.log(chalk.gray(`       Removed from: ${impact.removedCall.removedFrom}() (was line ${impact.removedCall.lineNumber})`));
      console.log(chalk.gray(`       File: ${impact.removedCall.file}`));

      if (!impact.functionNode) {
        console.log(chalk.yellow(`       ⚠️ Security-related call removed (defined outside the indexed code)`));
      } else if (impact.stillCalledBy.length === 0) {
        console.log(chalk.red(`       ⚠️ ORPHANED: No longer called anywhere!`));
      } else {
        const callerNames = impact.stillCalledBy.slice(0, 3).map((c) => c.name).join(", ");
        const moreCount = impact.stillCalledBy.length > 3 ? ` and ${impact.stillCalledBy.length - 3} more` : "";
        console.log(chalk.gray(`       Still called by: ${callerNames}${moreCount}`));
      }

      if (impact.impactedFunctions.length > 0) {
        console.log(
          chalk.gray(
            `       Impact: ${impact.impactedFunctions.length} dependent function${impact.impactedFunctions.length === 1 ? "" : "s"}`
          )
        );
        for (const func of impact.impactedFunctions.slice(0, 3)) {
          console.log(chalk.gray(`         • ${func.name} (${relativeTo(rootPath, func.file)}:${func.line})`));
        }
        if (impact.impactedFunctions.length > 3) {
          console.log(chalk.gray(`         ... and ${impact.impactedFunctions.length - 3} more`));
        }
      }

      if (impact.severity === "CRITICAL") {
        console.log(chalk.red(`       ${impact.description.split("\n").pop()}`));
      }

      console.log(); // Blank line between impacts
    }
  }

  // Show data-flow breaks
  if (result.dataFlowChanges.length > 0) {
    console.log(chalk.blue("\n  🔄 Data Flow Changes:\n"));
    for (const change of result.dataFlowChanges) {
      const color = change.severity === "CRITICAL" || change.severity === "HIGH" ? chalk.red : chalk.yellow;
      console.log(color(`    ${change.severity}: ${change.functionName}() no longer returns "${change.propertyPath}"`));
      console.log(chalk.gray(`       File: ${change.filePath}:${change.line}`));
      for (const loc of change.accessLocations.slice(0, 5)) {
        console.log(chalk.gray(`         • read by ${loc.functionName}() at ${relativeTo(rootPath, loc.file)}:${loc.line}`));
      }
      if (change.accessLocations.length > 5) {
        console.log(chalk.gray(`         ... and ${change.accessLocations.length - 5} more`));
      }
    }
  }

  // Show Docker impact
  if (result.dockerImpact) {
    console.log(chalk.blue("\n  📦 Docker Service Impact:\n"));
    console.log(chalk.red(`    ⚠️  Entry point file(s) modified:`));
    for (const file of result.dockerImpact.entryPointFiles) {
      console.log(chalk.gray(`       • ${file}`));
    }
    console.log(chalk.red(`\n    💥 Affected Services (${result.dockerImpact.affectedServices.length}):`));
    for (const service of result.dockerImpact.affectedServices) {
      console.log(chalk.gray(`       • ${service}`));
    }
    console.log(chalk.yellow(`\n    → If an entry point fails to start, these services fail too`));
  }

  // Show risk level
  console.log(chalk.blue("\n  Risk Assessment:\n"));
  const riskColor =
    result.riskLevel === "CRITICAL"
      ? chalk.red.bold
      : result.riskLevel === "HIGH"
        ? chalk.red
        : result.riskLevel === "MEDIUM"
          ? chalk.yellow
          : chalk.green;
  console.log(`    ${riskColor(result.riskLevel)} - ${result.totalImpact} component${result.totalImpact === 1 ? "" : "s"} affected`);

  if (result.riskLevel === "CRITICAL") {
    console.log(chalk.red.bold("\n    ⚠️  DO NOT DEPLOY - Critical issue detected"));
    console.log(chalk.gray("       Fix critical issues before proceeding"));
  } else if (result.riskLevel === "HIGH") {
    console.log(chalk.yellow("\n    ⚠️  High risk - Extensive testing required"));
  }

  console.log();
}

function relativeTo(rootPath: string, file: string): string {
  const root = rootPath.replace(/\\/g, "/");
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
}

/** JSON-friendly copy of an impact result (Maps become objects). */
function impactToJson(result: ImpactResult): Record<string, unknown> {
  return {
    ...result,
    directCallers: Object.fromEntries(result.directCallers),
    importIssues: Object.fromEntries(result.importIssues),
  };
}

program
  .command("impact")
  .description("Analyze impact of uncommitted code changes")
  .argument("[path]", "Path to the project root", ".")
  .option("-v, --verbose", "Show detailed output")
  .option("--json", "Print the result as JSON (for scripts and CI)")
  .option("--fail-on <level>", "Exit with code 2 when the risk is at or above LOW, MEDIUM, HIGH or CRITICAL")
  .action(async (path: string, options: { verbose?: boolean; json?: boolean; failOn?: string }) => {
    const rootPath = projectRoot(path);
    const dbPath = join(rootPath, ".codemap", "graph.db");

    const levels = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    const failOn = options.failOn?.toUpperCase();
    if (failOn && !levels.includes(failOn)) {
      fail(`--fail-on must be one of ${levels.join(", ")}`);
    }

    if (!existsSync(dbPath)) {
      fail("Not initialized. Run 'codemap init' first.");
    }

    if (!options.json) console.log(chalk.blue.bold("\n  CodeMap Impact Analysis\n"));

    const spinner = options.json ? null : ora("Detecting changes...").start();

    try {
      const result = await analyzeImpact({ path: rootPath, verbose: options.verbose });

      if (options.json) {
        console.log(JSON.stringify(impactToJson(result), null, 2));
      } else if (result.changedFiles.length === 0) {
        spinner?.succeed(chalk.green("No changes detected"));
        for (const note of result.notes) console.log(chalk.gray(`  ℹ ${note}`));
        console.log(chalk.gray("  All files are up to date.\n"));
      } else {
        spinner?.succeed(
          chalk.green(`Detected ${result.changedFiles.length} modified file${result.changedFiles.length === 1 ? "" : "s"}`)
        );
        printImpact(result, rootPath, options.verbose === true);
      }

      if (failOn && result.changedFiles.length > 0 && levels.indexOf(result.riskLevel) >= levels.indexOf(failOn)) {
        process.exitCode = 2;
      }
    } catch (error) {
      spinner?.fail(chalk.red("Impact analysis failed"));
      console.error(chalk.red(`  ${error instanceof Error ? error.message : String(error)}\n`));
      process.exit(1);
    }
  });

// ============ Visualize Command ============

program
  .command("visualize")
  .description("Interactive visualization of impact analysis")
  .argument("[path]", "Path to the project root", ".")
  .option("-v, --verbose", "Show detailed output")
  .option("-p, --port <number>", "Port for the local web server", "37421")
  .option("--no-open", "Do not open a browser")
  .action(async (path: string, options) => {
    const rootPath = projectRoot(path);
    try {
      const { visualizeImpact } = await import("./commands/visualize.js");
      await visualizeImpact(rootPath, options);
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

// ============ Reindex Command ============

program
  .command("reindex")
  .description("Force full re-index of codebase")
  .argument("[path]", "Path to the project root", ".")
  .option("--include <patterns...>", "Glob patterns to include")
  .option("--exclude <patterns...>", "Glob patterns to exclude")
  .action(async (path: string, options: IndexOptions) => {
    const rootPath = projectRoot(path);

    console.log(chalk.blue.bold("\n  CodeMap Call Graph Indexer\n"));
    console.log(chalk.gray(`  Project: ${rootPath}\n`));

    try {
      const { result, stats, dbPath } = await runIndex(rootPath, { ...options, force: true }, "Discovering files...");
      printIndexResults(result, stats, dbPath, { showSkipped: false });
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });

// ============ MCP Server Command ============

program
  .command("mcp-server")
  .description("Start MCP server for Claude Code integration")
  .option("-p, --path <path>", "Project root path (default: $CLAUDE_PROJECT_DIR or the current directory)")
  .action(async (options: { path?: string }) => {
    // An unexpanded "${CLAUDE_PROJECT_DIR...}" means the variable was not set.
    const given = options.path && !options.path.startsWith("${") ? options.path : undefined;
    const root = resolve(given || process.env.CLAUDE_PROJECT_DIR || ".");
    process.env.CODEMAP_PROJECT_ROOT = root;
    process.env.CODEMAP_DB_PATH = join(root, ".codemap", "graph.db");

    // Start the flow MCP server
    await import("./mcp/flow-server.js");
  });

// Parse and run
program.parseAsync().catch((error) => {
  console.error(error);
  process.exit(1);
});
