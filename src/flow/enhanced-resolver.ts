/**
 * Enhanced Call Resolver
 * Resolves method calls using type information and class hierarchy
 */

import type { FlowStorage } from "./storage.js";
import type { GraphNode, GraphEdge } from "../types.js";
import type { VariableType } from "../analysis/type-tracker.js";
import {
  buildClassHierarchy,
  resolveMethodCall,
  type ClassHierarchy,
} from "../analysis/class-hierarchy.js";

export interface ResolvedCall {
  originalEdge: GraphEdge;
  targetNode: GraphNode | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
}

/**
 * Enhanced resolver that uses type tracking and class hierarchy
 */
export class EnhancedResolver {
  private hierarchy: ClassHierarchy | null = null;
  private variableTypes: Map<string, VariableType[]> = new Map();

  constructor(private storage: FlowStorage) {}

  /**
   * Build class hierarchy from all nodes in storage
   */
  buildHierarchy(): void {
    const nodes = this.getAllNodes();
    this.hierarchy = buildClassHierarchy(nodes);
  }

  /**
   * Load variable type information from storage
   */
  loadVariableTypes(): void {
    const stmt = this.storage.db.prepare(`
      SELECT * FROM variable_types
    `);

    const rows = stmt.all() as Array<{
      id: string;
      variable_name: string;
      type_name: string;
      scope_node_id: string;
      file_path: string;
      line: number;
    }>;

    for (const row of rows) {
      const scopeId = row.scope_node_id;
      if (!this.variableTypes.has(scopeId)) {
        this.variableTypes.set(scopeId, []);
      }

      this.variableTypes.get(scopeId)!.push({
        name: row.variable_name,
        type: row.type_name,
        scope: scopeId,
        line: row.line,
      });
    }
  }

  /**
   * Resolve all unresolved edges using type information
   */
  resolveAllCalls(): ResolvedCall[] {
    if (!this.hierarchy) {
      this.buildHierarchy();
    }

    this.loadVariableTypes();

    const resolvedCalls: ResolvedCall[] = [];

    // Get all unresolved edges (target starts with 'ref:')
    const stmt = this.storage.db.prepare(`
      SELECT * FROM edges
      WHERE target_id LIKE 'ref:%'
      AND type = 'calls'
    `);

    const edges = stmt.all() as Array<{
      id: string;
      type: string;
      source_id: string;
      target_id: string;
      metadata: string | null;
    }>;

    for (const edgeRow of edges) {
      const edge: GraphEdge = {
        id: edgeRow.id,
        type: edgeRow.type as GraphEdge["type"],
        sourceId: edgeRow.source_id,
        targetId: edgeRow.target_id,
        metadata: edgeRow.metadata ? JSON.parse(edgeRow.metadata) : undefined,
      };

      const resolved = this.resolveCall(edge);
      if (resolved.targetNode) {
        resolvedCalls.push(resolved);

        // Update edge in database
        this.updateEdgeTarget(edge.id, resolved.targetNode.id);
      }
    }

    return resolvedCalls;
  }

  /**
   * Resolve a single call edge
   */
  resolveCall(edge: GraphEdge): ResolvedCall {
    const unresolvedName = edge.metadata?.unresolvedName as string;
    if (!unresolvedName) {
      return {
        originalEdge: edge,
        targetNode: null,
        confidence: "LOW",
        reason: "No unresolved name in metadata",
      };
    }

    // Get source node (the function/method making the call)
    const sourceNode = this.storage.getNode(edge.sourceId);
    if (!sourceNode) {
      return {
        originalEdge: edge,
        targetNode: null,
        confidence: "LOW",
        reason: "Source node not found",
      };
    }

    // Pattern 1: Simple function call - functionName()
    if (!unresolvedName.includes(".")) {
      return this.resolveSimpleCall(unresolvedName, sourceNode, edge);
    }

    // Pattern 2: Method call - obj.method()
    return this.resolveMethodCall(unresolvedName, sourceNode, edge);
  }

  /**
   * Resolve simple function call (no dot notation)
   */
  private resolveSimpleCall(
    functionName: string,
    sourceNode: GraphNode,
    edge: GraphEdge
  ): ResolvedCall {
    // Search for function in same file first
    const sameFileNodes = this.storage.getNodesByFile(sourceNode.filePath);
    const localMatch = sameFileNodes.find(
      (n) => (n.type === "function" || n.type === "method") && n.name === functionName
    );

    if (localMatch) {
      return {
        originalEdge: edge,
        targetNode: localMatch,
        confidence: "HIGH",
        reason: "Found in same file",
      };
    }

    // Search globally
    const globalMatches = this.storage.searchNodesByName(functionName);
    if (globalMatches.length === 1) {
      return {
        originalEdge: edge,
        targetNode: globalMatches[0],
        confidence: "MEDIUM",
        reason: "Single global match",
      };
    }

    if (globalMatches.length > 1) {
      // Multiple matches - prefer same directory
      const sourceDir = sourceNode.filePath.split("/").slice(0, -1).join("/");
      const sameDirMatch = globalMatches.find((n) => n.filePath.startsWith(sourceDir));

      if (sameDirMatch) {
        return {
          originalEdge: edge,
          targetNode: sameDirMatch,
          confidence: "MEDIUM",
          reason: "Multiple matches, picked same directory",
        };
      }

      return {
        originalEdge: edge,
        targetNode: globalMatches[0],
        confidence: "LOW",
        reason: `Multiple matches (${globalMatches.length}), picked first`,
      };
    }

    return {
      originalEdge: edge,
      targetNode: null,
      confidence: "LOW",
      reason: "No matches found",
    };
  }

  /**
   * Resolve method call using type information
   * Pattern: obj.method() or self.method()
   */
  private resolveMethodCall(
    fullName: string,
    sourceNode: GraphNode,
    edge: GraphEdge
  ): ResolvedCall {
    const parts = fullName.split(".");
    const varName = parts[0];
    const methodName = parts.slice(1).join(".");

    // Special case: self.method() or this.method()
    if (varName === "self" || varName === "this") {
      return this.resolveSelfMethodCall(methodName, sourceNode, edge);
    }

    // Look up variable type in current scope
    const scopeTypes = this.variableTypes.get(sourceNode.id) || [];
    const varType = scopeTypes.find((v) => v.name === varName);

    if (!varType) {
      // Fallback to simple name matching
      return this.resolveSimpleCall(methodName, sourceNode, edge);
    }

    // Use class hierarchy to resolve method
    if (!this.hierarchy) {
      return {
        originalEdge: edge,
        targetNode: null,
        confidence: "LOW",
        reason: "Class hierarchy not built",
      };
    }

    const classNode = resolveMethodCall(varType.type, methodName, this.hierarchy);

    if (classNode) {
      // Find the actual method node
      const methodNode = this.findMethodInClass(classNode.name, methodName);

      if (methodNode) {
        return {
          originalEdge: edge,
          targetNode: methodNode,
          confidence: "HIGH",
          reason: `Resolved via type tracking: ${varName}: ${varType.type}`,
        };
      }
    }

    return {
      originalEdge: edge,
      targetNode: null,
      confidence: "LOW",
      reason: `Type found (${varType.type}) but method not resolved`,
    };
  }

  /**
   * Resolve self.method() or this.method()
   */
  private resolveSelfMethodCall(
    methodName: string,
    sourceNode: GraphNode,
    edge: GraphEdge
  ): ResolvedCall {
    // Find parent class of source method
    const parentClass = sourceNode.metadata?.parentClass as string | undefined;

    if (!parentClass) {
      return {
        originalEdge: edge,
        targetNode: null,
        confidence: "LOW",
        reason: "self/this call but no parent class",
      };
    }

    // Search in class hierarchy
    if (!this.hierarchy) {
      return {
        originalEdge: edge,
        targetNode: null,
        confidence: "LOW",
        reason: "Class hierarchy not built",
      };
    }

    const classNode = resolveMethodCall(parentClass, methodName, this.hierarchy);

    if (classNode) {
      const methodNode = this.findMethodInClass(classNode.name, methodName);

      if (methodNode) {
        return {
          originalEdge: edge,
          targetNode: methodNode,
          confidence: "HIGH",
          reason: `Resolved self.${methodName} in ${parentClass}`,
        };
      }
    }

    // Fallback: search in same file
    const sameFileNodes = this.storage.getNodesByFile(sourceNode.filePath);
    const methodNode = sameFileNodes.find(
      (n) => n.type === "method" && n.name === methodName
    );

    if (methodNode) {
      return {
        originalEdge: edge,
        targetNode: methodNode,
        confidence: "MEDIUM",
        reason: "Found method in same file",
      };
    }

    return {
      originalEdge: edge,
      targetNode: null,
      confidence: "LOW",
      reason: `Method ${methodName} not found in ${parentClass}`,
    };
  }

  /**
   * Find method node in a class
   */
  private findMethodInClass(className: string, methodName: string): GraphNode | null {
    const stmt = this.storage.db.prepare(`
      SELECT * FROM nodes
      WHERE type = 'method'
      AND name = ?
      AND json_extract(metadata, '$.parentClass') = ?
    `);

    const row = stmt.get(methodName, className) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: row.id as string,
      type: row.type as GraphNode["type"],
      name: row.name as string,
      filePath: row.file_path as string,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      language: row.language as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }

  /**
   * Get all nodes from storage
   */
  private getAllNodes(): GraphNode[] {
    const stmt = this.storage.db.prepare("SELECT * FROM nodes");
    const rows = stmt.all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      type: row.type as GraphNode["type"],
      name: row.name as string,
      filePath: row.file_path as string,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      language: row.language as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    }));
  }

  /**
   * Update edge target in database
   */
  private updateEdgeTarget(edgeId: string, newTargetId: string): void {
    const stmt = this.storage.db.prepare(`
      UPDATE edges
      SET target_id = ?
      WHERE id = ?
    `);
    stmt.run(newTargetId, edgeId);
  }

  /**
   * Get resolution statistics
   */
  getStats(): {
    totalCalls: number;
    resolvedCalls: number;
    unresolvedCalls: number;
    resolutionRate: number;
  } {
    const totalStmt = this.storage.db.prepare(`
      SELECT COUNT(*) as count FROM edges WHERE type = 'calls'
    `);
    const totalRow = totalStmt.get() as { count: number };
    const totalCalls = totalRow.count;

    const resolvedStmt = this.storage.db.prepare(`
      SELECT COUNT(*) as count FROM edges
      WHERE type = 'calls' AND target_id NOT LIKE 'ref:%'
    `);
    const resolvedRow = resolvedStmt.get() as { count: number };
    const resolvedCalls = resolvedRow.count;

    const unresolvedCalls = totalCalls - resolvedCalls;
    const resolutionRate = totalCalls > 0 ? (resolvedCalls / totalCalls) * 100 : 0;

    return {
      totalCalls,
      resolvedCalls,
      unresolvedCalls,
      resolutionRate,
    };
  }
}
