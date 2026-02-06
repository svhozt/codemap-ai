/**
 * SQLite-based graph storage
 */

import Database from "better-sqlite3";
import type { GraphNode, GraphEdge, FileAnalysis, ProjectAnalysis } from "../types.js";

export class GraphStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      -- Nodes table
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        language TEXT NOT NULL,
        metadata TEXT
      );

      -- Edges table
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        metadata TEXT
      );

      -- Files table for tracking analyzed files
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        language TEXT NOT NULL,
        last_modified INTEGER,
        analyzed_at TEXT NOT NULL
      );

      -- Imports table
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        source TEXT NOT NULL,
        specifiers TEXT NOT NULL,
        is_default INTEGER NOT NULL,
        is_namespace INTEGER NOT NULL,
        line INTEGER NOT NULL
      );

      -- Exports table
      CREATE TABLE IF NOT EXISTS exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL,
        line INTEGER NOT NULL
      );

      -- Project metadata
      CREATE TABLE IF NOT EXISTS project_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Indexes for faster queries
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
      CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);
      CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source);
      CREATE INDEX IF NOT EXISTS idx_exports_file ON exports(file_path);
    `);
  }

  // ============ Node Operations ============

  insertNode(node: GraphNode): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (id, type, name, file_path, start_line, end_line, language, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      node.id,
      node.type,
      node.name,
      node.filePath,
      node.startLine,
      node.endLine,
      node.language,
      node.metadata ? JSON.stringify(node.metadata) : null
    );
  }

  getNode(id: string): GraphNode | null {
    const stmt = this.db.prepare("SELECT * FROM nodes WHERE id = ?");
    const row = stmt.get(id) as any;
    if (!row) return null;
    return this.rowToNode(row);
  }

  getNodesByFile(filePath: string): GraphNode[] {
    const stmt = this.db.prepare("SELECT * FROM nodes WHERE file_path = ?");
    const rows = stmt.all(filePath) as any[];
    return rows.map(this.rowToNode);
  }

  getNodesByType(type: string): GraphNode[] {
    const stmt = this.db.prepare("SELECT * FROM nodes WHERE type = ?");
    const rows = stmt.all(type) as any[];
    return rows.map(this.rowToNode);
  }

  searchNodes(query: string): GraphNode[] {
    const stmt = this.db.prepare(
      "SELECT * FROM nodes WHERE name LIKE ? OR file_path LIKE ?"
    );
    const pattern = `%${query}%`;
    const rows = stmt.all(pattern, pattern) as any[];
    return rows.map(this.rowToNode);
  }

  getAllNodes(): GraphNode[] {
    const stmt = this.db.prepare("SELECT * FROM nodes");
    const rows = stmt.all() as any[];
    return rows.map(this.rowToNode);
  }

  private rowToNode(row: any): GraphNode {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      language: row.language,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  // ============ Edge Operations ============

  insertEdge(edge: GraphEdge): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO edges (id, type, source_id, target_id, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      edge.id,
      edge.type,
      edge.sourceId,
      edge.targetId,
      edge.metadata ? JSON.stringify(edge.metadata) : null
    );
  }

  getEdgesFrom(sourceId: string): GraphEdge[] {
    const stmt = this.db.prepare("SELECT * FROM edges WHERE source_id = ?");
    const rows = stmt.all(sourceId) as any[];
    return rows.map(this.rowToEdge);
  }

  getEdgesTo(targetId: string): GraphEdge[] {
    const stmt = this.db.prepare("SELECT * FROM edges WHERE target_id = ?");
    const rows = stmt.all(targetId) as any[];
    return rows.map(this.rowToEdge);
  }

  getEdgesByType(type: string): GraphEdge[] {
    const stmt = this.db.prepare("SELECT * FROM edges WHERE type = ?");
    const rows = stmt.all(type) as any[];
    return rows.map(this.rowToEdge);
  }

  getAllEdges(): GraphEdge[] {
    const stmt = this.db.prepare("SELECT * FROM edges");
    const rows = stmt.all() as any[];
    return rows.map(this.rowToEdge);
  }

  private rowToEdge(row: any): GraphEdge {
    return {
      id: row.id,
      type: row.type,
      sourceId: row.source_id,
      targetId: row.target_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  // ============ File Analysis Operations ============

  insertFileAnalysis(analysis: FileAnalysis): void {
    const transaction = this.db.transaction(() => {
      // Delete old data for this file
      this.deleteFileData(analysis.filePath);

      // Insert file record
      const fileStmt = this.db.prepare(`
        INSERT OR REPLACE INTO files (path, language, analyzed_at)
        VALUES (?, ?, ?)
      `);
      fileStmt.run(analysis.filePath, analysis.language, new Date().toISOString());

      // Insert nodes
      for (const node of analysis.nodes) {
        this.insertNode(node);
      }

      // Insert edges
      for (const edge of analysis.edges) {
        this.insertEdge(edge);
      }

      // Insert imports
      const importStmt = this.db.prepare(`
        INSERT INTO imports (file_path, source, specifiers, is_default, is_namespace, line)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const imp of analysis.imports) {
        importStmt.run(
          analysis.filePath,
          imp.source,
          JSON.stringify(imp.specifiers),
          imp.isDefault ? 1 : 0,
          imp.isNamespace ? 1 : 0,
          imp.line
        );
      }

      // Insert exports
      const exportStmt = this.db.prepare(`
        INSERT INTO exports (file_path, name, is_default, line)
        VALUES (?, ?, ?, ?)
      `);
      for (const exp of analysis.exports) {
        exportStmt.run(analysis.filePath, exp.name, exp.isDefault ? 1 : 0, exp.line);
      }
    });

    transaction();
  }

  deleteFileData(filePath: string): void {
    this.db.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM imports WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM exports WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
    // Note: Edges are more complex, we keep them and clean up later
  }

  // ============ Query Operations ============

  /**
   * Get all files that import from a given file/module
   */
  getFilesThatImport(modulePath: string): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT file_path FROM imports
      WHERE source LIKE ? OR source LIKE ?
    `);
    // Match both relative and absolute imports
    const rows = stmt.all(`%${modulePath}%`, modulePath) as any[];
    return rows.map((r) => r.file_path);
  }

  /**
   * Get all callers of a function/method
   */
  getCallers(nodeName: string): GraphNode[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT n.* FROM nodes n
      JOIN edges e ON n.id = e.source_id
      WHERE e.type = 'calls' AND e.target_id LIKE ?
    `);
    const rows = stmt.all(`%${nodeName}%`) as any[];
    return rows.map(this.rowToNode);
  }

  /**
   * Get all functions/methods called by a node
   */
  getCallees(nodeId: string): { name: string; line?: number }[] {
    const stmt = this.db.prepare(`
      SELECT target_id, metadata FROM edges
      WHERE source_id = ? AND type = 'calls'
    `);
    const rows = stmt.all(nodeId) as any[];
    return rows.map((r) => ({
      name: r.target_id.replace("ref:", ""),
      line: r.metadata ? JSON.parse(r.metadata).line : undefined,
    }));
  }

  /**
   * Get the dependency tree for a file
   */
  getFileDependencies(filePath: string): { imports: string[]; importedBy: string[] } {
    const importsStmt = this.db.prepare(
      "SELECT DISTINCT source FROM imports WHERE file_path = ?"
    );
    const imports = (importsStmt.all(filePath) as any[]).map((r) => r.source);

    const importedBy = this.getFilesThatImport(
      filePath.replace(/\.(ts|tsx|js|jsx|py)$/, "")
    );

    return { imports, importedBy };
  }

  /**
   * Get statistics about the graph
   */
  getStats(): {
    totalFiles: number;
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
    languages: Record<string, number>;
  } {
    const totalFiles =
      (this.db.prepare("SELECT COUNT(*) as count FROM files").get() as any).count;
    const totalNodes =
      (this.db.prepare("SELECT COUNT(*) as count FROM nodes").get() as any).count;
    const totalEdges =
      (this.db.prepare("SELECT COUNT(*) as count FROM edges").get() as any).count;

    const nodesByType: Record<string, number> = {};
    const nodeTypeRows = this.db
      .prepare("SELECT type, COUNT(*) as count FROM nodes GROUP BY type")
      .all() as any[];
    for (const row of nodeTypeRows) {
      nodesByType[row.type] = row.count;
    }

    const edgesByType: Record<string, number> = {};
    const edgeTypeRows = this.db
      .prepare("SELECT type, COUNT(*) as count FROM edges GROUP BY type")
      .all() as any[];
    for (const row of edgeTypeRows) {
      edgesByType[row.type] = row.count;
    }

    const languages: Record<string, number> = {};
    const langRows = this.db
      .prepare("SELECT language, COUNT(*) as count FROM files GROUP BY language")
      .all() as any[];
    for (const row of langRows) {
      languages[row.language] = row.count;
    }

    return {
      totalFiles,
      totalNodes,
      totalEdges,
      nodesByType,
      edgesByType,
      languages,
    };
  }

  // ============ Graph Export ============

  exportForVisualization(): {
    nodes: Array<{ id: string; label: string; type: string; file: string }>;
    edges: Array<{ source: string; target: string; type: string }>;
  } {
    const nodes = this.getAllNodes().map((n) => ({
      id: n.id,
      label: n.name,
      type: n.type,
      file: n.filePath,
    }));

    const edges = this.getAllEdges()
      .filter((e) => !e.targetId.startsWith("ref:")) // Only resolved edges
      .map((e) => ({
        source: e.sourceId,
        target: e.targetId,
        type: e.type,
      }));

    return { nodes, edges };
  }

  // ============ Cleanup ============

  clear(): void {
    this.db.exec(`
      DELETE FROM nodes;
      DELETE FROM edges;
      DELETE FROM files;
      DELETE FROM imports;
      DELETE FROM exports;
    `);
  }

  close(): void {
    this.db.close();
  }

  // ============ Metadata ============

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES (?, ?)").run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM project_meta WHERE key = ?").get(key) as any;
    return row?.value || null;
  }
}
