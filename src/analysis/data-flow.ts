/**
 * Data Flow Tracker
 * Tracks how data flows through function calls and validates property accesses against object shapes
 */

import type { FlowStorage } from "../flow/storage.js";
import type { GraphNode } from "../types.js";
import type { VariableType } from "./type-tracker.js";
import type { ReturnInfo, ObjectShape } from "./return-analyzer.js";
import type { PropertyAccess } from "./property-tracker.js";

export interface DataFlow {
  sourceId: string;         // Function/variable providing data
  targetId: string;         // Function/variable receiving data
  dataType: DataType;
  flowType: 'return' | 'parameter' | 'assignment';
  line: number;
}

export interface DataType {
  typeName: string;
  shape: ObjectShape | null;
  isArray: boolean;
  isOptional: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  propertyPath: string;
  expectedShape: ObjectShape | null;
  missingProperties: string[];
  errorMessage: string | null;
}

export interface PropertyAccessValidation {
  access: PropertyAccess;
  validation: ValidationResult;
  dataType: DataType | null;
}

/**
 * Track data flows in a function
 */
export function trackDataFlow(
  functionNode: GraphNode,
  storage: FlowStorage,
  variableTypes: Map<string, VariableType[]>,
  returnInfoMap: Map<string, ReturnInfo[]>
): DataFlow[] {
  const flows: DataFlow[] = [];

  // Get all edges where this function is the source (calls other functions)
  const callEdges = storage.db
    .prepare(
      `SELECT * FROM edges WHERE source_id = ? AND type = 'calls' AND target_id NOT LIKE 'ref:%'`
    )
    .all(functionNode.id) as Array<{
      id: string;
      source_id: string;
      target_id: string;
      type: string;
      metadata: string | null;
    }>;

  for (const edge of callEdges) {
    // Get the called function's return info
    const returnInfos = returnInfoMap.get(edge.target_id);
    if (returnInfos && returnInfos.length > 0) {
      // For each return statement, create a data flow
      for (const returnInfo of returnInfos) {
        if (returnInfo.returnType && returnInfo.returnType !== "unknown") {
          const dataType: DataType = {
            typeName: returnInfo.returnType,
            shape: returnInfo.objectShape,
            isArray: returnInfo.objectShape?.isArray || false,
            isOptional: false,
          };

          flows.push({
            sourceId: edge.target_id,
            targetId: edge.source_id,
            dataType,
            flowType: 'return',
            line: returnInfo.line,
          });
        }
      }
    }
  }

  return flows;
}

/**
 * Validate property accesses against known data types
 */
export function validatePropertyAccesses(
  accesses: PropertyAccess[],
  storage: FlowStorage,
  variableTypes: Map<string, VariableType[]>,
  returnInfoMap: Map<string, ReturnInfo[]>
): PropertyAccessValidation[] {
  const validations: PropertyAccessValidation[] = [];

  for (const access of accesses) {
    // Resolve the data type of the object being accessed
    const dataType = resolveDataType(
      access.objectName,
      access.scopeId,
      storage,
      variableTypes,
      returnInfoMap
    );

    const validation = validateSingleAccess(access, dataType);

    validations.push({
      access,
      validation,
      dataType,
    });
  }

  return validations;
}

/**
 * Validate a single property access
 */
function validateSingleAccess(
  access: PropertyAccess,
  dataType: DataType | null
): ValidationResult {
  if (!dataType || !dataType.shape) {
    return {
      isValid: true, // Can't validate without type info
      propertyPath: access.fullPath,
      expectedShape: null,
      missingProperties: [],
      errorMessage: null,
    };
  }

  // Check if the property path exists in the shape
  const missingProperties = checkPropertyPath(access.propertyPath, dataType.shape);

  if (missingProperties.length > 0) {
    return {
      isValid: false,
      propertyPath: access.fullPath,
      expectedShape: dataType.shape,
      missingProperties,
      errorMessage: `Property path ${access.fullPath} not found in object shape`,
    };
  }

  return {
    isValid: true,
    propertyPath: access.fullPath,
    expectedShape: dataType.shape,
    missingProperties: [],
    errorMessage: null,
  };
}

/**
 * Check if a property path exists in an object shape
 */
function checkPropertyPath(
  propertyPath: string[],
  shape: ObjectShape
): string[] {
  const missing: string[] = [];
  let currentShape = shape;

  for (let i = 0; i < propertyPath.length; i++) {
    const property = propertyPath[i];

    if (!currentShape.properties.includes(property)) {
      // Property doesn't exist at this level
      missing.push(propertyPath.slice(0, i + 1).join("."));
      break;
    }

    // If there are more properties in the path, navigate to nested shape
    if (i < propertyPath.length - 1) {
      const nestedShape = currentShape.nestedShapes.get(property);
      if (!nestedShape) {
        // Can't navigate deeper - property exists but is not an object
        missing.push(propertyPath.slice(0, i + 2).join("."));
        break;
      }
      currentShape = nestedShape;
    }
  }

  return missing;
}

/**
 * Resolve data type for a variable in a scope
 */
export function resolveDataType(
  varName: string,
  scopeId: string,
  storage: FlowStorage,
  variableTypes: Map<string, VariableType[]>,
  returnInfoMap: Map<string, ReturnInfo[]>
): DataType | null {
  // Step 1: Check if variable type is tracked in Phase 2
  const scopeTypes = variableTypes.get(scopeId) || [];
  const varType = scopeTypes.find((v) => v.name === varName);

  if (varType) {
    // Check if this type is a function call (@call:functionName)
    if (varType.type.startsWith("@call:")) {
      const functionName = varType.type.replace("@call:", "");
      return resolveDataTypeFromFunctionReturn(functionName, storage, returnInfoMap);
    }

    // Check if this type is a known class
    const classNode = storage.searchNodesByName(varType.type)[0];
    if (classNode && classNode.type === "class") {
      return {
        typeName: varType.type,
        shape: null, // Classes don't have static shapes
        isArray: false,
        isOptional: false,
      };
    }

    return {
      typeName: varType.type,
      shape: null,
      isArray: false,
      isOptional: false,
    };
  }

  // Step 2: Check if variable is a function parameter with type hint
  const paramTypes = storage.db
    .prepare(
      `SELECT * FROM variable_types WHERE scope_node_id = ? AND variable_name = ?`
    )
    .get(scopeId, varName) as
      | {
          id: string;
          variable_name: string;
          type_name: string;
          scope_node_id: string;
        }
      | undefined;

  if (paramTypes) {
    return {
      typeName: paramTypes.type_name,
      shape: null,
      isArray: false,
      isOptional: false,
    };
  }

  // Step 3: Check if variable is result of function call in same scope
  // This requires tracking assignments - simplified for now
  return null;
}

/**
 * Resolve data type from function return value
 */
function resolveDataTypeFromFunctionReturn(
  functionName: string,
  storage: FlowStorage,
  returnInfoMap: Map<string, ReturnInfo[]>
): DataType | null {
  // Find function by name
  const functions = storage.searchNodesByName(functionName);
  if (functions.length === 0) return null;

  const functionNode = functions[0];
  const returnInfos = returnInfoMap.get(functionNode.id);

  if (!returnInfos || returnInfos.length === 0) return null;

  // Use first return (could merge multiple returns in the future)
  const returnInfo = returnInfos[0];

  return {
    typeName: returnInfo.returnType || "unknown",
    shape: returnInfo.objectShape,
    isArray: returnInfo.objectShape?.isArray || false,
    isOptional: false,
  };
}

/**
 * Find all property accesses that would break if a property is removed
 */
export function findBreakingAccesses(
  removedProperty: string,
  allAccesses: PropertyAccess[],
  storage: FlowStorage
): PropertyAccess[] {
  const breaking: PropertyAccess[] = [];

  for (const access of allAccesses) {
    // Check if this access uses the removed property
    if (access.fullPath === removedProperty || access.fullPath.startsWith(`${removedProperty}.`)) {
      breaking.push(access);
    }
  }

  return breaking;
}

/**
 * Calculate impact of removing a property
 */
export interface PropertyImpact {
  propertyPath: string;
  removedFrom: string;        // Function that no longer returns it
  breakingAccesses: PropertyAccess[];
  impactedFunctions: string[]; // Unique function names affected
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function calculatePropertyImpact(
  propertyPath: string,
  functionId: string,
  allAccesses: PropertyAccess[],
  storage: FlowStorage
): PropertyImpact {
  const breakingAccesses = findBreakingAccesses(propertyPath, allAccesses, storage);

  // Get unique function names
  const impactedFunctionIds = new Set<string>();
  for (const access of breakingAccesses) {
    impactedFunctionIds.add(access.scopeId);
  }

  const impactedFunctions: string[] = [];
  for (const scopeId of impactedFunctionIds) {
    const node = storage.getNode(scopeId);
    if (node) {
      impactedFunctions.push(node.name);
    }
  }

  // Calculate severity
  const severity = calculatePropertySeverity(
    propertyPath,
    breakingAccesses.length,
    impactedFunctions.length
  );

  const functionNode = storage.getNode(functionId);

  return {
    propertyPath,
    removedFrom: functionNode?.name || "unknown",
    breakingAccesses,
    impactedFunctions,
    severity,
  };
}

/**
 * Calculate severity of property removal
 */
function calculatePropertySeverity(
  propertyPath: string,
  breakingAccessCount: number,
  impactedFunctionCount: number
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  // Check for critical property names
  const criticalKeywords = [
    'id', 'user_id', 'email', 'token', 'password', 'key', 'api_key',
    'auth', 'session', 'credential', 'secret'
  ];

  const lowerPath = propertyPath.toLowerCase();
  const isCritical = criticalKeywords.some((keyword) => lowerPath.includes(keyword));

  if (isCritical && breakingAccessCount > 5) {
    return 'CRITICAL';
  }

  if (breakingAccessCount > 20 || impactedFunctionCount > 10) {
    return 'CRITICAL';
  }

  if (breakingAccessCount > 10 || impactedFunctionCount > 5) {
    return 'HIGH';
  }

  if (breakingAccessCount > 5 || impactedFunctionCount > 2) {
    return 'MEDIUM';
  }

  return 'LOW';
}

/**
 * Propagate type changes through the call graph
 */
export interface TypePropagation {
  changedFunction: string;
  affectedFunctions: Array<{
    functionId: string;
    functionName: string;
    reason: string;
    impact: string;
  }>;
}

export function propagateTypeChanges(
  changedFunctionId: string,
  storage: FlowStorage
): TypePropagation {
  const affectedFunctions: Array<{
    functionId: string;
    functionName: string;
    reason: string;
    impact: string;
  }> = [];

  // Find all functions that call the changed function
  const callers = storage.getResolvedCallers(changedFunctionId);

  for (const caller of callers) {
    affectedFunctions.push({
      functionId: caller.id,
      functionName: caller.name,
      reason: "Calls function with changed return type",
      impact: "Variables assigned from return value may have incorrect type",
    });
  }

  const changedNode = storage.getNode(changedFunctionId);

  return {
    changedFunction: changedNode?.name || "unknown",
    affectedFunctions,
  };
}

/**
 * Build data flow graph
 */
export interface DataFlowGraph {
  nodes: Map<string, DataFlowNode>;
  edges: DataFlowEdge[];
}

export interface DataFlowNode {
  id: string;
  name: string;
  type: 'function' | 'variable';
  dataType: DataType | null;
}

export interface DataFlowEdge {
  from: string;
  to: string;
  flowType: 'return' | 'parameter' | 'assignment';
  dataType: DataType;
}

export function buildDataFlowGraph(
  flows: DataFlow[],
  storage: FlowStorage
): DataFlowGraph {
  const nodes = new Map<string, DataFlowNode>();
  const edges: DataFlowEdge[] = [];

  for (const flow of flows) {
    // Add source node
    if (!nodes.has(flow.sourceId)) {
      const sourceNode = storage.getNode(flow.sourceId);
      if (sourceNode) {
        nodes.set(flow.sourceId, {
          id: flow.sourceId,
          name: sourceNode.name,
          type: 'function',
          dataType: flow.dataType,
        });
      }
    }

    // Add target node
    if (!nodes.has(flow.targetId)) {
      const targetNode = storage.getNode(flow.targetId);
      if (targetNode) {
        nodes.set(flow.targetId, {
          id: flow.targetId,
          name: targetNode.name,
          type: 'function',
          dataType: null,
        });
      }
    }

    // Add edge
    edges.push({
      from: flow.sourceId,
      to: flow.targetId,
      flowType: flow.flowType,
      dataType: flow.dataType,
    });
  }

  return {
    nodes,
    edges,
  };
}

/**
 * Get data flow statistics
 */
export interface DataFlowStats {
  totalFlows: number;
  returnFlows: number;
  parameterFlows: number;
  assignmentFlows: number;
  typedFlows: number;
  untypedFlows: number;
}

export function getDataFlowStats(flows: DataFlow[]): DataFlowStats {
  const stats: DataFlowStats = {
    totalFlows: flows.length,
    returnFlows: 0,
    parameterFlows: 0,
    assignmentFlows: 0,
    typedFlows: 0,
    untypedFlows: 0,
  };

  for (const flow of flows) {
    switch (flow.flowType) {
      case 'return':
        stats.returnFlows++;
        break;
      case 'parameter':
        stats.parameterFlows++;
        break;
      case 'assignment':
        stats.assignmentFlows++;
        break;
    }

    if (flow.dataType.typeName !== "unknown") {
      stats.typedFlows++;
    } else {
      stats.untypedFlows++;
    }
  }

  return stats;
}
