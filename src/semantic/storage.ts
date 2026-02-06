/**
 * SQLite-based storage for semantic code index
 * Stores AI-generated descriptions and relationships
 */

import Database from "better-sqlite3";

export interface SemanticEntry {
  id: string;
  filePath: string;
  name: string;
  type: "file" | "function" | "class" | "method";
  startLine: number;
  endLine: number;
  description: string;
  calls: string[];
  calledBy: string[];
  hash: string;
  indexedAt: string;
}

export interface FileIndex {
  path: string;
  hash: string;
  description: string;
  entries: string[]; // IDs of entries in this file
  indexedAt: string;
}

export class SemanticStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      -- Semantic entries table (functions, classes, methods)
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        description TEXT NOT NULL,
        calls TEXT NOT NULL DEFAULT '[]',
        called_by TEXT NOT NULL DEFAULT '[]',
        hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      -- File index table
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        entries TEXT NOT NULL DEFAULT '[]',
        indexed_at TEXT NOT NULL
      );

      -- Project metadata
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Directory summaries
      CREATE TABLE IF NOT EXISTS directories (
        path TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_entries_file ON entries(file_path);
      CREATE INDEX IF NOT EXISTS idx_entries_name ON entries(name);
      CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
      CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    `);
  }

  // ============ Entry Operations ============

  insertEntry(entry: SemanticEntry): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO entries
      (id, file_path, name, type, start_line, end_line, description, calls, called_by, hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.id,
      entry.filePath,
      entry.name,
      entry.type,
      entry.startLine,
      entry.endLine,
      entry.description,
      JSON.stringify(entry.calls),
      JSON.stringify(entry.calledBy),
      entry.hash,
      entry.indexedAt
    );
  }

  getEntry(id: string): SemanticEntry | null {
    const stmt = this.db.prepare("SELECT * FROM entries WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  getEntriesByFile(filePath: string): SemanticEntry[] {
    const stmt = this.db.prepare("SELECT * FROM entries WHERE file_path = ?");
    const rows = stmt.all(filePath) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  searchEntries(query: string): SemanticEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM entries
      WHERE name LIKE ? OR description LIKE ? OR file_path LIKE ?
      LIMIT 50
    `);
    const pattern = `%${query}%`;
    const rows = stmt.all(pattern, pattern, pattern) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  getAllEntries(): SemanticEntry[] {
    const stmt = this.db.prepare("SELECT * FROM entries");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  deleteEntriesByFile(filePath: string): void {
    this.db.prepare("DELETE FROM entries WHERE file_path = ?").run(filePath);
  }

  private rowToEntry(row: Record<string, unknown>): SemanticEntry {
    return {
      id: row.id as string,
      filePath: row.file_path as string,
      name: row.name as string,
      type: row.type as SemanticEntry["type"],
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      description: row.description as string,
      calls: JSON.parse(row.calls as string),
      calledBy: JSON.parse(row.called_by as string),
      hash: row.hash as string,
      indexedAt: row.indexed_at as string,
    };
  }

  // ============ File Operations ============

  insertFile(file: FileIndex): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, hash, description, entries, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      file.path,
      file.hash,
      file.description,
      JSON.stringify(file.entries),
      file.indexedAt
    );
  }

  getFile(path: string): FileIndex | null {
    const stmt = this.db.prepare("SELECT * FROM files WHERE path = ?");
    const row = stmt.get(path) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      path: row.path as string,
      hash: row.hash as string,
      description: row.description as string,
      entries: JSON.parse(row.entries as string),
      indexedAt: row.indexed_at as string,
    };
  }

  getFileHash(path: string): string | null {
    const stmt = this.db.prepare("SELECT hash FROM files WHERE path = ?");
    const row = stmt.get(path) as { hash: string } | undefined;
    return row?.hash || null;
  }

  getAllFiles(): FileIndex[] {
    const stmt = this.db.prepare("SELECT * FROM files");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => ({
      path: row.path as string,
      hash: row.hash as string,
      description: row.description as string,
      entries: JSON.parse(row.entries as string),
      indexedAt: row.indexed_at as string,
    }));
  }

  deleteFile(path: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
    this.deleteEntriesByFile(path);
  }

  // ============ Directory Operations ============

  setDirectorySummary(path: string, description: string, fileCount: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO directories (path, description, file_count, indexed_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(path, description, fileCount, new Date().toISOString());
  }

  getDirectorySummary(path: string): { description: string; fileCount: number } | null {
    const stmt = this.db.prepare("SELECT description, file_count FROM directories WHERE path = ?");
    const row = stmt.get(path) as { description: string; file_count: number } | undefined;
    if (!row) return null;
    return { description: row.description, fileCount: row.file_count };
  }

  // ============ Metadata ============

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value || null;
  }

  // ============ Stats ============

  getStats(): {
    totalFiles: number;
    totalEntries: number;
    entriesByType: Record<string, number>;
  } {
    const totalFiles = (this.db.prepare("SELECT COUNT(*) as count FROM files").get() as { count: number }).count;
    const totalEntries = (this.db.prepare("SELECT COUNT(*) as count FROM entries").get() as { count: number }).count;

    const entriesByType: Record<string, number> = {};
    const typeRows = this.db
      .prepare("SELECT type, COUNT(*) as count FROM entries GROUP BY type")
      .all() as { type: string; count: number }[];
    for (const row of typeRows) {
      entriesByType[row.type] = row.count;
    }

    return { totalFiles, totalEntries, entriesByType };
  }

  // ============ Cleanup ============

  clear(): void {
    this.db.exec(`
      DELETE FROM entries;
      DELETE FROM files;
      DELETE FROM directories;
      DELETE FROM meta;
    `);
  }

  close(): void {
    this.db.close();
  }
}
