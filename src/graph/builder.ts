/**
 * Graph builder - scans codebase and builds the knowledge graph
 */

import { readFileSync, statSync } from "fs";
import { glob } from "glob";
import { join, relative, resolve } from "path";
import { parserRegistry } from "../parsers/index.js";
import { GraphStorage } from "./storage.js";
import type { CodeMapConfig, FileAnalysis, ProjectAnalysis } from "../types.js";

export interface ScanProgress {
  total: number;
  current: number;
  currentFile: string;
  phase: "discovering" | "parsing" | "resolving" | "complete";
}

export type ProgressCallback = (progress: ScanProgress) => void;

export class GraphBuilder {
  private storage: GraphStorage;
  private config: CodeMapConfig;
  private onProgress?: ProgressCallback;
  private parseErrors: string[] = [];

  constructor(storage: GraphStorage, config: CodeMapConfig) {
    this.storage = storage;
    this.config = config;
  }

  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  async scan(): Promise<ProjectAnalysis> {
    const rootPath = resolve(this.config.rootPath);

    // Phase 1: Discover files
    this.emitProgress({ total: 0, current: 0, currentFile: "", phase: "discovering" });

    const files = await this.discoverFiles(rootPath);

    // Phase 2: Parse files
    const fileAnalyses: FileAnalysis[] = [];
    let current = 0;

    for (const filePath of files) {
      current++;
      this.emitProgress({
        total: files.length,
        current,
        currentFile: relative(rootPath, filePath),
        phase: "parsing",
      });

      try {
        const analysis = this.parseFile(filePath);
        if (analysis) {
          fileAnalyses.push(analysis);
          this.storage.insertFileAnalysis(analysis);
        }
      } catch {
        // Silently collect errors, show summary at end
        this.parseErrors.push(relative(rootPath, filePath));
      }
    }

    // Phase 3: Resolve cross-file references
    this.emitProgress({
      total: files.length,
      current: files.length,
      currentFile: "",
      phase: "resolving",
    });
    this.resolveReferences();

    // Store metadata
    const languages: Record<string, number> = {};
    for (const analysis of fileAnalyses) {
      languages[analysis.language] = (languages[analysis.language] || 0) + 1;
    }

    const stats = this.storage.getStats();

    this.storage.setMeta("rootPath", rootPath);
    this.storage.setMeta("analyzedAt", new Date().toISOString());
    this.storage.setMeta("totalFiles", String(files.length));

    this.emitProgress({
      total: files.length,
      current: files.length,
      currentFile: "",
      phase: "complete",
    });

    return {
      rootPath,
      files: fileAnalyses,
      totalNodes: stats.totalNodes,
      totalEdges: stats.totalEdges,
      languages,
      analyzedAt: new Date().toISOString(),
      parseErrors: this.parseErrors,
    };
  }

  private async discoverFiles(rootPath: string): Promise<string[]> {
    const patterns = this.config.include;
    const ignorePatterns = this.config.exclude;

    const allFiles: string[] = [];

    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: rootPath,
        absolute: true,
        ignore: ignorePatterns,
        nodir: true,
      });
      allFiles.push(...matches);
    }

    // Deduplicate and filter by supported extensions
    const supportedExts = new Set(parserRegistry.getSupportedExtensions());
    const uniqueFiles = [...new Set(allFiles)].filter((f) => {
      const ext = f.substring(f.lastIndexOf("."));
      return supportedExts.has(ext);
    });

    return uniqueFiles.sort();
  }

  private parseFile(filePath: string): FileAnalysis | null {
    const parser = parserRegistry.getForFile(filePath);
    if (!parser) {
      return null;
    }

    const content = readFileSync(filePath, "utf-8");
    return parser.parse(filePath, content);
  }

  private resolveReferences(): void {
    // Get all edges with unresolved references
    const allEdges = this.storage.getAllEdges();
    const allNodes = this.storage.getAllNodes();

    // Build a map of node names to node IDs
    const nodeNameMap = new Map<string, string[]>();
    for (const node of allNodes) {
      const existing = nodeNameMap.get(node.name) || [];
      existing.push(node.id);
      nodeNameMap.set(node.name, existing);
    }

    // Resolve references
    for (const edge of allEdges) {
      if (edge.targetId.startsWith("ref:")) {
        const refName = edge.targetId.substring(4);
        const candidates = nodeNameMap.get(refName);

        if (candidates && candidates.length > 0) {
          // For now, take the first match (could be smarter with scope resolution)
          // Update the edge in storage
          // Note: In a more complete implementation, we'd update the edge in the DB
        }
      }
    }
  }

  private emitProgress(progress: ScanProgress): void {
    if (this.onProgress) {
      this.onProgress(progress);
    }
  }
}

export { GraphStorage };
