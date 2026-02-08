/**
 * Impact analysis command
 * Detects changes and calculates their impact on the codebase
 */

import { resolve, join, relative } from "path";
import { FlowStorage } from "../flow/storage.js";
import { FlowBuilder } from "../flow/builder.js";
import { DEFAULT_CONFIG } from "../types.js";
import {
  isGitRepository,
  getGitChangedFiles,
  parseGitDiffForFunctions,
  getGitStatus,
  type GitChangedFunction,
} from "../utils/git.js";
import { analyzeImports, type ImportAnalysisResult } from "../analysis/imports.js";
import {
  parseDockerCompose,
  calculateServiceBlastRadius,
  type DockerDependencyGraph,
} from "../analysis/docker.js";
import { parseLineLevelDiff } from "../analysis/line-diff.js";
import { extractRemovedCalls } from "../analysis/removed-calls.js";
import { analyzeRemovedCallImpact, type RemovedCallImpact } from "../analysis/removed-call-impact.js";
import { analyzeDataFlowImpact, getPhase3Stats } from "./impact-phase3.js";

export interface ImpactResult {
  changedFiles: string[];
  changedFunctions: GitChangedFunction[];
  directCallers: Map<string, { name: string; file: string; line: number }[]>;
  affectedEndpoints: string[];
  importIssues: Map<string, ImportAnalysisResult>;
  dockerImpact?: {
    affectedServices: string[];
    entryPointFiles: string[];
  };
  removedCallImpacts: RemovedCallImpact[];  // NEW
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  totalImpact: number;
}

export interface ImpactOptions {
  path?: string;
  verbose?: boolean;
}

/**
 * Analyze impact of code changes
 */
export async function analyzeImpact(options: ImpactOptions = {}): Promise<ImpactResult> {
  const rootPath = resolve(options.path || ".");
  const dbPath = join(rootPath, ".codemap", "graph.db");
  const storage = new FlowStorage(dbPath);

  try {
    // Check if git repository
    if (isGitRepository(rootPath)) {
      return await analyzeImpactWithGit(storage, rootPath, options);
    } else {
      return await analyzeImpactWithHash(storage, rootPath, options);
    }
  } finally {
    storage.close();
  }
}

/**
 * Analyze impact using git diff (precise)
 */
async function analyzeImpactWithGit(
  storage: FlowStorage,
  rootPath: string,
  options: ImpactOptions
): Promise<ImpactResult> {
  // Get git status
  const gitStatus = getGitStatus(rootPath);
  if (!gitStatus.hasChanges) {
    return {
      changedFiles: [],
      changedFunctions: [],
      directCallers: new Map(),
      affectedEndpoints: [],
      importIssues: new Map(),
      removedCallImpacts: [],  // NEW
      riskLevel: "LOW",
      totalImpact: 0,
    };
  }

  // Get changed files from git
  const changedFiles = getGitChangedFiles(rootPath);
  const changedFilePaths = changedFiles.map((f) => f.path);

  // Parse git diff to find changed functions
  const changedFunctions = parseGitDiffForFunctions(rootPath, changedFiles);

  // Re-index only changed files
  const builder = new FlowBuilder(storage, {
    rootPath,
    include: changedFilePaths.map((f) => f),
    exclude: [],
    forceReindex: true,
  });

  await builder.build();

  // Calculate impact for each changed function
  const directCallers = new Map<string, { name: string; file: string; line: number }[]>();
  const affectedEndpoints: string[] = [];

  for (const func of changedFunctions) {
    // Find all nodes matching this function name in this file
    const nodes = storage
      .getNodesByFile(join(rootPath, func.file))
      .filter((n) => n.name === func.functionName);

    for (const node of nodes) {
      // Get callers
      const callers = storage.getResolvedCallersWithLocation(node.id);
      if (callers.length > 0) {
        directCallers.set(func.functionName, callers);
      }

      // Check if this is an HTTP endpoint
      const endpoints = storage.getHttpEndpointsByHandler(node.id);
      for (const endpoint of endpoints) {
        affectedEndpoints.push(`${endpoint.method} ${endpoint.path}`);
      }
    }
  }

  // NEW: Analyze imports for each changed file
  const importIssues = new Map<string, ImportAnalysisResult>();
  for (const filePath of changedFilePaths) {
    const fullPath = join(rootPath, filePath);
    const analysis = analyzeImports(fullPath);

    if (analysis.missing.length > 0 || analysis.unused.length > 0) {
      importIssues.set(relative(rootPath, fullPath), analysis);
    }
  }

  // NEW: Analyze Docker Compose dependencies
  const dockerGraph = parseDockerCompose(rootPath);
  let dockerImpact: { affectedServices: string[]; entryPointFiles: string[] } | undefined;

  // Check if any changed file is a Docker entry point
  const entryPointFiles: string[] = [];
  const affectedServices = new Set<string>();

  for (const [serviceName, entryPoint] of dockerGraph.entryPoints) {
    // Check if this entry point matches any changed file
    for (const changedFile of changedFilePaths) {
      if (changedFile.includes(entryPoint) || entryPoint.includes(changedFile)) {
        entryPointFiles.push(entryPoint);

        // Calculate blast radius
        const blastRadius = calculateServiceBlastRadius(dockerGraph, serviceName);
        blastRadius.forEach((s) => affectedServices.add(s));
      }
    }
  }

  if (affectedServices.size > 0) {
    dockerImpact = {
      affectedServices: Array.from(affectedServices),
      entryPointFiles,
    };
  }

  // NEW: Line-level diff analysis for removed calls
  const lineDiff = parseLineLevelDiff(rootPath);
  const removedCalls = extractRemovedCalls(lineDiff.removedLines);
  const removedCallImpacts = analyzeRemovedCallImpact(removedCalls, storage);

  // Calculate risk level (enhanced with import, Docker, and removed calls)
  const totalCallers = Array.from(directCallers.values()).reduce((sum, callers) => sum + callers.length, 0);
  const hasCriticalImportIssues = Array.from(importIssues.values()).some((i) => i.missing.length > 0);
  const hasDockerImpact = dockerImpact && dockerImpact.affectedServices.length > 0;
  const hasCriticalRemovedCalls = removedCallImpacts.some((i) => i.severity === "CRITICAL");
  const hasHighRiskRemovedCalls = removedCallImpacts.some((i) => i.severity === "HIGH");

  let riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "LOW";

  // CRITICAL: Any CRITICAL removed call or critical import + Docker issues
  if (hasCriticalRemovedCalls || (hasCriticalImportIssues && hasDockerImpact)) {
    riskLevel = "CRITICAL";
  } else if (
    hasHighRiskRemovedCalls ||
    hasCriticalImportIssues ||
    (hasDockerImpact && dockerImpact!.affectedServices.length > 2)
  ) {
    riskLevel = "HIGH";
  } else if (totalCallers > 20 || affectedEndpoints.length > 5) {
    riskLevel = "HIGH";
  } else if (
    totalCallers > 10 ||
    affectedEndpoints.length > 2 ||
    hasDockerImpact ||
    removedCallImpacts.length > 0
  ) {
    riskLevel = "MEDIUM";
  }

  return {
    changedFiles: changedFilePaths,
    changedFunctions,
    directCallers,
    affectedEndpoints,
    importIssues,
    dockerImpact,
    removedCallImpacts,  // NEW
    riskLevel,
    totalImpact: totalCallers + (dockerImpact?.affectedServices.length || 0) + removedCallImpacts.length,
  };
}

/**
 * Analyze impact using hash comparison (fallback)
 */
async function analyzeImpactWithHash(
  storage: FlowStorage,
  rootPath: string,
  options: ImpactOptions
): Promise<ImpactResult> {
  // Get all files and their hashes before re-index
  const oldHashes = storage.getAllFileHashes();

  // Re-index with force
  const builder = new FlowBuilder(storage, {
    rootPath,
    include: DEFAULT_CONFIG.include!,
    exclude: DEFAULT_CONFIG.exclude!,
    forceReindex: false, // Use hash comparison
  });

  const result = await builder.build();

  // Find files that were re-indexed (hash changed)
  const changedFiles: string[] = [];
  const newHashes = storage.getAllFileHashes();

  for (const [filePath, newHash] of Object.entries(newHashes)) {
    const oldHash = oldHashes[filePath];
    if (!oldHash || oldHash !== newHash) {
      changedFiles.push(filePath);
    }
  }

  // Analyze imports for changed files
  const importIssues = new Map<string, ImportAnalysisResult>();
  for (const filePath of changedFiles) {
    const analysis = analyzeImports(filePath);
    if (analysis.missing.length > 0 || analysis.unused.length > 0) {
      importIssues.set(relative(rootPath, filePath), analysis);
    }
  }

  // For hash-based, we can't determine specific functions or removed calls
  // Just return file-level impact
  const hasCriticalImportIssues = Array.from(importIssues.values()).some((i) => i.missing.length > 0);

  return {
    changedFiles,
    changedFunctions: [],
    directCallers: new Map(),
    affectedEndpoints: [],
    importIssues,
    removedCallImpacts: [],  // NEW - not available in hash mode
    riskLevel: hasCriticalImportIssues
      ? "CRITICAL"
      : changedFiles.length > 10
        ? "HIGH"
        : changedFiles.length > 5
          ? "MEDIUM"
          : "LOW",
    totalImpact: result.indexed,
  };
}
