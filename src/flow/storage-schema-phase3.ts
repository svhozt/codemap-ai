/**
 * Phase 3 Storage Schema Extensions
 * Additional tables for data flow analysis
 */

import { Database } from "better-sqlite3";

/**
 * Create Phase 3 tables for data flow analysis
 */
export function createPhase3Tables(db: Database): void {
  // Property accesses table
  db.exec(`
    CREATE TABLE IF NOT EXISTS property_accesses (
      id TEXT PRIMARY KEY,
      scope_node_id TEXT NOT NULL,
      object_name TEXT NOT NULL,
      property_path TEXT NOT NULL,
      full_path TEXT NOT NULL,
      access_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      FOREIGN KEY (scope_node_id) REFERENCES nodes(id)
    );
  `);

  // Return shapes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS return_shapes (
      id TEXT PRIMARY KEY,
      function_id TEXT NOT NULL,
      return_type TEXT,
      object_shape TEXT,
      line INTEGER NOT NULL,
      return_expression TEXT,
      FOREIGN KEY (function_id) REFERENCES nodes(id)
    );
  `);

  // Data flows table
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_flows (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      data_type TEXT NOT NULL,
      shape TEXT,
      flow_type TEXT NOT NULL,
      line INTEGER
    );
  `);

  // Create indexes for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_property_accesses_path
      ON property_accesses(full_path);

    CREATE INDEX IF NOT EXISTS idx_property_accesses_scope
      ON property_accesses(scope_node_id);

    CREATE INDEX IF NOT EXISTS idx_property_accesses_file
      ON property_accesses(file_path);

    CREATE INDEX IF NOT EXISTS idx_return_shapes_function
      ON return_shapes(function_id);

    CREATE INDEX IF NOT EXISTS idx_data_flows_source
      ON data_flows(source_id);

    CREATE INDEX IF NOT EXISTS idx_data_flows_target
      ON data_flows(target_id);
  `);
}
