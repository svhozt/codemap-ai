/**
 * Semantic Indexer - Uses Claude CLI to generate descriptions for code
 * Implements incremental updates with hash-based change detection
 */

import { execSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { glob } from "glob";
import { resolve, relative, dirname, basename } from "path";
import { SemanticStorage, SemanticEntry, FileIndex } from "./storage.js";

export interface IndexProgress {
  phase: "discovering" | "analyzing" | "summarizing" | "complete";
  total: number;
  current: number;
  currentFile: string;
  skipped: number;
}

export type ProgressCallback = (progress: IndexProgress) => void;

export interface IndexConfig {
  rootPath: string;
  include: string[];
  exclude: string[];
  model: string;
  concurrency: number;
  forceReindex: boolean;
}

interface AnalysisResult {
  file: string;
  description: string;
  entries: Array<{
    name: string;
    type: "function" | "class" | "method";
    startLine: number;
    endLine: number;
    description: string;
    calls: string[];
  }>;
}

export class SemanticIndexer {
  private storage: SemanticStorage;
  private config: IndexConfig;
  private onProgress?: ProgressCallback;
  private errors: string[] = [];

  constructor(storage: SemanticStorage, config: IndexConfig) {
    this.storage = storage;
    this.config = config;
  }

  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  async index(): Promise<{
    indexed: number;
    skipped: number;
    errors: string[];
  }> {
    const rootPath = resolve(this.config.rootPath);

    // Phase 1: Discover files
    this.emitProgress({
      phase: "discovering",
      total: 0,
      current: 0,
      currentFile: "",
      skipped: 0,
    });

    const files = await this.discoverFiles(rootPath);
    const filesToIndex: Array<{ path: string; hash: string }> = [];
    let skipped = 0;

    // Check which files need indexing
    for (const filePath of files) {
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

    // Phase 2: Analyze files with Claude
    let indexed = 0;

    for (const file of filesToIndex) {
      this.emitProgress({
        phase: "analyzing",
        total: filesToIndex.length,
        current: indexed + 1,
        currentFile: relative(rootPath, file.path),
        skipped,
      });

      try {
        await this.analyzeFile(file.path, file.hash, rootPath);
        indexed++;
      } catch (error) {
        this.errors.push(`${relative(rootPath, file.path)}: ${error}`);
      }
    }

    // Phase 3: Generate directory summaries
    this.emitProgress({
      phase: "summarizing",
      total: filesToIndex.length,
      current: filesToIndex.length,
      currentFile: "",
      skipped,
    });

    await this.generateDirectorySummaries(rootPath);

    // Store metadata
    this.storage.setMeta("rootPath", rootPath);
    this.storage.setMeta("indexedAt", new Date().toISOString());
    this.storage.setMeta("model", this.config.model);

    this.emitProgress({
      phase: "complete",
      total: filesToIndex.length,
      current: filesToIndex.length,
      currentFile: "",
      skipped,
    });

    return { indexed, skipped, errors: this.errors };
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

    // Deduplicate and filter by supported extensions
    const supportedExts = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
    const uniqueFiles = [...new Set(allFiles)].filter((f) => {
      const ext = f.substring(f.lastIndexOf("."));
      // Skip very large files (>100KB)
      try {
        const stats = statSync(f);
        if (stats.size > 100000) return false;
      } catch {
        return false;
      }
      return supportedExts.has(ext);
    });

    return uniqueFiles.sort();
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex").substring(0, 16);
  }

  private async analyzeFile(filePath: string, hash: string, rootPath: string): Promise<void> {
    const content = readFileSync(filePath, "utf-8");
    const relativePath = relative(rootPath, filePath);

    // Skip very short files
    if (content.trim().length < 50) {
      return;
    }

    const prompt = this.buildAnalysisPrompt(relativePath, content);
    const result = await this.callClaude(prompt);

    if (!result) {
      throw new Error("Empty response from Claude");
    }

    const analysis = this.parseAnalysisResult(result, filePath);

    // Delete old entries for this file
    this.storage.deleteEntriesByFile(filePath);

    // Insert new entries
    const entryIds: string[] = [];
    for (const entry of analysis.entries) {
      const entryHash = this.hashContent(`${entry.name}:${entry.startLine}:${entry.endLine}`);
      const id = `${relativePath}:${entry.name}:${entryHash}`;

      const semanticEntry: SemanticEntry = {
        id,
        filePath,
        name: entry.name,
        type: entry.type,
        startLine: entry.startLine,
        endLine: entry.endLine,
        description: entry.description,
        calls: entry.calls,
        calledBy: [], // Will be populated during cross-reference phase
        hash: entryHash,
        indexedAt: new Date().toISOString(),
      };

      this.storage.insertEntry(semanticEntry);
      entryIds.push(id);
    }

    // Insert file record
    const fileIndex: FileIndex = {
      path: filePath,
      hash,
      description: analysis.description,
      entries: entryIds,
      indexedAt: new Date().toISOString(),
    };

    this.storage.insertFile(fileIndex);
  }

  private buildAnalysisPrompt(relativePath: string, content: string): string {
    // Truncate very long files to first 200 lines for description
    const lines = content.split("\n");
    const truncated = lines.length > 200 ? lines.slice(0, 200).join("\n") + "\n...(truncated)" : content;

    return `Analyze this code file and provide a JSON response.

File: ${relativePath}

\`\`\`
${truncated}
\`\`\`

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "file": "${relativePath}",
  "description": "One sentence describing what this file does",
  "entries": [
    {
      "name": "functionOrClassName",
      "type": "function|class|method",
      "startLine": 1,
      "endLine": 10,
      "description": "One sentence describing what this does",
      "calls": ["otherFunction", "SomeClass.method"]
    }
  ]
}

Rules:
- description: Be concise, explain PURPOSE not implementation
- entries: List main functions/classes (skip tiny helpers, imports, constants)
- calls: List significant function/method calls (skip built-ins like print, console.log)
- startLine/endLine: Approximate line numbers
- Keep descriptions under 100 chars`;
  }

  private async callClaude(prompt: string): Promise<string> {
    try {
      // Use execSync for simpler execution
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const command = `claude -p '${escapedPrompt}' --model ${this.config.model} --output-format text --max-turns 1`;

      const result = execSync(command, {
        encoding: "utf-8",
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      return result.trim();
    } catch (error: any) {
      throw new Error(`Claude CLI failed: ${error.message || "Unknown error"}`);
    }
  }

  private parseAnalysisResult(result: string, filePath: string): AnalysisResult {
    // Extract JSON from response (handle potential markdown wrapping)
    let jsonStr = result;

    // Remove markdown code blocks if present
    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    // Try to find JSON object
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      jsonStr = objectMatch[0];
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        file: parsed.file || filePath,
        description: parsed.description || "No description",
        entries: (parsed.entries || []).map((e: Record<string, unknown>) => ({
          name: e.name || "unknown",
          type: e.type || "function",
          startLine: e.startLine || 1,
          endLine: e.endLine || 1,
          description: e.description || "No description",
          calls: Array.isArray(e.calls) ? e.calls : [],
        })),
      };
    } catch {
      // Fallback: create minimal entry for the file
      return {
        file: filePath,
        description: "Analysis failed - file structure unclear",
        entries: [],
      };
    }
  }

  private async generateDirectorySummaries(rootPath: string): Promise<void> {
    const files = this.storage.getAllFiles();

    // Group files by directory
    const dirFiles = new Map<string, FileIndex[]>();
    for (const file of files) {
      const dir = dirname(relative(rootPath, file.path));
      if (!dirFiles.has(dir)) {
        dirFiles.set(dir, []);
      }
      dirFiles.get(dir)!.push(file);
    }

    // Generate summary for each directory with enough files
    for (const [dir, files] of dirFiles) {
      if (files.length < 2) continue;

      const descriptions = files
        .map((f) => `${basename(f.path)}: ${f.description}`)
        .join("\n");

      // For now, create a simple summary without calling Claude
      // This keeps directory summaries fast
      const summary = `Contains ${files.length} files: ${files.map(f => basename(f.path)).join(", ")}`;
      this.storage.setDirectorySummary(dir, summary, files.length);
    }
  }

  private emitProgress(progress: IndexProgress): void {
    if (this.onProgress) {
      this.onProgress(progress);
    }
  }
}
