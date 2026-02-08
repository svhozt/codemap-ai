/**
 * Export impact analysis data for visualization
 */

import { FlowStorage } from "../flow/storage.js";
import type { ImpactData, ImpactNode, ImpactEdge, SeverityLevel } from "../web/app/types.js";
import { writeFileSync } from "fs";
import { join } from "path";

export interface ImpactAnalysisResult {
  changedFiles: string[];
  changedFunctions: Array<{ functionName: string; file: string; lineNumber: number }>;
  directCallers: Map<string, Array<{ id: string; name: string; file: string; line: number }>>;
  removedCallImpacts?: Array<{
    severity: string;
    removedCall: any;
    stillCalledBy: any[];
    impactedFunctions: any[];
  }>;
}

export function exportImpactForVisualization(
  result: ImpactAnalysisResult,
  storage: FlowStorage,
  outputPath: string
): void {
  const nodes: ImpactNode[] = [];
  const edges: ImpactEdge[] = [];
  const nodesAdded = new Set<string>();
  const edgesAdded = new Set<string>();

  // Helper to determine severity
  function getSeverity(isChanged: boolean, depth: number): SeverityLevel {
    if (isChanged) return "CRITICAL";
    if (depth === 1) return "HIGH";
    if (depth === 2) return "MEDIUM";
    return "LOW";
  }

  // Add changed functions (root nodes)
  for (const changedFunc of result.changedFunctions) {
    // Find node in database - use absolute path
    const absolutePath = join(outputPath, changedFunc.file);
    const dbNode = storage.db
      .prepare(`SELECT * FROM nodes WHERE file_path = ? AND name = ?`)
      .get(absolutePath, changedFunc.functionName) as any;

    if (dbNode) {
      const node: ImpactNode = {
        id: dbNode.id,
        name: dbNode.name,
        filePath: dbNode.file_path,
        line: dbNode.start_line,
        type: dbNode.type === "method" ? "method" : "function",
        severity: "CRITICAL",
        isChanged: true,
        calleeCount: 0,
        callerCount: 0,
      };
      nodes.push(node);
      nodesAdded.add(dbNode.id);
    }
  }

  // Add direct callers (depth 1)
  for (const [funcName, callers] of result.directCallers.entries()) {
    // Find the changed function node ID for this function name
    const changedFunc = result.changedFunctions.find(f => f.functionName === funcName);
    if (!changedFunc) continue;

    const absolutePath = join(outputPath, changedFunc.file);
    const changedFuncNode = storage.db
      .prepare(`SELECT id FROM nodes WHERE file_path = ? AND name = ?`)
      .get(absolutePath, changedFunc.functionName) as any;

    if (!changedFuncNode || !changedFuncNode.id) continue;

    for (const caller of callers) {
      // Skip if caller doesn't have a valid ID
      if (!caller.id) continue;

      if (!nodesAdded.has(caller.id)) {
        const node: ImpactNode = {
          id: caller.id,
          name: caller.name,
          filePath: caller.file,
          line: caller.line,
          type: "function",
          severity: "HIGH",
          isChanged: false,
          calleeCount: 0,
          callerCount: 0,
        };
        nodes.push(node);
        nodesAdded.add(caller.id);
      }

      // Add edge from caller to changed function
      const edgeId = `${caller.id}-${changedFuncNode.id}`;
      if (!edgesAdded.has(edgeId)) {
        edges.push({
          id: edgeId,
          source: caller.id,
          target: changedFuncNode.id,
          type: "direct",
          isOnCriticalPath: true,
        });
        edgesAdded.add(edgeId);
      }
    }
  }

  // Add removed call impacts
  if (result.removedCallImpacts) {
    for (const impact of result.removedCallImpacts) {
      // Add impacted functions
      for (const impactedFunc of impact.impactedFunctions) {
        // Skip if function doesn't have a valid ID
        if (!impactedFunc.id) continue;

        if (!nodesAdded.has(impactedFunc.id)) {
          const node: ImpactNode = {
            id: impactedFunc.id,
            name: impactedFunc.name,
            filePath: impactedFunc.file,
            line: impactedFunc.line,
            type: "function",
            severity: impact.severity as SeverityLevel,
            isChanged: false,
            calleeCount: 0,
            callerCount: 0,
            hasBreakingChanges: true,
          };
          nodes.push(node);
          nodesAdded.add(impactedFunc.id);
        }
      }
    }
  }

  // Calculate caller/callee counts
  for (const node of nodes) {
    const callees = storage.db
      .prepare(`SELECT COUNT(*) as count FROM edges WHERE source_id = ?`)
      .get(node.id) as any;
    const callers = storage.db
      .prepare(`SELECT COUNT(*) as count FROM edges WHERE target_id = ?`)
      .get(node.id) as any;
    node.calleeCount = callees?.count || 0;
    node.callerCount = callers?.count || 0;
  }

  // Calculate statistics
  const bySeverity: Record<SeverityLevel, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  };

  for (const node of nodes) {
    bySeverity[node.severity]++;
  }

  const filesAffected = new Set(nodes.map(n => n.filePath)).size;

  const impactData: ImpactData = {
    nodes,
    edges,
    changedFiles: result.changedFiles,
    statistics: {
      totalAffected: nodes.length,
      bySeverity,
      byDepth: {
        0: result.changedFunctions.length,
        1: Array.from(result.directCallers.values()).reduce((sum, arr) => sum + arr.length, 0),
      },
      filesAffected,
    },
    timestamp: new Date().toISOString(),
    analysisPath: outputPath,
  };

  // Write to file
  const outputFile = join(outputPath, ".codemap", "impact.json");
  writeFileSync(outputFile, JSON.stringify(impactData, null, 2));

  console.log(`\n  📊 Impact data exported to: ${outputFile}`);
}
