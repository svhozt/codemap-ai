/**
 * Phase 3 Storage Query Methods
 * Database queries for data flow analysis
 */

import { Database } from "better-sqlite3";
import { PropertyAccess } from "../analysis/property-tracker.js";
import { ReturnInfo, ObjectShape } from "../analysis/return-analyzer.js";
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
 * Get all property accesses for a function
 */
export function getPropertyAccesses(
  db: Database,
  scopeNodeId: string
): PropertyAccess[] {
  const stmt = db.prepare(`
    SELECT * FROM property_accesses
    WHERE scope_node_id = ?
  `);

  const rows = stmt.all(scopeNodeId) as any[];
  return rows.map(rowToPropertyAccess);
}

/**
 * Get all accesses to a specific property path
 */
export function getAccessesByPath(
  db: Database,
  fullPath: string
): PropertyAccess[] {
  const stmt = db.prepare(`
    SELECT * FROM property_accesses
    WHERE full_path = ?
  `);

  const rows = stmt.all(fullPath) as any[];
  return rows.map(rowToPropertyAccess);
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

/**
 * Get return info for a function
 */
export function getReturnInfo(db: Database, functionId: string): ReturnInfo[] {
  const stmt = db.prepare(`
    SELECT * FROM return_shapes
    WHERE function_id = ?
  `);

  const rows = stmt.all(functionId) as any[];
  return rows.map(rowToReturnInfo);
}

/**
 * Get all return info (for shape change detection)
 */
export function getAllReturnInfo(db: Database): Map<string, ReturnInfo[]> {
  const stmt = db.prepare(`SELECT * FROM return_shapes`);
  const rows = stmt.all() as any[];

  const map = new Map<string, ReturnInfo[]>();
  for (const row of rows) {
    const returnInfo = rowToReturnInfo(row);
    if (!map.has(returnInfo.functionId)) {
      map.set(returnInfo.functionId, []);
    }
    map.get(returnInfo.functionId)!.push(returnInfo);
  }

  return map;
}

/**
 * Clear Phase 3 data (for re-indexing)
 */
export function clearPhase3Data(db: Database): void {
  db.exec(`DELETE FROM property_accesses`);
  db.exec(`DELETE FROM return_shapes`);
  db.exec(`DELETE FROM data_flows`);
}

// Helper functions

function rowToPropertyAccess(row: any): PropertyAccess {
  return {
    objectName: row.object_name,
    propertyPath: JSON.parse(row.property_path),
    fullPath: row.full_path,
    line: row.line,
    scopeId: row.scope_node_id,
    accessType: row.access_type,
  };
}

function rowToReturnInfo(row: any): ReturnInfo {
  return {
    functionId: row.function_id,
    functionName: "", // Will be resolved from nodes table
    returnType: row.return_type,
    objectShape: row.object_shape ? deserializeObjectShape(JSON.parse(row.object_shape)) : null,
    line: row.line,
    returnExpression: row.return_expression,
  };
}

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

function deserializeObjectShape(data: any): ObjectShape {
  return {
    properties: data.properties,
    propertyTypes: new Map(data.propertyTypes),
    nestedShapes: new Map(
      data.nestedShapes.map(([key, nested]: [string, any]) => [
        key,
        deserializeObjectShape(nested),
      ])
    ),
    isArray: data.isArray,
    isDictionary: data.isDictionary,
    isOptional: data.isOptional,
  };
}
