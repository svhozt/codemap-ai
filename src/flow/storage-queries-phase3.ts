/**
 * Phase 3 Storage Query Methods
 * Database queries for data flow analysis
 */

import type { Database } from "better-sqlite3";
import type { PropertyAccess } from "../analysis/property-tracker.js";
import type { ReturnInfo, ObjectShape } from "../analysis/return-analyzer.js";
import { randomUUID } from "crypto";

/**
 * Store property accesses in database
 */
export function storePropertyAccesses(
  db: Database,
  accesses: Array<PropertyAccess & { filePath?: string }>
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO property_accesses
    (id, scope_node_id, object_name, property_path, full_path, access_type, file_path, line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insert = db.transaction((accesses: Array<PropertyAccess & { filePath?: string }>) => {
    for (const access of accesses) {
      stmt.run(
        randomUUID(),
        access.scopeId,
        access.objectName,
        JSON.stringify(access.propertyPath),
        access.fullPath,
        access.accessType,
        access.filePath || "",
        access.line
      );
    }
  });

  insert(accesses);
}

/**
 * Store return info in database
 */
export function storeReturnInfo(db: Database, returns: ReturnInfo[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO return_shapes
    (id, function_id, return_type, object_shape, line, return_expression)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insert = db.transaction((returns: ReturnInfo[]) => {
    for (const ret of returns) {
      stmt.run(
        randomUUID(),
        ret.functionId,
        ret.returnType,
        ret.objectShape ? JSON.stringify(serializeObjectShape(ret.objectShape)) : null,
        ret.line,
        ret.returnExpression
      );
    }
  });

  insert(returns);
}

// Helper functions

function serializeObjectShape(shape: ObjectShape): any {
  return {
    properties: shape.properties,
    propertyTypes: Array.from(shape.propertyTypes.entries()),
    nestedShapes: Array.from(shape.nestedShapes.entries()).map(([key, nested]) => [
      key,
      serializeObjectShape(nested),
    ]),
    isArray: shape.isArray,
    isDictionary: shape.isDictionary,
    isOptional: shape.isOptional,
  };
}
