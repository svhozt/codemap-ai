/**
 * Impact analysis command
 * Detects changes and calculates their impact on the codebase
 *
 * With git (the normal case) every changed file is compared with its version
 * in HEAD using the same parsers the indexer uses:
 *
 *   1. changed functions   - functions whose source differs from HEAD
 *   2. direct callers      - who calls them, from the call graph
 *   3. affected endpoints  - HTTP routes handled by a changed function or one
 *                            of its callers
 *   4. removed calls       - calls a function made in HEAD and no longer makes
 *   5. import issues       - imports removed while still used, unused imports
 *   6. data shape changes  - properties a function stopped returning that
 *                            other functions still read
 *   7. Docker impact       - changed entry points of docker-compose services
 *
 * Without git, files whose content hash differs from the index are reported
 * at file level only.
 */

import { existsSync, readFileSync } from "fs";
import { resolve, join, relative } from "path";
import { FlowStorage } from "../flow/storage.js";
import { FlowBuilder } from "../flow/builder.js";
import { CallResolver } from "../flow/resolver.js";
import { DEFAULT_CONFIG } from "../types.js";
import {
  isGitRepository,
  hasGitHead,
  getGitChangedFiles,
  getGitHeadContent,
  type GitChangedFile,
  type GitChangedFunction,
} from "../utils/git.js";
import { analyzeImports, type ImportAnalysisResult } from "../analysis/imports.js";
import {
  parseDockerCompose,
  calculateServiceBlastRadius,
  matchesEntryPoint,
} from "../analysis/docker.js";
import {
  snapshotFile,
  diffFunctions,
  findRemovedCalls,
  type FileSnapshot,
  type FunctionChange,
} from "../analysis/file-diff.js";
import { analyzeRemovedCallImpact, type RemovedCallImpact } from "../analysis/removed-call-impact.js";
import { compareObjectShapes } from "../analysis/return-analyzer.js";
import type { BreakingPropertyChange } from "../analysis/shape-change-detector.js";
import { parserRegistry } from "../parsers/index.js";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ImpactCaller {
  id: string;
  name: string;
  file: string;
  line: number;
}

export interface ImpactResult {
  /** Changed source files, relative to the project root. */
  changedFiles: string[];
  changedFunctions: GitChangedFunction[];
  /** Changed function display name -> resolved callers. */
  directCallers: Map<string, ImpactCaller[]>;
  affectedEndpoints: string[];
  importIssues: Map<string, ImportAnalysisResult>;
  dockerImpact?: {
    affectedServices: string[];
    entryPointFiles: string[];
  };
  removedCallImpacts: RemovedCallImpact[];
  /** Properties functions stopped returning while other code still reads them. */
  dataFlowChanges: BreakingPropertyChange[];
  riskLevel: RiskLevel;
  totalImpact: number;
  /** How changes were detected. */
  mode: "git" | "hash";
  /** Human-readable notes about limits of this analysis (e.g. no commits yet). */
  notes: string[];
}

export interface ImpactOptions {
  path?: string;
  verbose?: boolean;
}

function emptyResult(mode: ImpactResult["mode"], notes: string[] = []): ImpactResult {
  return {
    changedFiles: [],
    changedFunctions: [],
    directCallers: new Map(),
    affectedEndpoints: [],
    importIssues: new Map(),
    removedCallImpacts: [],
    dataFlowChanges: [],
    riskLevel: "LOW",
    totalImpact: 0,
    mode,
    notes,
  };
}

/**
 * Analyze impact of code changes
 */
export async function analyzeImpact(options: ImpactOptions = {}): Promise<ImpactResult> {
  const rootPath = resolve(options.path || ".");
  const dbPath = join(rootPath, ".codemap", "graph.db");
  if (!existsSync(dbPath)) {
    throw new Error("Not initialized. Run 'codemap init' first.");
  }
  const storage = new FlowStorage(dbPath);

  try {
    const outdated = storage.isIndexOutdated();
    let result: ImpactResult;
    if (isGitRepository(rootPath) && hasGitHead(rootPath)) {
      result = await analyzeImpactWithGit(storage, rootPath);
    } else {
      const notes = isGitRepository(rootPath)
        ? ["The repository has no commits yet, so changes were detected by comparing file hashes with the index."]
        : [];
      result = await analyzeImpactWithHash(storage, rootPath, notes);
    }
    if (outdated) {
      result.notes.unshift("The index was built by an older version of codemap-ai and has been rebuilt.");
    }
    return result;
  } finally {
    storage.close();
  }
}

/** Patterns the index was built with (falls back to the defaults). */
function indexPatterns(storage: FlowStorage): { include: string[]; exclude: string[] } {
  return (
    storage.getIndexPatterns() ?? { include: DEFAULT_CONFIG.include!, exclude: DEFAULT_CONFIG.exclude! }
  );
}

/**
 * Analyze impact using git diff (precise)
 */
async function analyzeImpactWithGit(storage: FlowStorage, rootPath: string): Promise<ImpactResult> {
  const supported = (path: string): boolean => parserRegistry.getForFile(path) !== undefined;
  // CodeMap's own data directory is never part of the change set.
  const allChanged = getGitChangedFiles(rootPath).filter(
    (f) => f.path !== ".codemap" && !f.path.startsWith(".codemap/")
  );
  const changedSource = allChanged.filter((f) => supported(f.path));

  if (allChanged.length === 0) {
    if (storage.isIndexOutdated()) {
      const patterns = indexPatterns(storage);
      await new FlowBuilder(storage, { rootPath, ...patterns, forceReindex: true }).build();
    }
    return emptyResult("git");
  }

  // Re-index the changed files (deleted files are dropped from the index).
  const patterns = indexPatterns(storage);
  const builder = new FlowBuilder(storage, {
    rootPath,
    include: patterns.include,
    exclude: patterns.exclude,
    forceReindex: false,
    files: changedSource.map((f) => join(rootPath, f.path)),
  });
  await builder.build();

  // Which of the changed files are part of the index? Others (tests excluded
  // by patterns, generated files...) are reported but not analyzed.
  const indexed = new Set(storage.getIndexedFiles());
  const absolute = (relativePath: string): string => join(rootPath, relativePath).replace(/\\/g, "/");
  const analyzed = changedSource.filter(
    (f) => f.status === "deleted" || indexed.has(absolute(f.path))
  );

  // Compare every analyzed file with HEAD.
  const resolver = new CallResolver(storage, rootPath);
  const changedFunctions: GitChangedFunction[] = [];
  const directCallers = new Map<string, ImpactCaller[]>();
  const endpointSet = new Set<string>();
  const importIssues = new Map<string, ImportAnalysisResult>();
  const removedCallImpacts: RemovedCallImpact[] = [];
  const dataFlowChanges: BreakingPropertyChange[] = [];

  for (const file of analyzed) {
    const filePath = absolute(file.path);
    const before = file.status === "added" ? null : getGitHeadContent(rootPath, file.path);
    const after = file.status === "deleted" ? null : readIfExists(filePath);

    const beforeSnapshot = before !== null ? snapshotFile(filePath, before) : null;
    const afterSnapshot = after !== null ? snapshotFile(filePath, after) : null;
    const changes = diffFunctions(beforeSnapshot, afterSnapshot);

    for (const change of changes) {
      const fn = change.after ?? change.before!;
      // Every function of a brand new file is "added"; listing them adds noise, not information.
      if (file.status === "added" && change.changeType === "added") continue;

      const nodeId = change.after ? change.after.nodeId : null;
      changedFunctions.push({
        file: file.path,
        functionName: fn.displayName,
        lineNumber: fn.startLine,
        changeType: change.changeType,
        ...(nodeId && storage.getNode(nodeId) ? { nodeId } : {}),
      });

      if (change.changeType === "deleted") {
        // The node is gone; callers now point at nothing. Find them by reference name.
        const callers = findCallersOfDeleted(storage, filePath, fn.name);
        if (callers.length > 0) mergeCallers(directCallers, fn.displayName, callers);
        continue;
      }

      if (!nodeId) continue;
      const callers = storage.getResolvedCallersWithLocation(nodeId).filter((c) => c.id !== nodeId);
      if (callers.length > 0) mergeCallers(directCallers, fn.displayName, callers);

      // Endpoints served by the function itself or by a direct caller.
      for (const id of [nodeId, ...callers.map((c) => c.id)]) {
        for (const endpoint of storage.getHttpEndpointsByHandler(id)) {
          endpointSet.add(`${endpoint.method} ${endpoint.path}`);
        }
      }
    }

    // Removed calls
    if (beforeSnapshot) {
      for (const site of findRemovedCalls(changes, beforeSnapshot)) {
        const scopeId = storage.getNode(site.from.nodeId) ? site.from.nodeId : undefined;
        const calleeId = resolver.resolveName(filePath, site.expression, scopeId);
        const impacts = analyzeRemovedCallImpact(
          [
            {
              callee: site.expression.split(".").pop()!,
              expression: site.expression,
              removedFrom: site.from.displayName,
              file: file.path,
              lineNumber: site.line,
              rawContent: site.source,
              calleeId,
              removedFromId: scopeId ?? null,
            },
          ],
          storage
        );
        removedCallImpacts.push(...impacts);
      }
    }

    // Imports
    if (after !== null) {
      const analysis = analyzeImports(filePath, { content: after, previousContent: before });
      if (analysis.missing.length > 0 || analysis.unused.length > 0) {
        importIssues.set(file.path, analysis);
      }
    }

    // Return shapes that lost properties
    dataFlowChanges.push(...findReturnShapeBreaks(storage, file.path, changes));
  }

  // Docker Compose services whose entry point changed
  const dockerImpact = computeDockerImpact(rootPath, allChanged);

  const totalCallers = new Set(
    [...directCallers.values()].flat().map((caller) => caller.id)
  ).size;
  const affectedEndpoints = [...endpointSet].sort();

  const notes: string[] = [];
  const skipped = changedSource.length - analyzed.length;
  if (skipped > 0) {
    notes.push(
      `${skipped} changed source file${skipped === 1 ? " is" : "s are"} excluded from the index and ${
        skipped === 1 ? "was" : "were"
      } not analyzed.`
    );
  }

  return {
    changedFiles: allChanged.map((f) => f.path),
    changedFunctions,
    directCallers,
    affectedEndpoints,
    importIssues,
    dockerImpact,
    removedCallImpacts,
    dataFlowChanges,
    riskLevel: assessRisk({
      totalCallers,
      affectedEndpoints: affectedEndpoints.length,
      importIssues,
      dockerImpact,
      removedCallImpacts,
      dataFlowChanges,
    }),
    totalImpact:
      totalCallers +
      (dockerImpact?.affectedServices.length || 0) +
      removedCallImpacts.length +
      dataFlowChanges.length,
    mode: "git",
    notes,
  };
}

/**
 * Analyze impact using hash comparison (fallback)
 */
async function analyzeImpactWithHash(
  storage: FlowStorage,
  rootPath: string,
  notes: string[]
): Promise<ImpactResult> {
  // Get all files and their hashes before re-index
  const oldHashes = storage.getAllFileHashes();

  const patterns = indexPatterns(storage);
  const builder = new FlowBuilder(storage, {
    rootPath,
    include: patterns.include,
    exclude: patterns.exclude,
    forceReindex: false, // Use hash comparison
  });

  const result = await builder.build();

  // Files that were added, changed or removed since the last index
  const newHashes = storage.getAllFileHashes();
  const changed = new Set<string>();
  for (const [filePath, newHash] of Object.entries(newHashes)) {
    if (oldHashes[filePath] !== newHash) changed.add(filePath);
  }
  for (const filePath of Object.keys(oldHashes)) {
    if (!(filePath in newHashes)) changed.add(filePath);
  }

  const changedFiles = [...changed].sort().map((f) => relative(rootPath, f).replace(/\\/g, "/"));

  // Analyze imports for changed files (unused imports only: no previous version to compare)
  const importIssues = new Map<string, ImportAnalysisResult>();
  for (const filePath of changed) {
    const analysis = analyzeImports(filePath);
    if (analysis.missing.length > 0 || analysis.unused.length > 0) {
      importIssues.set(relative(rootPath, filePath).replace(/\\/g, "/"), analysis);
    }
  }

  const dockerImpact = computeDockerImpact(
    rootPath,
    changedFiles.map((path) => ({ path, status: "modified" as const }))
  );

  const base = emptyResult("hash", [
    ...notes,
    "Without git history only file-level changes can be detected.",
  ]);
  return {
    ...base,
    changedFiles,
    importIssues,
    dockerImpact,
    riskLevel:
      changedFiles.length > 10 ? "HIGH" : changedFiles.length > 5 || dockerImpact ? "MEDIUM" : "LOW",
    totalImpact: result.indexed + result.removed,
  };
}

// ---------------------------------------------------------------------------

function readIfExists(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function mergeCallers(map: Map<string, ImpactCaller[]>, key: string, callers: ImpactCaller[]): void {
  const existing = map.get(key) ?? [];
  const seen = new Set(existing.map((c) => c.id));
  for (const caller of callers) {
    if (!seen.has(caller.id)) {
      existing.push(caller);
      seen.add(caller.id);
    }
  }
  map.set(key, existing);
}

/**
 * Callers of a function that no longer exists: unresolved call edges in files
 * that import from the changed file (or the file itself) and use the name.
 */
function findCallersOfDeleted(storage: FlowStorage, filePath: string, name: string): ImpactCaller[] {
  const rows = storage.db
    .prepare(
      `SELECT DISTINCT n.id, n.name, n.file_path AS file, n.start_line AS line
       FROM edges e JOIN nodes n ON n.id = e.source_id
       WHERE e.type = 'calls' AND e.target_id IN (?, ?)
         AND (n.file_path = ? OR n.file_path IN (
           SELECT file_path FROM imports WHERE imported_symbol = ? OR original_name = ?
         ))
       ORDER BY n.file_path, n.start_line`
    )
    .all(`ref:${name}`, `ref:self.${name}`, filePath, name, name) as ImpactCaller[];
  return rows;
}

/** Properties that a changed function stopped returning while other functions still read them. */
function findReturnShapeBreaks(
  storage: FlowStorage,
  file: string,
  changes: FunctionChange[]
): BreakingPropertyChange[] {
  const breaks: BreakingPropertyChange[] = [];
  const accessQuery = storage.db.prepare(`
    SELECT DISTINCT pa.line, pa.file_path, n.id AS scope_id, n.name AS scope_name
    FROM edges e
    JOIN nodes n ON n.id = e.source_id
    JOIN property_accesses pa ON pa.scope_node_id = n.id
    WHERE e.type = 'calls' AND e.target_id = ?
      AND json_extract(pa.property_path, '$[0]') = ?
    ORDER BY pa.file_path, pa.line
  `);

  for (const change of changes) {
    if (change.changeType !== "modified" || !change.before?.returnShape || !change.after) continue;
    if (!change.after.returnShape) continue; // no longer returns a literal: nothing to compare

    const comparison = compareObjectShapes(change.before.returnShape, change.after.returnShape);
    for (const property of comparison.removedProperties) {
      const rows = accessQuery.all(change.after.nodeId, property) as Array<{
        line: number;
        file_path: string;
        scope_id: string;
        scope_name: string;
      }>;
      if (rows.length === 0) continue;
      breaks.push({
        propertyPath: property,
        changeType: "removed",
        functionName: change.after.displayName,
        filePath: file,
        line: change.after.startLine,
        accessLocations: rows.map((r) => ({
          functionName: r.scope_name,
          file: r.file_path,
          line: r.line,
          scopeId: r.scope_id,
        })),
        severity: rows.length >= 10 ? "HIGH" : rows.length >= 3 ? "MEDIUM" : "LOW",
      });
    }
  }
  // Identity and credential fields are always serious.
  for (const item of breaks) {
    if (/^(id|.*_id|email|token|password|secret|api_?key)$/i.test(item.propertyPath)) {
      item.severity = "CRITICAL";
    }
  }
  return breaks;
}

function computeDockerImpact(
  rootPath: string,
  changedFiles: GitChangedFile[]
): ImpactResult["dockerImpact"] {
  const dockerGraph = parseDockerCompose(rootPath);
  const entryPointFiles = new Set<string>();
  const affectedServices = new Set<string>();

  for (const [serviceName, entryPoint] of dockerGraph.entryPoints) {
    if (changedFiles.some((file) => matchesEntryPoint(file.path, entryPoint))) {
      entryPointFiles.add(entryPoint);
      for (const service of calculateServiceBlastRadius(dockerGraph, serviceName)) {
        affectedServices.add(service);
      }
    }
  }

  if (affectedServices.size === 0) return undefined;
  return {
    affectedServices: [...affectedServices].sort(),
    entryPointFiles: [...entryPointFiles].sort(),
  };
}

export function assessRisk(input: {
  totalCallers: number;
  affectedEndpoints: number;
  importIssues: Map<string, ImportAnalysisResult>;
  dockerImpact?: { affectedServices: string[] };
  removedCallImpacts: RemovedCallImpact[];
  dataFlowChanges?: BreakingPropertyChange[];
}): RiskLevel {
  const hasCriticalImportIssues = [...input.importIssues.values()].some((i) => i.missing.length > 0);
  const dockerServices = input.dockerImpact?.affectedServices.length ?? 0;
  const removed = input.removedCallImpacts;
  const dataFlow = input.dataFlowChanges ?? [];

  // CRITICAL: a removed security call, or a broken import in a service entry point
  if (
    removed.some((i) => i.severity === "CRITICAL") ||
    dataFlow.some((c) => c.severity === "CRITICAL") ||
    (hasCriticalImportIssues && dockerServices > 0)
  ) {
    return "CRITICAL";
  }
  if (
    removed.some((i) => i.severity === "HIGH") ||
    dataFlow.some((c) => c.severity === "HIGH") ||
    hasCriticalImportIssues ||
    dockerServices > 2 ||
    input.totalCallers > 20 ||
    input.affectedEndpoints > 5
  ) {
    return "HIGH";
  }
  if (
    input.totalCallers > 10 ||
    input.affectedEndpoints > 2 ||
    dockerServices > 0 ||
    removed.length > 0 ||
    dataFlow.length > 0
  ) {
    return "MEDIUM";
  }
  return "LOW";
}

/** Snapshot of a file, exported for tests. */
export type { FileSnapshot };
