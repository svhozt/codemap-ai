/**
 * Shape Change Detector
 * Detects when object shapes change between git revisions
 */

import Parser from "tree-sitter";
import {
  ObjectShape,
  ReturnInfo,
  compareObjectShapes,
  ShapeComparison,
} from "./return-analyzer.js";
import { PropertyAccess } from "./property-tracker.js";
import { PropertyImpact } from "./data-flow.js";

export interface ShapeChange {
  functionId: string;
  functionName: string;
  filePath: string;
  oldShape: ObjectShape;
  newShape: ObjectShape;
  comparison: ShapeComparison;
  line: number;
}

export interface BreakingPropertyChange {
  propertyPath: string;
  changeType: "removed" | "typeChanged";
  functionName: string;
  filePath: string;
  line: number;
  oldType?: string;
  newType?: string;
  accessLocations: Array<{
    functionName: string;
    file: string;
    line: number;
    scopeId: string;
  }>;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface ShapeChangeReport {
  shapeChanges: ShapeChange[];
  breakingChanges: BreakingPropertyChange[];
  totalImpactedFunctions: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

/**
 * Detect shape changes from git diff
 */
export function detectShapeChanges(
  oldReturnInfo: Map<string, ReturnInfo[]>,
  newReturnInfo: Map<string, ReturnInfo[]>
): ShapeChange[] {
  const changes: ShapeChange[] = [];

  // Find functions that exist in both old and new
  for (const [functionId, oldReturns] of oldReturnInfo) {
    const newReturns = newReturnInfo.get(functionId);

    if (!newReturns) {
      // Function was removed - this is handled by Phase 1
      continue;
    }

    // Compare return shapes
    for (let i = 0; i < oldReturns.length; i++) {
      const oldReturn = oldReturns[i];
      const newReturn = newReturns[i];

      if (!oldReturn.objectShape || !newReturn?.objectShape) {
        continue;
      }

      // Compare shapes
      const comparison = compareObjectShapes(
        oldReturn.objectShape,
        newReturn.objectShape
      );

      // If there are differences, record the change
      if (
        comparison.removedProperties.length > 0 ||
        comparison.changedTypes.length > 0
      ) {
        changes.push({
          functionId,
          functionName: oldReturn.functionName,
          filePath: "", // Will be filled in by caller
          oldShape: oldReturn.objectShape,
          newShape: newReturn.objectShape,
          comparison,
          line: newReturn.line,
        });
      }
    }
  }

  return changes;
}

/**
 * Find breaking property changes from shape changes
 */
export function findBreakingPropertyChanges(
  shapeChanges: ShapeChange[],
  propertyAccesses: PropertyAccess[],
  functionMap: Map<string, { name: string; file: string }>
): BreakingPropertyChange[] {
  const breakingChanges: BreakingPropertyChange[] = [];

  for (const shapeChange of shapeChanges) {
    const { comparison, functionName, filePath, line } = shapeChange;

    // Handle removed properties
    for (const removedProp of comparison.removedProperties) {
      const fullPath = `${functionName}.${removedProp}`;

      // Find all accesses to this property
      const accessLocations = findPropertyAccessLocations(
        removedProp,
        functionName,
        propertyAccesses,
        functionMap
      );

      if (accessLocations.length > 0) {
        const severity = calculateSeverity(removedProp, accessLocations.length);

        breakingChanges.push({
          propertyPath: removedProp,
          changeType: "removed",
          functionName,
          filePath,
          line,
          accessLocations,
          severity,
        });
      }
    }

    // Handle type changes
    for (const typeChange of comparison.changedTypes) {
      const fullPath = `${functionName}.${typeChange.property}`;

      // Find all accesses to this property
      const accessLocations = findPropertyAccessLocations(
        typeChange.property,
        functionName,
        propertyAccesses,
        functionMap
      );

      if (accessLocations.length > 0) {
        const severity = calculateSeverity(
          typeChange.property,
          accessLocations.length
        );

        breakingChanges.push({
          propertyPath: typeChange.property,
          changeType: "typeChanged",
          functionName,
          filePath,
          line,
          oldType: typeChange.oldType,
          newType: typeChange.newType,
          accessLocations,
          severity,
        });
      }
    }
  }

  return breakingChanges;
}

/**
 * Find all locations where a property is accessed
 */
function findPropertyAccessLocations(
  propertyPath: string,
  functionName: string,
  propertyAccesses: PropertyAccess[],
  functionMap: Map<string, { name: string; file: string }>
): Array<{
  functionName: string;
  file: string;
  line: number;
  scopeId: string;
}> {
  const locations: Array<{
    functionName: string;
    file: string;
    line: number;
    scopeId: string;
  }> = [];

  for (const access of propertyAccesses) {
    // Check if this access matches the property path
    if (
      access.propertyPath.includes(propertyPath) ||
      access.fullPath.includes(propertyPath)
    ) {
      const functionInfo = functionMap.get(access.scopeId);

      if (functionInfo) {
        locations.push({
          functionName: functionInfo.name,
          file: functionInfo.file,
          line: access.line,
          scopeId: access.scopeId,
        });
      }
    }
  }

  return locations;
}

/**
 * Calculate severity of property change
 */
function calculateSeverity(
  propertyPath: string,
  accessCount: number
): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  // Critical properties (security, identity)
  const criticalProperties = [
    "id",
    "email",
    "token",
    "password",
    "auth",
    "key",
    "secret",
    "api_key",
    "apiKey",
  ];

  // High importance properties (core data)
  const highProperties = [
    "name",
    "username",
    "user_id",
    "userId",
    "role",
    "permissions",
    "status",
  ];

  // Check if any part of the path is critical
  const pathLower = propertyPath.toLowerCase();
  for (const critical of criticalProperties) {
    if (pathLower.includes(critical)) {
      return "CRITICAL";
    }
  }

  // Check for high importance
  for (const high of highProperties) {
    if (pathLower.includes(high)) {
      return accessCount >= 5 ? "HIGH" : "MEDIUM";
    }
  }

  // Based on access count
  if (accessCount >= 10) return "HIGH";
  if (accessCount >= 5) return "MEDIUM";
  return "LOW";
}

/**
 * Generate a comprehensive shape change report
 */
export function generateShapeChangeReport(
  shapeChanges: ShapeChange[],
  breakingChanges: BreakingPropertyChange[]
): ShapeChangeReport {
  // Count impacted functions
  const impactedFunctions = new Set<string>();
  for (const breaking of breakingChanges) {
    for (const location of breaking.accessLocations) {
      impactedFunctions.add(location.scopeId);
    }
  }

  // Count by severity
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  for (const breaking of breakingChanges) {
    switch (breaking.severity) {
      case "CRITICAL":
        criticalCount++;
        break;
      case "HIGH":
        highCount++;
        break;
      case "MEDIUM":
        mediumCount++;
        break;
      case "LOW":
        lowCount++;
        break;
    }
  }

  return {
    shapeChanges,
    breakingChanges,
    totalImpactedFunctions: impactedFunctions.size,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  };
}

/**
 * Format shape change report for CLI output
 */
export function formatShapeChangeReport(report: ShapeChangeReport): string {
  let output = "\n🔄 Data Flow Changes:\n\n";

  if (report.breakingChanges.length === 0) {
    output += "  ✅ No breaking data shape changes detected\n";
    return output;
  }

  // Summary
  output += `  📊 Summary:\n`;
  output += `     Total impacted functions: ${report.totalImpactedFunctions}\n`;
  output += `     Breaking changes: ${report.breakingChanges.length}\n`;
  if (report.criticalCount > 0)
    output += `     🔴 Critical: ${report.criticalCount}\n`;
  if (report.highCount > 0) output += `     🟠 High: ${report.highCount}\n`;
  if (report.mediumCount > 0)
    output += `     🟡 Medium: ${report.mediumCount}\n`;
  if (report.lowCount > 0) output += `     🟢 Low: ${report.lowCount}\n`;
  output += "\n";

  // Group by function
  const byFunction = new Map<string, BreakingPropertyChange[]>();
  for (const breaking of report.breakingChanges) {
    const key = `${breaking.functionName}@${breaking.filePath}`;
    if (!byFunction.has(key)) {
      byFunction.set(key, []);
    }
    byFunction.get(key)!.push(breaking);
  }

  // Output each function's changes
  for (const [key, changes] of byFunction) {
    const firstChange = changes[0];
    const severityIcon = getSeverityIcon(
      Math.max(...changes.map((c) => getSeverityLevel(c.severity)))
    );

    output += `  ${severityIcon} ${firstChange.functionName}() return shape changed\n`;
    output += `     File: ${firstChange.filePath}:${firstChange.line}\n\n`;

    // Removed properties
    const removed = changes.filter((c) => c.changeType === "removed");
    if (removed.length > 0) {
      output += `     Removed properties: [${removed.map((c) => `"${c.propertyPath}"`).join(", ")}]\n\n`;

      for (const change of removed) {
        output += `     💥 ${change.propertyPath} accessed but no longer returned:\n`;
        for (const loc of change.accessLocations.slice(0, 5)) {
          output += `        • ${loc.functionName}() - ${loc.file}:${loc.line}\n`;
        }
        if (change.accessLocations.length > 5) {
          output += `        ... and ${change.accessLocations.length - 5} more\n`;
        }
        output += `        Impact: ${change.accessLocations.length} access${change.accessLocations.length > 1 ? "es" : ""} will break\n\n`;
      }
    }

    // Type changes
    const typeChanged = changes.filter((c) => c.changeType === "typeChanged");
    if (typeChanged.length > 0) {
      output += `     Changed types:\n`;
      for (const change of typeChanged) {
        output += `     ⚠️  ${change.propertyPath}: ${change.oldType} → ${change.newType}\n`;
        output += `        ${change.accessLocations.length} location${change.accessLocations.length > 1 ? "s" : ""} may be affected\n`;
      }
      output += "\n";
    }
  }

  // Warning
  if (report.criticalCount > 0 || report.highCount > 0) {
    output += `  ⚠️  DO NOT DEPLOY - ${report.totalImpactedFunctions} function${report.totalImpactedFunctions > 1 ? "s" : ""} will crash at runtime\n`;
  }

  return output;
}

/**
 * Get severity icon
 */
function getSeverityIcon(level: number): string {
  if (level >= 3) return "🔴 CRITICAL";
  if (level >= 2) return "🟠 HIGH";
  if (level >= 1) return "🟡 MEDIUM";
  return "🟢 LOW";
}

/**
 * Get severity level as number
 */
function getSeverityLevel(severity: string): number {
  switch (severity) {
    case "CRITICAL":
      return 3;
    case "HIGH":
      return 2;
    case "MEDIUM":
      return 1;
    default:
      return 0;
  }
}

/**
 * Filter shape changes by severity
 */
export function filterBySeverity(
  breakingChanges: BreakingPropertyChange[],
  minSeverity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
): BreakingPropertyChange[] {
  const minLevel = getSeverityLevel(minSeverity);
  return breakingChanges.filter(
    (change) => getSeverityLevel(change.severity) >= minLevel
  );
}

/**
 * Get all impacted function IDs from breaking changes
 */
export function getImpactedFunctionIds(
  breakingChanges: BreakingPropertyChange[]
): Set<string> {
  const ids = new Set<string>();
  for (const change of breakingChanges) {
    for (const location of change.accessLocations) {
      ids.add(location.scopeId);
    }
  }
  return ids;
}
