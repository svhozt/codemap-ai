/**
 * CodeMap CLI - Main entry point
 */

import { Command } from "commander";
import { resolve, join, basename } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import chalk from "chalk";
import ora from "ora";
import { GraphBuilder, GraphStorage } from "./graph/index.js";
import { SkillGenerator } from "./skills/index.js";
import { SemanticStorage, SemanticIndexer } from "./semantic/index.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { CodeMapConfig } from "./types.js";

// Import parsers to register them
import "./parsers/index.js";

const program = new Command();

program
  .name("codemap")
  .description("AI-powered codebase knowledge graph generator with Claude Code integration")
  .version("0.1.0");

// ============ Scan Command ============

program
  .command("scan")
  .description("Scan a codebase and build the knowledge graph")
  .argument("[path]", "Path to the project root", ".")
  .option("-o, --output <dir>", "Output directory for database", ".codemap")
  .option("--include <patterns...>", "Glob patterns to include")
  .option("--exclude <patterns...>", "Glob patterns to exclude")
  .option("--clean", "Clear existing data before scanning")
  .action(async (path: string, options) => {
    const rootPath = resolve(path);
    const outputDir = resolve(rootPath, options.output);

    console.log(chalk.blue.bold("\n  CodeMap Scanner\n"));
    console.log(chalk.gray(`  Project: ${rootPath}`));
    console.log(chalk.gray(`  Output:  ${outputDir}\n`));

    // Create output directory
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const dbPath = join(outputDir, "graph.db");

    // Initialize storage
    const storage = new GraphStorage(dbPath);

    if (options.clean) {
      storage.clear();
      console.log(chalk.yellow("  Cleared existing data\n"));
    }

    // Build config
    const config: CodeMapConfig = {
      rootPath,
      include: options.include || DEFAULT_CONFIG.include!,
      exclude: options.exclude || DEFAULT_CONFIG.exclude!,
      languages: DEFAULT_CONFIG.languages!,
      dbPath,
      skillsOutputDir: join(rootPath, ".claude", "skills", "codemap"),
    };

    // Create builder with progress
    const builder = new GraphBuilder(storage, config);
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
          spinner.text = "Resolving cross-file references...";
          break;
        case "complete":
          spinner.succeed(chalk.green("Scan complete!"));
          break;
      }
    });

    try {
      const result = await builder.scan();

      console.log(chalk.blue("\n  Results:\n"));
      console.log(`  ${chalk.bold("Files:")}     ${result.files.length}`);
      console.log(`  ${chalk.bold("Nodes:")}     ${result.totalNodes}`);
      console.log(`  ${chalk.bold("Edges:")}     ${result.totalEdges}`);
      console.log(`  ${chalk.bold("Languages:")} ${Object.keys(result.languages).join(", ")}`);

      if (result.parseErrors && result.parseErrors.length > 0) {
        console.log(chalk.yellow(`\n  Skipped ${result.parseErrors.length} files (parsing issues)`));
      }

      console.log(chalk.gray(`\n  Database saved to: ${dbPath}\n`));
      console.log(chalk.cyan("  Run 'codemap generate-skills' to create Claude Code skills"));
      console.log(chalk.cyan("  Run 'codemap serve' to start the web visualization\n"));
    } catch (error) {
      spinner.fail(chalk.red("Scan failed"));
      console.error(error);
      process.exit(1);
    } finally {
      storage.close();
    }
  });

// ============ Generate Skills Command ============

program
  .command("generate-skills")
  .description("Generate Claude Code skills from the knowledge graph")
  .argument("[path]", "Path to the project root", ".")
  .option("-o, --output <dir>", "Output directory for skills", ".claude/skills")
  .option("--name <name>", "Project name for skill descriptions")
  .option("--no-architecture", "Skip architecture skill")
  .option("--no-patterns", "Skip patterns skill")
  .option("--no-dependencies", "Skip dependencies skill")
  .action(async (path: string, options) => {
    const rootPath = resolve(path);
    const dbPath = join(rootPath, ".codemap", "graph.db");

    if (!existsSync(dbPath)) {
      console.error(chalk.red("\n  Error: No graph database found."));
      console.error(chalk.gray("  Run 'codemap scan' first to analyze your codebase.\n"));
      process.exit(1);
    }

    const outputDir = resolve(rootPath, options.output);
    const projectName = options.name || basename(rootPath);

    console.log(chalk.blue.bold("\n  Generating Claude Code Skills\n"));
    console.log(chalk.gray(`  Project: ${projectName}`));
    console.log(chalk.gray(`  Output:  ${outputDir}\n`));

    const storage = new GraphStorage(dbPath);

    const generator = new SkillGenerator(storage, {
      projectName,
      outputDir,
      includeArchitecture: options.architecture !== false,
      includePatterns: options.patterns !== false,
      includeDependencies: options.dependencies !== false,
    });

    const skills = generator.generateAll();

    console.log(chalk.green(`  Generated ${skills.length} skills:\n`));
    for (const skill of skills) {
      console.log(`  ${chalk.cyan(`/${skill.name}`)} - ${skill.description}`);
    }

    console.log(chalk.gray(`\n  Skills written to: ${outputDir}`));
    console.log(chalk.cyan("\n  Claude Code can now use these skills automatically!\n"));

    storage.close();
  });

// ============ Stats Command ============

program
  .command("stats")
  .description("Show statistics about the analyzed codebase")
  .argument("[path]", "Path to the project root", ".")
  .action(async (path: string) => {
    const rootPath = resolve(path);
    const dbPath = join(rootPath, ".codemap", "graph.db");

    if (!existsSync(dbPath)) {
      console.error(chalk.red("\n  Error: No graph database found."));
      console.error(chalk.gray("  Run 'codemap scan' first to analyze your codebase.\n"));
      process.exit(1);
    }

    const storage = new GraphStorage(dbPath);
    const stats = storage.getStats();
    const analyzedAt = storage.getMeta("analyzedAt");

    console.log(chalk.blue.bold("\n  Codebase Statistics\n"));
    console.log(`  ${chalk.bold("Last analyzed:")} ${analyzedAt || "unknown"}`);
    console.log();
    console.log(`  ${chalk.bold("Total files:")}     ${stats.totalFiles}`);
    console.log(`  ${chalk.bold("Total nodes:")}     ${stats.totalNodes}`);
    console.log(`  ${chalk.bold("Total edges:")}     ${stats.totalEdges}`);

    console.log(chalk.blue("\n  By Type:\n"));
    for (const [type, count] of Object.entries(stats.nodesByType)) {
      console.log(`  ${chalk.gray("-")} ${type}: ${count}`);
    }

    console.log(chalk.blue("\n  By Language:\n"));
    for (const [lang, count] of Object.entries(stats.languages)) {
      console.log(`  ${chalk.gray("-")} ${lang}: ${count}`);
    }

    console.log(chalk.blue("\n  Relationships:\n"));
    for (const [type, count] of Object.entries(stats.edgesByType)) {
      console.log(`  ${chalk.gray("-")} ${type}: ${count}`);
    }

    console.log();
    storage.close();
  });

// ============ Affected Command ============

program
  .command("affected")
  .description("Show files that would be affected by changes to a target")
  .argument("<target>", "File path or function/class name")
  .option("-d, --depth <n>", "Maximum dependency depth to follow", "2")
  .option("-p, --path <path>", "Project root path", ".")
  .action(async (target: string, options) => {
    const rootPath = resolve(options.path);
    const dbPath = join(rootPath, ".codemap", "graph.db");

    if (!existsSync(dbPath)) {
      console.error(chalk.red("\n  Error: No graph database found."));
      console.error(chalk.gray("  Run 'codemap scan' first to analyze your codebase.\n"));
      process.exit(1);
    }

    const storage = new GraphStorage(dbPath);
    const depth = parseInt(options.depth, 10);

    console.log(chalk.blue.bold(`\n  Impact Analysis: ${target}\n`));

    // Find the target
    const nodes = storage.searchNodes(target);
    if (nodes.length === 0) {
      console.log(chalk.yellow(`  No matches found for "${target}"\n`));
      storage.close();
      return;
    }

    const targetNode = nodes[0];
    console.log(
      chalk.gray(`  Target: ${targetNode.name} (${targetNode.type}) in ${targetNode.filePath}\n`)
    );

    // Find affected files
    const affected: Set<string> = new Set();

    // Check who imports this file
    const importers = storage.getFilesThatImport(
      targetNode.filePath.replace(/\.(ts|tsx|js|jsx|py)$/, "")
    );
    for (const imp of importers) {
      affected.add(imp);
    }

    // Check callers
    const callers = storage.getCallers(targetNode.name);
    for (const caller of callers) {
      affected.add(caller.filePath);
    }

    const affectedList = [...affected].filter((f) => f !== targetNode.filePath);

    if (affectedList.length === 0) {
      console.log(chalk.green("  No affected files found\n"));
    } else {
      console.log(chalk.yellow(`  Affected files (${affectedList.length}):\n`));
      for (const file of affectedList) {
        console.log(`  ${chalk.gray("-")} ${file}`);
      }
      console.log();
    }

    storage.close();
  });

// ============ Serve Command ============

program
  .command("serve")
  .description("Start the web visualization server")
  .argument("[path]", "Path to the project root", ".")
  .option("-p, --port <port>", "Port to run the server on", "3333")
  .action(async (path: string, options) => {
    const rootPath = resolve(path);
    const dbPath = join(rootPath, ".codemap", "graph.db");

    if (!existsSync(dbPath)) {
      console.error(chalk.red("\n  Error: No graph database found."));
      console.error(chalk.gray("  Run 'codemap scan' first to analyze your codebase.\n"));
      process.exit(1);
    }

    console.log(chalk.blue.bold("\n  CodeMap Visualization Server\n"));

    // Dynamically import and start the server
    const { startServer } = await import("./web/server.js");
    startServer(dbPath, parseInt(options.port, 10));
  });

// ============ MCP Server Command ============

program
  .command("mcp-server")
  .description("Start the MCP server for Claude Code integration")
  .option("-p, --path <path>", "Project root path", ".")
  .action(async (options) => {
    process.env.CODEMAP_PROJECT_ROOT = resolve(options.path);
    process.env.CODEMAP_DB_PATH = join(resolve(options.path), ".codemap", "graph.db");
    process.env.CODEMAP_SEMANTIC_DB_PATH = join(resolve(options.path), ".codemap", "semantic.db");

    // Dynamically import and run the MCP server
    await import("./mcp/server.js");
  });

// ============ Index Command (Semantic AI Indexing) ============

program
  .command("index")
  .description("Create semantic index of codebase using Claude AI")
  .argument("[path]", "Path to the project root", ".")
  .option("-m, --model <model>", "Claude model to use (haiku, sonnet, opus)", "haiku")
  .option("-f, --force", "Force re-index all files (ignore cache)")
  .option("--include <patterns...>", "Glob patterns to include")
  .option("--exclude <patterns...>", "Glob patterns to exclude")
  .action(async (path: string, options) => {
    const rootPath = resolve(path);
    const outputDir = join(rootPath, ".codemap");

    console.log(chalk.blue.bold("\n  CodeMap Semantic Indexer\n"));
    console.log(chalk.gray(`  Project: ${rootPath}`));
    console.log(chalk.gray(`  Model:   claude-${options.model}`));
    console.log(chalk.gray(`  Mode:    ${options.force ? "Full reindex" : "Incremental"}\n`));

    // Create output directory
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const dbPath = join(outputDir, "semantic.db");
    const storage = new SemanticStorage(dbPath);

    const indexer = new SemanticIndexer(storage, {
      rootPath,
      include: options.include || DEFAULT_CONFIG.include!,
      exclude: options.exclude || DEFAULT_CONFIG.exclude!,
      model: options.model,
      concurrency: 1,
      forceReindex: options.force || false,
    });

    const spinner = ora("Discovering files...").start();

    indexer.setProgressCallback((progress) => {
      switch (progress.phase) {
        case "discovering":
          spinner.text = "Discovering files...";
          break;
        case "analyzing":
          spinner.text = `Analyzing (${progress.current}/${progress.total}): ${progress.currentFile}`;
          break;
        case "summarizing":
          spinner.text = "Generating summaries...";
          break;
        case "complete":
          spinner.succeed(chalk.green("Indexing complete!"));
          break;
      }
    });

    try {
      const result = await indexer.index();
      const stats = storage.getStats();

      console.log(chalk.blue("\n  Results:\n"));
      console.log(`  ${chalk.bold("Indexed:")}  ${result.indexed} files`);
      console.log(`  ${chalk.bold("Skipped:")} ${result.skipped} files (unchanged)`);
      console.log(`  ${chalk.bold("Entries:")} ${stats.totalEntries} functions/classes`);

      if (result.errors.length > 0) {
        console.log(chalk.yellow(`\n  Errors: ${result.errors.length} files failed`));
        for (const err of result.errors.slice(0, 5)) {
          console.log(chalk.gray(`    - ${err}`));
        }
        if (result.errors.length > 5) {
          console.log(chalk.gray(`    ... and ${result.errors.length - 5} more`));
        }
      }

      console.log(chalk.gray(`\n  Database saved to: ${dbPath}\n`));
    } catch (error) {
      spinner.fail(chalk.red("Indexing failed"));
      console.error(error);
      process.exit(1);
    } finally {
      storage.close();
    }
  });

// ============ Init Command (All-in-One) ============

program
  .command("init")
  .description("Initialize CodeMap: scan, generate skills, and add MCP server to Claude Code")
  .argument("[path]", "Path to the project root", ".")
  .option("--name <name>", "Project name for skill descriptions")
  .option("--skip-mcp", "Skip adding MCP server to Claude Code")
  .action(async (path: string, options) => {
    const rootPath = resolve(path);
    const projectName = options.name || basename(rootPath);

    console.log(chalk.blue.bold("\n  ╔═══════════════════════════════════════╗"));
    console.log(chalk.blue.bold("  ║         CodeMap Initialization        ║"));
    console.log(chalk.blue.bold("  ╚═══════════════════════════════════════╝\n"));
    console.log(chalk.gray(`  Project: ${projectName}`));
    console.log(chalk.gray(`  Path:    ${rootPath}\n`));

    // Step 1: Scan
    console.log(chalk.cyan("  Step 1/3: Scanning codebase...\n"));

    const outputDir = join(rootPath, ".codemap");
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const dbPath = join(outputDir, "graph.db");
    const storage = new GraphStorage(dbPath);

    const config: CodeMapConfig = {
      rootPath,
      include: DEFAULT_CONFIG.include!,
      exclude: DEFAULT_CONFIG.exclude!,
      languages: DEFAULT_CONFIG.languages!,
      dbPath,
      skillsOutputDir: join(rootPath, ".claude", "skills"),
    };

    const builder = new GraphBuilder(storage, config);
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
          spinner.text = "Resolving cross-file references...";
          break;
        case "complete":
          spinner.succeed(chalk.green("Scan complete!"));
          break;
      }
    });

    try {
      const result = await builder.scan();
      let scanSummary = `\n  Found ${result.totalNodes} code elements in ${result.files.length} files`;
      if (result.parseErrors && result.parseErrors.length > 0) {
        scanSummary += chalk.yellow(` (${result.parseErrors.length} files skipped)`);
      }
      console.log(chalk.gray(scanSummary + "\n"));

      // Step 2: Generate Skills
      console.log(chalk.cyan("  Step 2/3: Generating Claude Code skills...\n"));

      const skillSpinner = ora("Generating skills...").start();

      const generator = new SkillGenerator(storage, {
        projectName,
        outputDir: join(rootPath, ".claude", "skills"),
        includeArchitecture: true,
        includePatterns: true,
        includeDependencies: true,
      });

      const skills = generator.generateAll();
      skillSpinner.succeed(chalk.green(`Generated ${skills.length} skills`));

      for (const skill of skills) {
        console.log(chalk.gray(`    /${skill.name} - ${skill.description}`));
      }

      storage.close();

      // Step 3: Add MCP Server to Claude Code
      if (!options.skipMcp) {
        console.log(chalk.cyan("\n  Step 3/3: Adding MCP server to Claude Code...\n"));

        const mcpSpinner = ora("Configuring MCP server...").start();

        try {
          const { execSync } = await import("child_process");

          // Check if claude command exists
          try {
            execSync("which claude", { stdio: "pipe" });
          } catch {
            mcpSpinner.warn(chalk.yellow("Claude CLI not found. Skipping MCP setup."));
            console.log(chalk.gray("    To add manually later, run:"));
            console.log(chalk.cyan(`    claude mcp add codemap -- npx codemap-ai mcp-server --path ${rootPath}\n`));
            return;
          }

          // Add MCP server
          const mcpCommand = `claude mcp add codemap -- npx codemap-ai mcp-server --path "${rootPath}"`;

          try {
            execSync(mcpCommand, { stdio: "pipe" });
            mcpSpinner.succeed(chalk.green("MCP server added to Claude Code!"));
          } catch (error: any) {
            // Check if already exists
            if (error.message?.includes("already exists")) {
              mcpSpinner.warn(chalk.yellow("MCP server 'codemap' already configured"));
            } else {
              mcpSpinner.warn(chalk.yellow("Could not auto-add MCP server"));
              console.log(chalk.gray("    To add manually, run:"));
              console.log(chalk.cyan(`    claude mcp add codemap -- npx codemap-ai mcp-server --path ${rootPath}\n`));
            }
          }
        } catch {
          mcpSpinner.warn(chalk.yellow("Could not configure MCP server automatically"));
          console.log(chalk.gray("    To add manually, run:"));
          console.log(chalk.cyan(`    claude mcp add codemap -- npx codemap-ai mcp-server --path ${rootPath}\n`));
        }
      } else {
        console.log(chalk.gray("\n  Skipping MCP setup (--skip-mcp flag)\n"));
      }

      // Done!
      console.log(chalk.green.bold("\n  ✓ CodeMap initialized successfully!\n"));
      console.log(chalk.white("  Available commands:"));
      console.log(chalk.gray("    codemap serve          - Start web visualization"));
      console.log(chalk.gray("    codemap stats          - Show codebase statistics"));
      console.log(chalk.gray("    codemap affected <file> - Analyze impact of changes\n"));
      console.log(chalk.white("  Available skills (type in Claude Code):"));
      console.log(chalk.gray("    /architecture   - Project overview"));
      console.log(chalk.gray("    /patterns       - Code patterns and conventions"));
      console.log(chalk.gray("    /impact <file>  - Change impact analysis"));
      console.log(chalk.gray("    /navigate       - Find code in codebase"));
      console.log(chalk.gray("    /dependencies   - Explore imports/exports\n"));

    } catch (error) {
      spinner.fail(chalk.red("Initialization failed"));
      console.error(error);
      storage.close();
      process.exit(1);
    }
  });

// Parse and run
program.parse();
