/**
 * Phase 3 Impact Analysis
 * Detect and report data flow breaking changes
 */

import { FlowStorage } from "../flow/storage.js";
import { getAllReturnInfo } from "../flow/storage-queries-phase3.js";
import {
  detectShapeChanges,
  findBreakingPropertyChanges,
  generateShapeChangeReport,
  formatShapeChangeReport,
} from "../analysis/shape-change-detector.js";
import { getAccessesByPath } from "../flow/storage-queries-phase3.js";

/**
 * Run Phase 3 impact analysis
 */
export async function analyzeDataFlowImpact(
  storage: FlowStorage
): Promise<string> {
  try {
    // Get current return info
    const currentReturnInfo = getAllReturnInfo(storage.db);

    if (currentReturnInfo.size === 0) {
      return "\n🔄 Data Flow Analysis:\n  ℹ️  No return shape data available. Run 'codemap index' first.\n";
    }

    // For now, we compare against itself (no git diff integration yet)
    // In full implementation, this would compare old vs new from git diff
    const shapeChanges = detectShapeChanges(currentReturnInfo, currentReturnInfo);

    if (shapeChanges.length === 0) {
      return "\n🔄 Data Flow Analysis:\n  ✅ No breaking data shape changes detected\n";
    }

    // Get all property accesses from database
    const allAccesses = storage.db
      .prepare(`SELECT * FROM property_accesses`)
      .all() as any[];

    // Build function map for access locations
    const functionMap = new Map<string, { name: string; file: string }>();
    const nodes = storage.db.prepare(`SELECT id, name, file_path FROM nodes`).all() as any[];
    for (const node of nodes) {
      functionMap.set(node.id, { name: node.name, file: node.file_path });
    }

    // Find breaking changes
    const breakingChanges = findBreakingPropertyChanges(
      shapeChanges,
      allAccesses.map((row) => ({
        objectName: row.object_name,
        propertyPath: JSON.parse(row.property_path),
        fullPath: row.full_path,
        line: row.line,
        scopeId: row.scope_node_id,
        accessType: row.access_type,
      })),
      functionMap
    );

    // Generate report
    const report = generateShapeChangeReport(shapeChanges, breakingChanges);
    return formatShapeChangeReport(report);
  } catch (error) {
    console.error("Error in Phase 3 analysis:", error);
    return "\n🔄 Data Flow Analysis:\n  ⚠️  Error analyzing data flow (Phase 3 in progress)\n";
  }
}

/**
 * Get Phase 3 statistics for display
 */
export function getPhase3Stats(storage: FlowStorage): {
  propertyAccesses: number;
  returnShapes: number;
  hasData: boolean;
} {
  const accessCount = storage.db
    .prepare(`SELECT COUNT(*) as count FROM property_accesses`)
    .get() as { count: number };

  const returnCount = storage.db
    .prepare(`SELECT COUNT(*) as count FROM return_shapes`)
    .get() as { count: number };

  return {
    propertyAccesses: accessCount.count,
    returnShapes: returnCount.count,
    hasData: accessCount.count > 0 || returnCount.count > 0,
  };
}
