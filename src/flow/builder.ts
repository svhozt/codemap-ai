/**
 * Flow Builder - Builds call graphs with resolved references
 * Core implementation for CodeMap Flow Edition
 */

import { existsSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { glob } from "glob";
import { resolve, relative, extname, isAbsolute } from "path";
import { FlowStorage } from "./storage.js";
import { CallResolver } from "./resolver.js";
import { parserRegistry } from "../parsers/index.js";
import { MAX_FILE_SIZE, SUPPORTED_EXTENSIONS } from "../types.js";
import type { GraphNode } from "../types.js";
import { analyzeFileForPhase3 } from "./phase3-analyzer.js";

export interface FlowConfig {
  rootPath: string;
  include: string[];
  exclude: string[];
  forceReindex: boolean;
  /**
   * Restrict the run to these files (absolute, or relative to `rootPath`).
   * Only files that also match `include`/`exclude` are indexed; files in the
   * list that no longer exist are removed from the index. Other indexed files
   * are left untouched. Used for incremental updates.
   */
  files?: string[];
}

export interface FlowProgress {
  phase: "discovering" | "parsing" | "resolving" | "complete";
  total: number;
  current: number;
  currentFile: string;
}

export type ProgressCallback = (progress: FlowProgress) => void;

export interface FlowBuildResult {
  /** Files parsed in this run. */
  indexed: number;
  /** Files left alone because their content hash was unchanged. */
  skipped: number;
  /** Resolved call edges in the whole index. */
  resolved: number;
  /** Unresolved call edges in the whole index (external libraries, dynamic calls). */
  unresolved: number;
  /** One message per file that could not be read or parsed. */
  errors: string[];
  /** Files dropped from the index because they were deleted or are no longer matched. */
  removed: number;
  /** Files skipped because they are larger than the size limit (paths relative to the root). */
  tooLarge: string[];
  /** True when an index from an older codemap-ai version was discarded and rebuilt. */
  rebuilt: boolean;
}

const SUPPORTED = new Set<string>(SUPPORTED_EXTENSIONS);

/** Forward slashes everywhere, so ids are the same on every platform. */
function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export class FlowBuilder {
  private storage: FlowStorage;
  private config: FlowConfig;
  private onProgress?: ProgressCallback;
  private errors: string[] = [];
  private tooLarge: string[] = [];

  constructor(storage: FlowStorage, config: FlowConfig) {
    this.storage = storage;
    this.config = config;
  }

  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  async build(): Promise<FlowBuildResult> {
    const rootPath = toPosix(resolve(this.config.rootPath));
    this.errors = [];
    this.tooLarge = [];

    // An index written by an older, incompatible version is rebuilt from scratch.
    let restrictTo = this.config.files;
    let force = this.config.forceReindex;
    const rebuilt = this.storage.isIndexOutdated();
    if (rebuilt) {
      this.storage.clear();
      restrictTo = undefined;
      force = true;
    }

    // Phase 1: Discover files
    this.emitProgress({ phase: "discovering", total: 0, current: 0, currentFile: "" });

    const discovered = await this.discoverFiles(rootPath);
    let candidates = discovered;
    let removed = 0;

    if (restrictTo) {
      // Incremental run: only the listed files are considered.
      const wanted = new Set(
        restrictTo.map((f) => toPosix(isAbsolute(f) ? f : resolve(rootPath, f)))
      );
      candidates = discovered.filter((f) => wanted.has(f));
      for (const file of wanted) {
        if (!existsSync(file) && this.storage.getFileHash(file) !== null) {
          this.storage.deleteFileData(file);
          removed++;
        }
      }
    } else {
      // Full run: forget files that are gone or no longer matched by the patterns.
      const current = new Set(discovered);
      for (const file of this.storage.getIndexedFiles()) {
        if (!current.has(file)) {
          this.storage.deleteFileData(file);
          removed++;
        }
      }
    }

    // Check which files need indexing
    const filesToIndex: Array<{ path: string; hash: string; content: string }> = [];
    let skipped = 0;

    for (const filePath of candidates) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch (error) {
        this.errors.push(`${relative(rootPath, filePath)}: ${errorMessage(error)}`);
        continue;
      }
      const hash = this.hashContent(content);

      if (!force && this.storage.getFileHash(filePath) === hash) {
        skipped++;
        continue;
      }

      filesToIndex.push({ path: filePath, hash, content });
    }

    // Phase 2: Parse files and extract symbols
    let indexed = 0;
    for (const file of filesToIndex) {
      this.emitProgress({
        phase: "parsing",
        total: filesToIndex.length,
        current: indexed + 1,
        currentFile: relative(rootPath, file.path),
      });

      try {
        this.storage.transaction(() => this.parseAndStore(file.path, file.hash, file.content));
        indexed++;
      } catch (error) {
        this.errors.push(`${relative(rootPath, file.path)}: ${errorMessage(error)}`);
      }
    }

    // Phase 3: Resolve references across files
    this.emitProgress({
      phase: "resolving",
      total: filesToIndex.length,
      current: filesToIndex.length,
      currentFile: "",
    });

    new CallResolver(this.storage, rootPath).resolveAll();
    this.storage.markIndexFormatCurrent();
    if (!restrictTo) {
      this.storage.setIndexPatterns(this.config.include, this.config.exclude);
    }

    const stats = this.storage.getStats();

    this.emitProgress({
      phase: "complete",
      total: filesToIndex.length,
      current: filesToIndex.length,
      currentFile: "",
    });

    return {
      indexed,
      skipped,
      resolved: stats.resolvedCalls,
      unresolved: stats.unresolvedCalls,
      errors: this.errors,
      removed,
      tooLarge: this.tooLarge,
      rebuilt,
    };
  }

  private async discoverFiles(rootPath: string): Promise<string[]> {
    const allFiles: string[] = [];

    for (const pattern of this.config.include) {
      const matches = await glob(pattern, {
        cwd: rootPath,
        absolute: true,
        ignore: this.config.exclude,
        nodir: true,
      });
      allFiles.push(...matches.map(toPosix));
    }

    // Filter by supported extensions and size
    const uniqueFiles = [...new Set(allFiles)].filter((f) => {
      if (!SUPPORTED.has(extname(f).toLowerCase())) return false;

      try {
        const stats = statSync(f);
        if (!stats.isFile()) return false;
        if (stats.size > MAX_FILE_SIZE) {
          this.tooLarge.push(relative(rootPath, f));
          return false;
        }
      } catch {
        return false;
      }
      return true;
    });

    return uniqueFiles.sort();
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex").substring(0, 16);
  }

  private parseAndStore(filePath: string, hash: string, content: string): void {
    const parser = parserRegistry.getForFile(filePath);
    if (!parser) {
      throw new Error(`No parser found for file type: ${extname(filePath)}`);
    }

    // Parse with tree-sitter
    const analysis = parser.parse(filePath, content);

    // Delete old data for this file
    this.storage.deleteFileData(filePath);

    const fileNode = analysis.nodes.find((n) => n.type === "file");
    const topLevelIds = new Set(
      analysis.edges
        .filter((e) => e.type === "contains" && e.sourceId === fileNode?.id)
        .map((e) => e.targetId)
    );
    const byName = new Map<string, GraphNode>();

    for (const node of analysis.nodes) {
      const nodeHash = this.hashContent(`${node.name}:${node.startLine}:${node.endLine}`);
      this.storage.insertNode({ ...node, hash: nodeHash });

      // Module-level functions, classes and namespace objects are importable by name.
      if (
        topLevelIds.has(node.id) &&
        (node.type === "function" || node.type === "class" || node.type === "variable")
      ) {
        if (!byName.has(node.name) || node.type !== "variable") byName.set(node.name, node);
      }
    }

    for (const [name, node] of byName) {
      this.storage.registerExport(filePath, name, node.id);
    }

    // Explicit exports: default exports, renamed exports and CommonJS members.
    for (const exp of analysis.exports) {
      const localName = exp.localName ?? exp.name;
      const target =
        byName.get(localName) ??
        analysis.nodes.find(
          (n) => n.name === localName && n.type === "function" && n.metadata?.memberOf === "default"
        );
      if (!target) continue;
      if (exp.isDefault) {
        this.storage.registerExport(filePath, "default", target.id);
      } else if (exp.name !== target.name || !byName.has(exp.name)) {
        this.storage.registerExport(filePath, exp.name, target.id);
      }
    }

    // Store edges (including unresolved refs)
    for (const edge of analysis.edges) {
      this.storage.insertEdge(edge);
    }

    // Store imports
    for (const imp of analysis.imports) {
      for (const spec of imp.specifiers) {
        this.storage.registerImport(
          filePath,
          spec,
          imp.source,
          imp.line,
          imp.aliases?.[spec] ?? null,
          imp.isReExport === true
        );
      }
    }

    // Store variable types
    if (analysis.variableTypes) {
      for (const varType of analysis.variableTypes) {
        this.storage.registerVariableType(
          varType.variableName,
          varType.typeName,
          varType.scopeId,
          filePath,
          varType.line
        );
      }
    }

    // Data flow: property accesses and return shapes of functions and methods
    const functionNodes = analysis.nodes
      .filter((n) => n.type === "function" || n.type === "method")
      .map((n) => ({
        id: n.id,
        name: n.name,
        startLine: n.startLine,
        endLine: n.endLine,
      }));

    if (functionNodes.length > 0) {
      const tree = parser.getLastTree?.(filePath) ?? null;
      analyzeFileForPhase3(filePath, functionNodes, this.storage.db, tree);
    }

    // Store database operations
    if (analysis.databaseOperations) {
      let seq = 0;
      for (const dbOp of analysis.databaseOperations) {
        this.storage.insertDatabaseOperation({
          id: `${dbOp.nodeId}:db:${dbOp.line}:${seq++}`,
          node_id: dbOp.nodeId,
          database_type: dbOp.databaseType,
          operation: dbOp.operation,
          collection: dbOp.collection,
          line: dbOp.line,
        });
      }
    }

    // Store file record
    this.storage.upsertFile(filePath, analysis.language, hash);

    // Process framework-specific patterns
    this.processFrameworkPatterns(analysis.nodes, filePath);
  }

  /**
   * Process framework-specific patterns (FastAPI routes, Depends, etc.)
   */
  private processFrameworkPatterns(nodes: GraphNode[], filePath: string): void {
    for (const node of nodes) {
      if (node.type === "function" && node.metadata) {
        // 1. Process FastAPI HTTP endpoints
        const httpEndpoint = node.metadata.httpEndpoint as { method: string; path: string } | undefined;
        if (httpEndpoint) {
          this.storage.insertHttpEndpoint({
            // The handler is part of the id: two routers may serve the same path.
            id: `${httpEndpoint.method}:${httpEndpoint.path}:${node.id}`,
            method: httpEndpoint.method,
            path: httpEndpoint.path,
            handler_node_id: node.id,
            container_id: undefined,
            metadata: {
              filePath,
              functionName: node.name,
              line: node.startLine,
            },
          });
        }

        // 2. Process FastAPI Depends() patterns
        const depends = node.metadata.depends as Array<{
          parameterName: string;
          dependencyName: string;
          line: number;
        }> | undefined;

        if (depends) {
          for (const dep of depends) {
            const depId = `${node.id}:depends:${dep.parameterName}`;
            this.storage.insertFrameworkDependency({
              id: depId,
              source_node_id: node.id,
              target_node_id: undefined, // Resolved after all files are parsed
              framework: "fastapi",
              pattern: "depends",
              parameter_name: dep.parameterName,
              line: dep.line,
              unresolved_name: dep.dependencyName,
              metadata: {
                filePath,
                functionName: node.name,
              },
            });
          }
        }
      }
    }
  }

  private emitProgress(progress: FlowProgress): void {
    if (this.onProgress) {
      this.onProgress(progress);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
