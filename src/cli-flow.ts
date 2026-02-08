/**
 * CodeMap Flow Edition - Simplified CLI
 * Only 2 commands: index and mcp-server
 */

import { Command } from "commander";
import { resolve, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import chalk from "chalk";
import ora from "ora";
import { FlowBuilder, FlowStorage } from "./flow/index.js";
import { DEFAULT_CONFIG } from "./types.js";
import { analyzeImpact } from "./commands/impact.js";
import { isGitRepository, getGitStatus } from "./utils/git.js";

// Import parsers to register them
import "./parsers/index.js";

const program = new Command();

/**
 * Configure MCP server in Claude Code config
 */
function configureMCPServer(projectPath: string): boolean {
  try {
    const claudeConfigPath = join(homedir(), ".claude", "config.json");

    if (!existsSync(claudeConfigPath)) {
      return false;
    }

    const config = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));

    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    // Add or update codemap server
    config.mcpServers.codemap = {
      command: "npx",
      args: ["codemap-ai", "mcp-server", "--path", projectPath],
    };

    writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    return false;
  }
}

program
  .name("codemap")
  .description("CodeMap Flow - Call graph analyzer for understanding code impact")
  .version("3.6.0");

// ============ Index Command ============

program
  .command("index")
  .description("Build call graph for your codebase")
  .argument("[path]", "Path to the project root", ".")
  .option("-f, --force", "Force reindex all files (ignore cache)")
  .option("--include <patterns...>", "Glob patterns to include")
  .option("--exclude <patterns...>", "Glob patterns to exclude")
  .action(async (path: string, options) => {
    const rootPath = resolve(path);
    const outputDir = join(rootPath, ".codemap");

    console.log(chalk.blue.bold("\n  CodeMap Call Graph Indexer\n"));
    console.log(chalk.gray(`  Project: ${rootPath}\n`));

    // Create output directory
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const dbPath = join(outputDir, "graph.db");
    const storage = new FlowStorage(dbPath);

    const builder = new FlowBuilder(storage, {
      rootPath,
      include: options.include || DEFAULT_CONFIG.include!,
      exclude: options.exclude || DEFAULT_CONFIG.exclude!,
      forceReindex: options.force || false,
    });

    const spinner = ora("Discovering files...").start();

    builder.setProgressCallback((progress) => {
      switch (progress.phase) {
        case "discovering":
          spinner.text = "Discovering files...";
          break;
        case "parsing":
          spinner.text = `Parsing (${progress.current}/${progress.total}): ${progress.currentFile}`;
          break;
        case "resolving":
          spinner.text = "Resolving cross-file calls...";
          break;
        case "complete":
          spinner.succeed(chalk.green("Indexing complete!"));
          break;
      }
    });

    try {
      const result = await builder.build();

      console.log(chalk.blue("\n  Results:\n"));
      console.log(`  ${chalk.bold("Indexed:")}    ${result.indexed} files`);
      console.log(`  ${chalk.bold("Skipped:")}    ${result.skipped} files (unchanged)`);
      console.log(`  ${chalk.bold("Resolved:")}   ${result.resolved} function calls`);
      console.log(`  ${chalk.bold("Unresolved:")} ${result.unresolved} calls (external/dynamic)`);

      // Show enhanced stats
      const stats = storage.getStats();
      if (stats.httpEndpoints > 0) {
        console.log(chalk.cyan(`\n  ${chalk.bold("Framework Detection:")}`));
        console.log(`  ${chalk.bold("HTTP Endpoints:")} ${stats.httpEndpoints} routes detected`);
        console.log(`  ${chalk.bold("Dependencies:")}   ${stats.resolvedDependencies}/${stats.frameworkDependencies} resolved (FastAPI Depends)`);
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

      const resolveRate = result.resolved + result.unresolved > 0
        ? Math.round((result.resolved / (result.resolved + result.unresolved)) * 100)
        : 0;
      const dependencyRate = stats.frameworkDependencies > 0
        ? Math.round((stats.resolvedDependencies / stats.frameworkDependencies) * 100)
        : 0;

      console.log(chalk.gray(`\n  Call resolution rate: ${resolveRate}%`));
      if (stats.frameworkDependencies > 0) {
        console.log(chalk.gray(`  Dependency resolution rate: ${dependencyRate}%`));
      }
      console.log(chalk.gray(`  Database saved to: ${dbPath}\n`));

      console.log(chalk.cyan("  Next steps:"));
      console.log(chalk.gray("    • Configure MCP server: claude mcp add codemap -- npx codemap-ai mcp-server"));
      console.log(chalk.gray("    • Ask Claude: 'What would break if I change authenticate_user?'\n"));
    } catch (error) {
      spinner.fail(chalk.red("Indexing failed"));
      console.error(error);
      process.exit(1);
    } finally {
      storage.close();
    }
  });

// ============ Init Command ============

program
  .command("init")
  .description("Initialize CodeMap (index + setup MCP)")
  .argument("[path]", "Path to the project root", ".")
  .option("--include <patterns...>", "Glob patterns to include")
  .option("--exclude <patterns...>", "Glob patterns to exclude")
  .option("--skip-mcp", "Skip MCP server configuration")
  .action(async (path: string, options) => {
    const rootPath = resolve(path);
    const outputDir = join(rootPath, ".codemap");

    console.log(chalk.blue.bold("\n  CodeMap Initialization\n"));
    console.log(chalk.gray(`  Project: ${rootPath}\n`));

    // Check if already initialized
    if (existsSync(join(outputDir, "graph.db")) && !options.force) {
      console.log(chalk.yellow("  Already initialized. Use 'codemap reindex' to rebuild.\n"));
      return;
    }

    // Create output directory
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const dbPath = join(outputDir, "graph.db");
    const storage = new FlowStorage(dbPath);

    const builder = new FlowBuilder(storage, {
      rootPath,
      include: options.include || DEFAULT_CONFIG.include!,
      exclude: options.exclude || DEFAULT_CONFIG.exclude!,
      forceReindex: true,
    });

    const spinner = ora("Indexing codebase...").start();

    builder.setProgressCallback((progress) => {
      switch (progress.phase) {
        case "discovering":
          spinner.text = "Discovering files...";
          break;
        case "parsing":
          spinner.text = `Parsing (${progress.current}/${progress.total}): ${progress.currentFile}`;
          break;
        case "resolving":
          spinner.text = "Resolving cross-file calls...";
          break;
        case "complete":
          spinner.succeed(chalk.green("Indexing complete!"));
          break;
      }
    });

    try {
      const result = await builder.build();

      console.log(chalk.blue("\n  Results:\n"));
      console.log(`  ${chalk.bold("Indexed:")}    ${result.indexed} files`);
      console.log(`  ${chalk.bold("Resolved:")}   ${result.resolved} function calls`);

      const stats = storage.getStats();
      if (stats.httpEndpoints > 0) {
        console.log(chalk.cyan(`\n  ${chalk.bold("Framework Detection:")}`));
        console.log(`  ${chalk.bold("HTTP Endpoints:")} ${stats.httpEndpoints} routes`);
      }

      const resolveRate = result.resolved + result.unresolved > 0
        ? Math.round((result.resolved / (result.resolved + result.unresolved)) * 100)
        : 0;

      console.log(chalk.gray(`\n  Call resolution: ${resolveRate}%`));
      console.log(chalk.gray(`  Database: ${dbPath}\n`));

      // Configure MCP server
      if (!options.skipMcp) {
        const mcpConfigured = configureMCPServer(rootPath);
        if (mcpConfigured) {
          console.log(chalk.green("  ✓ MCP server configured in Claude Code\n"));
        } else {
          console.log(chalk.yellow("  ⚠ Could not auto-configure MCP (Claude Code not found)"));
          console.log(chalk.gray("    Run manually: claude mcp add codemap -- npx codemap-ai mcp-server\n"));
        }
      }

      console.log(chalk.cyan("  Ready!"));
      console.log(chalk.gray("    Ask Claude: 'What would break if I change authenticate_user?'\n"));
    } catch (error) {
      spinner.fail(chalk.red("Initialization failed"));
      console.error(error);
      process.exit(1);
    } finally {
      storage.close();
    }
  });

// ============ Impact Command ============

program
  .command("impact")
  .description("Analyze impact of code changes")
  .argument("[path]", "Path to the project root", ".")
  .option("-v, --verbose", "Show detailed output")
  .action(async (path: string, options) => {
    const rootPath = resolve(path);
    const dbPath = join(rootPath, ".codemap", "graph.db");

    console.log(chalk.blue.bold("\n  CodeMap Impact Analysis\n"));

    if (!existsSync(dbPath)) {
      console.log(chalk.red("  Error: Not initialized. Run 'codemap init' first.\n"));
      process.exit(1);
    }

    // Check for changes
    const spinner = ora("Detecting changes...").start();

    try {
      const result = await analyzeImpact({ path: rootPath, verbose: options.verbose });

      if (result.changedFiles.length === 0) {
        spinner.succeed(chalk.green("No changes detected"));
        console.log(chalk.gray("  All files are up to date.\n"));
        return;
      }

      spinner.succeed(chalk.green(`Detected ${result.changedFiles.length} modified files`));

      // Show changed files
      console.log(chalk.blue("\n  Modified Files:\n"));
      for (const file of result.changedFiles.slice(0, 10)) {
        console.log(chalk.gray(`    • ${file}`));
      }
      if (result.changedFiles.length > 10) {
        console.log(chalk.gray(`    ... and ${result.changedFiles.length - 10} more`));
      }

      // Show changed functions (if available from git)
      if (result.changedFunctions.length > 0) {
        console.log(chalk.blue("\n  Changed Functions:\n"));
        for (const func of result.changedFunctions) {
          console.log(chalk.gray(`    • ${func.functionName} (${func.file}:${func.lineNumber})`));
        }
      }

      // Show impact
      if (result.directCallers.size > 0) {
        console.log(chalk.blue("\n  Impact Analysis:\n"));
        for (const [funcName, callers] of result.directCallers.entries()) {
          console.log(chalk.yellow(`    ${funcName}:`));
          console.log(chalk.gray(`      ${callers.length} direct callers`));
          if (options.verbose) {
            for (const caller of callers.slice(0, 5)) {
              console.log(chalk.gray(`        • ${caller.name} (${caller.file}:${caller.line})`));
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

      // NEW: Show import issues
      if (result.importIssues.size > 0) {
        console.log(chalk.blue("\n  🔍 Import Analysis:\n"));
        for (const [file, issues] of result.importIssues.entries()) {
          if (issues.missing.length > 0) {
            console.log(chalk.red(`    ❌ CRITICAL: ${file} - Missing imports still in use:`));
            for (const missing of issues.missing.slice(0, 10)) {
              const usageInfo = missing.usedAt ? ` (used at lines: ${missing.usedAt.slice(0, 3).join(", ")}${missing.usedAt.length > 3 ? "..." : ""})` : "";
              console.log(chalk.gray(`       • ${missing.identifier}${usageInfo}`));
            }
            if (issues.missing.length > 10) {
              console.log(chalk.gray(`       ... and ${issues.missing.length - 10} more`));
            }
          }
          if (issues.unused.length > 0 && options.verbose) {
            console.log(chalk.yellow(`    ⚠️  ${file} - Unused imports:`));
            for (const unused of issues.unused.slice(0, 3)) {
              console.log(chalk.gray(`       • ${unused.identifier} (line ${unused.line})`));
            }
          }
        }
      }

      // NEW: Show removed call impacts
      if (result.removedCallImpacts && result.removedCallImpacts.length > 0) {
        console.log(chalk.blue("\n  🚨 Removed Function Calls:\n"));

        for (const impact of result.removedCallImpacts) {
          // Color by severity
          const severityColors = {
            'CRITICAL': chalk.red,
            'HIGH': chalk.red,
            'MEDIUM': chalk.yellow,
            'LOW': chalk.gray,
          };
          const severityColor = severityColors[impact.severity];

          console.log(severityColor(`    ${impact.severity}: ${impact.removedCall.callee}()`));
          console.log(chalk.gray(`       Removed from: ${impact.removedCall.removedFrom}() at line ${impact.removedCall.lineNumber}`));
          console.log(chalk.gray(`       File: ${impact.removedCall.file}`));

          if (impact.stillCalledBy.length === 0) {
            console.log(chalk.red(`       ⚠️ ORPHANED: No longer called anywhere!`));
          } else {
            const callerNames = impact.stillCalledBy.slice(0, 3).map(c => c.name).join(', ');
            const moreCount = impact.stillCalledBy.length > 3 ? ` and ${impact.stillCalledBy.length - 3} more` : '';
            console.log(chalk.gray(`       Still called by: ${callerNames}${moreCount}`));
          }

          if (impact.impactedFunctions.length > 0) {
            console.log(chalk.gray(`       Impact: ${impact.impactedFunctions.length} dependent function${impact.impactedFunctions.length === 1 ? '' : 's'}`));

            // Show top 3 impacted functions
            const topImpacted = impact.impactedFunctions.slice(0, 3);
            for (const func of topImpacted) {
              console.log(chalk.gray(`         • ${func.name} (${func.file}:${func.line})`));
            }
            if (impact.impactedFunctions.length > 3) {
              console.log(chalk.gray(`         ... and ${impact.impactedFunctions.length - 3} more`));
            }
          }

          if (impact.severity === 'CRITICAL') {
            console.log(chalk.red(`       🔴 ${impact.description.split('\n').pop()}`));
          }

          console.log();  // Blank line between impacts
        }
      }

      // NEW: Show Docker impact
      if (result.dockerImpact) {
        console.log(chalk.blue("\n  📦 Docker Service Impact:\n"));
        console.log(chalk.red(`    ⚠️  Entry point file(s) modified - service(s) will not start:`));
        for (const file of result.dockerImpact.entryPointFiles) {
          console.log(chalk.gray(`       • ${file}`));
        }
        console.log(chalk.red(`\n    💥 Affected Services (${result.dockerImpact.affectedServices.length}):`));
        for (const service of result.dockerImpact.affectedServices) {
          console.log(chalk.gray(`       • ${service}`));
        }
        console.log(chalk.yellow(`\n    → If entry point crashes, these services WILL FAIL`));
      }

      // Show risk level
      console.log(chalk.blue("\n  Risk Assessment:\n"));
      const riskColor = result.riskLevel === "CRITICAL"
        ? chalk.red.bold
        : result.riskLevel === "HIGH"
          ? chalk.red
          : result.riskLevel === "MEDIUM"
            ? chalk.yellow
            : chalk.green;
      console.log(`    ${riskColor(result.riskLevel)} - ${result.totalImpact} components affected`);

      if (result.riskLevel === "CRITICAL") {
        console.log(chalk.red.bold("\n    ⚠️  DO NOT DEPLOY - System-wide failure risk"));
        console.log(chalk.gray("       Fix critical issues before proceeding"));
      } else if (result.riskLevel === "HIGH") {
        console.log(chalk.yellow("\n    ⚠️  High risk - Extensive testing required"));
      }

      console.log();
    } catch (error) {
      spinner.fail(chalk.red("Impact analysis failed"));
      console.error(error);
      process.exit(1);
    }
  });

// ============ Visualize Command ============

program
  .command("visualize")
  .description("Interactive visualization of impact analysis")
  .argument("[path]", "Path to the project root", ".")
  .option("-v, --verbose", "Show detailed output")
  .action(async (path: string, options) => {
    try {
      const { visualizeImpact } = await import("./commands/visualize.js");
      await visualizeImpact(path, options);
    } catch (error: any) {
      console.log(chalk.red(`\n  Error: ${error?.message || error}\n`));
      process.exit(1);
    }
  });

// ============ Reindex Command ============

program
  .command("reindex")
  .description("Force full re-index of codebase")
  .argument("[path]", "Path to the project root", ".")
  .option("--include <patterns...>", "Glob patterns to include")
  .option("--exclude <patterns...>", "Glob patterns to exclude")
  .action(async (path: string, options) => {
    // Just call index with force flag
    const indexCommand = program.commands.find((cmd) => cmd.name() === "index");
    if (indexCommand) {
      await indexCommand.parseAsync([path, "--force", ...(options.include ? ["--include", ...options.include] : []), ...(options.exclude ? ["--exclude", ...options.exclude] : [])], { from: "user" });
    }
  });

// ============ MCP Server Command ============

program
  .command("mcp-server")
  .description("Start MCP server for Claude Code integration")
  .option("-p, --path <path>", "Project root path", ".")
  .action(async (options) => {
    process.env.CODEMAP_PROJECT_ROOT = resolve(options.path);
    process.env.CODEMAP_DB_PATH = join(resolve(options.path), ".codemap", "graph.db");

    // Start the flow MCP server
    await import("./mcp/flow-server.js");
  });

// Parse and run
program.parse();
