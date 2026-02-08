/**
 * Flow Builder - Builds call graphs with resolved references
 * Core implementation for CodeMap Flow Edition
 */

import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { glob } from "glob";
import { resolve, relative, dirname, basename, extname } from "path";
import { FlowStorage } from "./storage.js";
import { EnhancedResolver } from "./enhanced-resolver.js";
import { parserRegistry } from "../parsers/index.js";
import type { FileAnalysis, GraphNode, GraphEdge } from "../types.js";
import { analyzeDataFlow, getPhase3Stats } from "./builder-phase3.js";
import { analyzeFileForPhase3 } from "./phase3-analyzer.js";

export interface FlowConfig {
  rootPath: string;
  include: string[];
  exclude: string[];
  forceReindex: boolean;
}

export interface FlowProgress {
  phase: "discovering" | "parsing" | "resolving" | "complete";
  total: number;
  current: number;
  currentFile: string;
}

export type ProgressCallback = (progress: FlowProgress) => void;

interface ModuleExports {
  [symbolName: string]: string; // symbol name → node ID
}

export class FlowBuilder {
  private storage: FlowStorage;
  private config: FlowConfig;
  private onProgress?: ProgressCallback;
  private moduleMap = new Map<string, ModuleExports>(); // file path → exports
  private errors: string[] = [];

  constructor(storage: FlowStorage, config: FlowConfig) {
    this.storage = storage;
    this.config = config;
  }

  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  async build(): Promise<{
    indexed: number;
    skipped: number;
    resolved: number;
    unresolved: number;
    errors: string[];
  }> {
    const rootPath = resolve(this.config.rootPath);

    // Phase 1: Discover files
    this.emitProgress({
      phase: "discovering",
      total: 0,
      current: 0,
      currentFile: "",
    });

    const allFiles = await this.discoverFiles(rootPath);
    const filesToIndex: Array<{ path: string; hash: string }> = [];
    let skipped = 0;

    // Check which files need indexing
    for (const filePath of allFiles) {
      const content = readFileSync(filePath, "utf-8");
      const hash = this.hashContent(content);

      if (!this.config.forceReindex) {
        const existingHash = this.storage.getFileHash(filePath);
        if (existingHash === hash) {
          skipped++;
          continue;
        }
      }

      filesToIndex.push({ path: filePath, hash });
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
        await this.parseAndStore(file.path, file.hash, rootPath);
        indexed++;
      } catch (error) {
        this.errors.push(`${relative(rootPath, file.path)}: ${error}`);
      }
    }

    // Phase 3: Resolve cross-file calls
    this.emitProgress({
      phase: "resolving",
      total: filesToIndex.length,
      current: filesToIndex.length,
      currentFile: "",
    });

    // First pass: Basic resolution (existing logic)
    this.resolveAllCalls();

    // Second pass: Enhanced resolution with type tracking
    const enhancedResolver = new EnhancedResolver(this.storage);
    enhancedResolver.buildHierarchy();
    const enhancedResolved = enhancedResolver.resolveAllCalls();

    // Log improvement
    if (enhancedResolved.length > 0) {
      console.log(`✨ Enhanced resolver: resolved ${enhancedResolved.length} additional calls`);
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
      allFiles.push(...matches);
    }

    // Filter by supported extensions and size
    const supportedExts = new Set([".py", ".ts", ".tsx", ".js", ".jsx"]);
    const uniqueFiles = [...new Set(allFiles)].filter((f) => {
      const ext = extname(f);
      if (!supportedExts.has(ext)) return false;

      try {
        const stats = statSync(f);
        if (stats.size > 200000) return false; // Skip files > 200KB
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

  private async parseAndStore(filePath: string, hash: string, rootPath: string): Promise<void> {
    const language = this.getLanguage(filePath);
    const content = readFileSync(filePath, "utf-8");

    // Get parser for this language
    const parser = parserRegistry.getByLanguage(language);
    if (!parser) {
      throw new Error(`No parser found for language: ${language}`);
    }

    // Parse with tree-sitter
    const analysis = parser.parse(filePath, content);

    // Delete old data for this file
    this.storage.deleteFileData(filePath);

    // Store nodes with hashes
    const fileExports: ModuleExports = {};

    for (const node of analysis.nodes) {
      // Add hash to node
      const nodeHash = this.hashContent(`${node.name}:${node.startLine}:${node.endLine}`);
      const nodeWithHash = { ...node, hash: nodeHash };

      this.storage.insertNode(nodeWithHash);

      // Track exports (top-level functions and classes)
      if (node.type === "function" || node.type === "class") {
        fileExports[node.name] = node.id;
        this.storage.registerExport(filePath, node.name, node.id);
      }
    }

    // Store exports in module map
    this.moduleMap.set(filePath, fileExports);

    // Store edges (including unresolved refs)
    for (const edge of analysis.edges) {
      this.storage.insertEdge(edge);
    }

    // Store imports
    for (const imp of analysis.imports) {
      for (const spec of imp.specifiers) {
        this.storage.registerImport(filePath, spec, imp.source, imp.line);
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

    // Phase 3: Analyze data flow for functions and methods
    const functionNodes = analysis.nodes
      .filter((n) => n.type === "function" || n.type === "method")
      .map((n) => ({
        id: n.id,
        name: n.name,
        startLine: n.startLine,
        endLine: n.endLine,
      }));

    if (functionNodes.length > 0) {
      analyzeFileForPhase3(filePath, functionNodes, this.storage.db);
    }

    // Store database operations
    if (analysis.databaseOperations) {
      for (const dbOp of analysis.databaseOperations) {
        this.storage.insertDatabaseOperation({
          id: `${dbOp.nodeId}:db:${dbOp.line}`,
          node_id: dbOp.nodeId,
          database_type: dbOp.databaseType,
          operation: dbOp.operation,
          collection: dbOp.collection,
          line: dbOp.line,
        });
      }
    }

    // Store file record
    this.storage.upsertFile(filePath, language, hash);

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
          const endpointId = `${httpEndpoint.method}:${httpEndpoint.path}`;
          this.storage.insertHttpEndpoint({
            id: endpointId,
            method: httpEndpoint.method,
            path: httpEndpoint.path,
            handler_node_id: node.id,
            container_id: undefined, // Will be set when docker-compose is parsed
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
              target_node_id: undefined, // Will be resolved later
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

  private resolveAllCalls(): void {
    // Get all unresolved edges (target_id starts with "ref:")
    const unresolvedEdges = this.storage.db
      .prepare(`SELECT * FROM edges WHERE target_id LIKE 'ref:%'`)
      .all() as Array<{
        id: string;
        source_id: string;
        target_id: string;
        type: string;
        metadata: string | null;
      }>;

    for (const edge of unresolvedEdges) {
      const refName = edge.target_id.replace("ref:", "");
      const sourceNode = this.storage.getNode(edge.source_id);

      if (!sourceNode) continue;

      // Try to resolve the reference (pass source node ID for scope resolution)
      const resolvedId = this.resolveReference(sourceNode.filePath, refName, edge.source_id);

      if (resolvedId) {
        // Update edge with resolved target
        this.storage.insertEdge({
          id: edge.id,
          type: edge.type as GraphEdge["type"],
          sourceId: edge.source_id,
          targetId: resolvedId,
          metadata: edge.metadata ? JSON.parse(edge.metadata) : undefined,
        });
      }
    }

    // Also resolve framework dependencies (FastAPI Depends)
    this.resolveFrameworkDependencies();
  }

  /**
   * Resolve framework dependencies (e.g., FastAPI Depends())
   */
  private resolveFrameworkDependencies(): void {
    const unresolvedDeps = this.storage.getAllUnresolvedDependencies();

    for (const dep of unresolvedDeps) {
      const sourceNode = this.storage.getNode(dep.source_node_id);
      if (!sourceNode) continue;

      // Try to resolve the dependency name to an actual node
      const resolvedId = this.resolveReference(sourceNode.filePath, dep.unresolved_name);

      if (resolvedId) {
        // Update the dependency with resolved target
        this.storage.updateFrameworkDependencyTarget(dep.id, resolvedId);

        // Also create an edge for the call graph
        this.storage.insertEdge({
          id: `${dep.id}:edge`,
          type: "calls",
          sourceId: dep.source_node_id,
          targetId: resolvedId,
          metadata: {
            framework: "fastapi",
            pattern: "depends",
            line: dep.line,
          },
        });
      }
    }
  }

  private resolveReference(sourceFilePath: string, refName: string, scopeNodeId?: string): string | null {
    // Strategy 0a: Handle super() calls
    if (refName.startsWith("super().") && scopeNodeId) {
      const methodName = refName.replace("super().", "");
      const resolvedSuper = this.storage.resolveSuperMethod(methodName, scopeNodeId);
      if (resolvedSuper) {
        return resolvedSuper;
      }
    }

    // Strategy 0b: Handle attribute calls (variable.method or ClassName.method)
    if (refName.includes(".")) {
      const parts = refName.split(".");
      if (parts.length === 2) {
        const [objectName, methodName] = parts;

        // Try variable.method resolution first (if we have scope)
        if (scopeNodeId) {
          const resolvedVarMethod = this.storage.resolveVariableMethod(objectName, methodName, scopeNodeId);
          if (resolvedVarMethod) {
            return resolvedVarMethod;
          }
        }

        // Fall back to ClassName.method resolution
        const resolvedClassMethod = this.storage.resolveClassMethod(objectName, methodName, sourceFilePath);
        if (resolvedClassMethod) {
          return resolvedClassMethod;
        }
      }
    }

    // Strategy 1: Look in the same file
    const nodesInFile = this.storage.getNodesByFile(sourceFilePath);
    for (const node of nodesInFile) {
      if (node.name === refName) {
        return node.id;
      }
    }

    // Strategy 2: Check imports
    const resolvedFromImport = this.storage.resolveImport(sourceFilePath, refName);
    if (resolvedFromImport) {
      return resolvedFromImport;
    }

    // Strategy 3: Search all nodes (fallback)
    const matches = this.storage.searchNodesByName(refName);
    if (matches.length === 1) {
      return matches[0].id;
    }

    return null;
  }

  private getLanguage(filePath: string): string {
    const ext = extname(filePath);
    if (ext === ".py") return "python";
    if (ext === ".ts" || ext === ".tsx") return "typescript";
    if (ext === ".js" || ext === ".jsx") return "javascript";
    return "unknown";
  }

  private emitProgress(progress: FlowProgress): void {
    if (this.onProgress) {
      this.onProgress(progress);
    }
  }
}
