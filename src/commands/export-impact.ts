/**
 * Export impact analysis data for visualization
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { FlowStorage } from "../flow/storage.js";
import type { ImpactData, ImpactNode, ImpactEdge, SeverityLevel } from "../web/app/types.js";
import type { ImpactResult } from "./impact.js";

/** The parts of an {@link ImpactResult} the visualization uses. */
export type ImpactAnalysisResult = Pick<
  ImpactResult,
  "changedFiles" | "changedFunctions" | "directCallers" | "removedCallImpacts"
> &
  Partial<Pick<ImpactResult, "riskLevel" | "affectedEndpoints" | "dataFlowChanges">>;

const SEVERITY_ORDER: SeverityLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function maxSeverity(a: SeverityLevel, b: SeverityLevel): SeverityLevel {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

/** Build the data the web view renders. */
export function buildImpactData(
  result: ImpactAnalysisResult,
  storage: FlowStorage,
  projectPath: string
): ImpactData {
  const nodes = new Map<string, ImpactNode>();
  const edges = new Map<string, ImpactEdge>();

  const addNode = (node: ImpactNode): ImpactNode => {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      return node;
    }
    existing.severity = maxSeverity(existing.severity, node.severity);
    existing.isChanged = existing.isChanged || node.isChanged;
    existing.hasBreakingChanges = existing.hasBreakingChanges || node.hasBreakingChanges;
    return existing;
  };

  const addEdge = (source: string, target: string, critical: boolean, type: ImpactEdge["type"]): void => {
    if (source === target) return;
    const id = `${source}->${target}`;
    const existing = edges.get(id);
    if (existing) {
      existing.isOnCriticalPath = existing.isOnCriticalPath || critical;
      return;
    }
    edges.set(id, { id, source, target, type, isOnCriticalPath: critical });
  };

  const nodeType = (type: string): ImpactNode["type"] => (type === "method" ? "method" : "function");

  // Changed functions (roots)
  const changedIdByName = new Map<string, string>();
  for (const changed of result.changedFunctions) {
    if (!changed.nodeId) continue;
    const dbNode = storage.getNode(changed.nodeId);
    if (!dbNode) continue;
    changedIdByName.set(changed.functionName, dbNode.id);
    addNode({
      id: dbNode.id,
      name: changed.functionName,
      filePath: dbNode.filePath,
      line: dbNode.startLine,
      type: nodeType(dbNode.type),
      severity: "CRITICAL",
      isChanged: true,
      calleeCount: 0,
      callerCount: 0,
    });
  }

  // Direct callers (depth 1)
  for (const [funcName, callers] of result.directCallers.entries()) {
    const changedId = changedIdByName.get(funcName);
    for (const caller of callers) {
      if (!caller.id) continue;
      const dbNode = storage.getNode(caller.id);
      addNode({
        id: caller.id,
        name: caller.name,
        filePath: caller.file,
        line: caller.line,
        type: nodeType(dbNode?.type ?? "function"),
        severity: "HIGH",
        isChanged: false,
        calleeCount: 0,
        callerCount: 0,
      });
      if (changedId) addEdge(caller.id, changedId, true, "direct");
    }
  }

  // Removed call impacts: the function that lost the call, and everything that depends on it
  for (const impact of result.removedCallImpacts ?? []) {
    const severity = impact.severity as SeverityLevel;
    const fromId = impact.removedCall.removedFromId ?? undefined;
    for (const impacted of impact.impactedFunctions) {
      if (!impacted.id) continue;
      const dbNode = storage.getNode(impacted.id);
      addNode({
        id: impacted.id,
        name: impacted.name,
        filePath: impacted.file,
        line: impacted.line,
        type: nodeType(dbNode?.type ?? "function"),
        severity: severity === "CRITICAL" ? "HIGH" : severity,
        isChanged: false,
        calleeCount: 0,
        callerCount: 0,
        hasBreakingChanges: true,
      });
    }
    // Connect impacted functions along real call edges.
    const impactedIds = new Set(impact.impactedFunctions.map((f) => f.id));
    if (fromId) impactedIds.add(fromId);
    for (const id of impactedIds) {
      for (const callee of storage.getResolvedCallees(id)) {
        if (impactedIds.has(callee.id) && nodes.has(callee.id) && nodes.has(id)) {
          addEdge(id, callee.id, severity === "CRITICAL", "indirect");
        }
      }
    }
  }

  // Caller/callee counts from the full graph
  const countCallees = storage.db.prepare(
    `SELECT COUNT(DISTINCT target_id) AS count FROM edges WHERE source_id = ? AND type = 'calls' AND target_id NOT LIKE 'ref:%'`
  );
  const countCallers = storage.db.prepare(
    `SELECT COUNT(DISTINCT source_id) AS count FROM edges WHERE target_id = ? AND type = 'calls'`
  );
  for (const node of nodes.values()) {
    node.calleeCount = (countCallees.get(node.id) as { count: number }).count;
    node.callerCount = (countCallers.get(node.id) as { count: number }).count;
  }

  const nodeList = [...nodes.values()];
  const bySeverity: Record<SeverityLevel, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const node of nodeList) bySeverity[node.severity]++;

  return {
    nodes: nodeList,
    edges: [...edges.values()],
    changedFiles: result.changedFiles,
    statistics: {
      totalAffected: nodeList.length,
      bySeverity,
      byDepth: {
        0: nodeList.filter((n) => n.isChanged).length,
        1: new Set([...result.directCallers.values()].flat().map((c) => c.id)).size,
      },
      filesAffected: new Set(nodeList.map((n) => n.filePath)).size,
    },
    timestamp: new Date().toISOString(),
    analysisPath: projectPath,
    riskLevel: result.riskLevel,
    affectedEndpoints: result.affectedEndpoints ?? [],
  };
}

/**
 * Write `<project>/.codemap/impact.json` for the web view and return its path.
 */
export function exportImpactForVisualization(
  result: ImpactAnalysisResult,
  storage: FlowStorage,
  outputPath: string
): string {
  const impactData = buildImpactData(result, storage, outputPath);
  const dir = join(outputPath, ".codemap");
  mkdirSync(dir, { recursive: true });
  const outputFile = join(dir, "impact.json");
  writeFileSync(outputFile, JSON.stringify(impactData, null, 2));
  return outputFile;
}
