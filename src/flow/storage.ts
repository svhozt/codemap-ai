/**
 * Flow-focused storage for call graphs
 * Simplified from graph/storage.ts with enhanced call resolution
 */

import Database from "better-sqlite3";
import type { GraphNode, GraphEdge } from "../types.js";
import { createPhase3Tables } from "./storage-schema-phase3.js";

export interface CallPath {
  nodes: Array<{
    id: string;
    name: string;
    file: string;
    line: number;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: string;
  }>;
}

export class FlowStorage {
  public db: Database.Database; // Public for builder to access

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      -- Nodes table (enhanced with hash)
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        language TEXT NOT NULL,
        hash TEXT,
        metadata TEXT
      );

      -- Edges table (calls and related edges)
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        metadata TEXT
      );

      -- Files table
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        language TEXT NOT NULL,
        hash TEXT NOT NULL,
        analyzed_at TEXT NOT NULL
      );

      -- Exports: symbols exported by each file
      CREATE TABLE IF NOT EXISTS exports (
        file_path TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        node_id TEXT NOT NULL,
        PRIMARY KEY (file_path, symbol_name)
      );

      -- Imports: what each file imports and from where
      CREATE TABLE IF NOT EXISTS imports (
        file_path TEXT NOT NULL,
        imported_symbol TEXT NOT NULL,
        from_module TEXT NOT NULL,
        resolved_node_id TEXT,
        line INTEGER NOT NULL
      );

      -- Containers (Docker services)
      CREATE TABLE IF NOT EXISTS containers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        image TEXT,
        ports TEXT,
        environment TEXT,
        depends_on TEXT,
        networks TEXT,
        metadata TEXT
      );

      -- HTTP Endpoints (API routes)
      CREATE TABLE IF NOT EXISTS http_endpoints (
        id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        handler_node_id TEXT,
        container_id TEXT,
        middleware TEXT,
        metadata TEXT
      );

      -- HTTP Calls (client requests)
      CREATE TABLE IF NOT EXISTS http_calls (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL,
        target_endpoint_id TEXT,
        url TEXT NOT NULL,
        method TEXT NOT NULL,
        line INTEGER,
        metadata TEXT
      );

      -- Framework Dependencies (FastAPI Depends, etc.)
      CREATE TABLE IF NOT EXISTS framework_dependencies (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT,
        framework TEXT NOT NULL,
        pattern TEXT NOT NULL,
        parameter_name TEXT,
        line INTEGER,
        unresolved_name TEXT,
        metadata TEXT
      );

      -- Database Operations
      CREATE TABLE IF NOT EXISTS database_operations (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        database_type TEXT NOT NULL,
        operation TEXT NOT NULL,
        collection TEXT,
        line INTEGER,
        metadata TEXT
      );

      -- Message Queue Operations
      CREATE TABLE IF NOT EXISTS message_queue_operations (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        exchange TEXT,
        routing_key TEXT,
        queue TEXT,
        line INTEGER,
        metadata TEXT
      );

      -- Variable Type Tracking
      CREATE TABLE IF NOT EXISTS variable_types (
        id TEXT PRIMARY KEY,
        variable_name TEXT NOT NULL,
        type_name TEXT NOT NULL,
        scope_node_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        is_parameter BOOLEAN DEFAULT 0,
        metadata TEXT
      );

      -- Indexes for fast queries
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_hash ON nodes(hash);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_resolved ON edges(target_id) WHERE target_id NOT LIKE 'ref:%';
      CREATE INDEX IF NOT EXISTS idx_exports_file ON exports(file_path);
      CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);
      CREATE INDEX IF NOT EXISTS idx_http_endpoints_path ON http_endpoints(method, path);
      CREATE INDEX IF NOT EXISTS idx_http_calls_url ON http_calls(url);
      CREATE INDEX IF NOT EXISTS idx_framework_deps_source ON framework_dependencies(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_framework_deps_target ON framework_dependencies(target_node_id);
      CREATE INDEX IF NOT EXISTS idx_variable_types_scope ON variable_types(scope_node_id, variable_name);
      CREATE INDEX IF NOT EXISTS idx_variable_types_file ON variable_types(file_path, variable_name);
    `);

    // Create Phase 3 tables
    createPhase3Tables(this.db);
  }

  // ============ Node Operations ============

  insertNode(node: GraphNode & { hash?: string }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (id, type, name, file_path, start_line, end_line, language, hash, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      node.id,
      node.type,
      node.name,
      node.filePath,
      node.startLine,
      node.endLine,
      node.language,
      node.hash || null,
      node.metadata ? JSON.stringify(node.metadata) : null
    );
  }

  getNode(id: string): GraphNode | null {
    const stmt = this.db.prepare("SELECT * FROM nodes WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToNode(row);
  }

  searchNodesByName(name: string): GraphNode[] {
    const stmt = this.db.prepare("SELECT * FROM nodes WHERE name = ? OR name LIKE ?");
    const rows = stmt.all(name, `%${name}%`) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  getNodesByFile(filePath: string): GraphNode[] {
    const stmt = this.db.prepare("SELECT * FROM nodes WHERE file_path = ?");
    const rows = stmt.all(filePath) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  private rowToNode(row: Record<string, unknown>): GraphNode {
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

  // ============ Call Graph Queries ============

  /**
   * Get all resolved callees (functions this node calls)
   */
  getResolvedCallees(nodeId: string): GraphNode[] {
    const stmt = this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN edges e ON n.id = e.target_id
      WHERE e.source_id = ? AND e.type = 'calls' AND e.target_id NOT LIKE 'ref:%'
    `);
    const rows = stmt.all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  /**
   * Get all resolved callers (functions that call this node)
   */
  getResolvedCallers(nodeId: string): GraphNode[] {
    const stmt = this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN edges e ON n.id = e.source_id
      WHERE e.target_id = ? AND e.type = 'calls'
    `);
    const rows = stmt.all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  /**
   * Get impact: all nodes affected by changes to this node (BFS traversal)
   */
  getImpactedNodes(nodeId: string, maxDepth: number = 3): GraphNode[] {
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;

      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const callers = this.getResolvedCallers(id);
      for (const caller of callers) {
        if (!visited.has(caller.id)) {
          result.push(caller);
          queue.push({ id: caller.id, depth: depth + 1 });
        }
      }
    }

    return result;
  }

  /**
   * Trace call path from source to target using BFS
   */
  traceCallPath(fromId: string, toId: string): CallPath | null {
    const visited = new Set<string>();
    const parent = new Map<string, { nodeId: string; edgeType: string }>();
    const queue: string[] = [fromId];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current === toId) {
        // Reconstruct path
        const path: string[] = [];
        let node = toId;
        while (node !== fromId) {
          path.unshift(node);
          node = parent.get(node)!.nodeId;
        }
        path.unshift(fromId);

        // Get node details
        const nodes = path.map((id) => {
          const n = this.getNode(id);
          return {
            id: n!.id,
            name: n!.name,
            file: n!.filePath,
            line: n!.startLine,
          };
        });

        const edges = [];
        for (let i = 0; i < path.length - 1; i++) {
          edges.push({
            from: path[i],
            to: path[i + 1],
            type: 'calls',
          });
        }

        return { nodes, edges };
      }

      if (visited.has(current)) continue;
      visited.add(current);

      const callees = this.getResolvedCallees(current);
      for (const callee of callees) {
        if (!visited.has(callee.id)) {
          parent.set(callee.id, { nodeId: current, edgeType: 'calls' });
          queue.push(callee.id);
        }
      }
    }

    return null;
  }

  // ============ Export/Import Tracking ============

  registerExport(filePath: string, symbolName: string, nodeId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO exports (file_path, symbol_name, node_id)
      VALUES (?, ?, ?)
    `);
    stmt.run(filePath, symbolName, nodeId);
  }

  registerImport(filePath: string, symbol: string, fromModule: string, line: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO imports (file_path, imported_symbol, from_module, line)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(filePath, symbol, fromModule, line);
  }

  resolveImport(filePath: string, symbol: string): string | null {
    // Get the import statement
    const importStmt = this.db.prepare(`
      SELECT from_module FROM imports WHERE file_path = ? AND imported_symbol = ?
    `).get(filePath, symbol) as { from_module: string } | undefined;

    if (!importStmt) return null;

    // Convert module path to possible file paths
    // Examples:
    // - "backend.authentication" -> ["backend/authentication.py", "backend/authentication/__init__.py"]
    // - "..authentication" -> relative import (handle separately)
    const modulePath = importStmt.from_module;
    const possiblePaths = this.resolvePythonModulePath(filePath, modulePath);

    // Try each possible path
    for (const targetPath of possiblePaths) {
      const exportStmt = this.db.prepare(`
        SELECT node_id FROM exports WHERE file_path = ? AND symbol_name = ?
      `).get(targetPath, symbol) as { node_id: string } | undefined;

      if (exportStmt) {
        return exportStmt.node_id;
      }
    }

    return null;
  }

  /**
   * Resolve a Python module path to possible file paths
   * Handles: absolute imports, relative imports, __init__.py
   */
  private resolvePythonModulePath(currentFile: string, modulePath: string): string[] {
    const possiblePaths: string[] = [];

    // Handle relative imports (from . import x, from .. import y)
    if (modulePath.startsWith(".")) {
      const currentDir = currentFile.substring(0, currentFile.lastIndexOf("/"));
      const depth = modulePath.match(/^\.+/)?.[0].length || 0;
      const moduleName = modulePath.replace(/^\.+/, "");

      // Go up directories based on depth
      let targetDir = currentDir;
      for (let i = 1; i < depth; i++) {
        const lastSlash = targetDir.lastIndexOf("/");
        if (lastSlash > 0) {
          targetDir = targetDir.substring(0, lastSlash);
        }
      }

      if (moduleName) {
        const relativePath = moduleName.replace(/\./g, "/");
        possiblePaths.push(`${targetDir}/${relativePath}.py`);
        possiblePaths.push(`${targetDir}/${relativePath}/__init__.py`);
      } else {
        possiblePaths.push(`${targetDir}/__init__.py`);
      }
    } else {
      // Absolute import - convert dots to slashes
      const pathComponents = modulePath.split(".");

      // Try different interpretations
      // 1. Full path as file: backend.authentication -> backend/authentication.py
      const filePath = pathComponents.join("/");
      possiblePaths.push(`${filePath}.py`);
      possiblePaths.push(`${filePath}/__init__.py`);

      // 2. Try with src/ prefix (common pattern)
      possiblePaths.push(`src/${filePath}.py`);
      possiblePaths.push(`src/${filePath}/__init__.py`);

      // 3. Query actual files to find match
      // Get all files that end with the last component
      const lastComponent = pathComponents[pathComponents.length - 1];
      const matchingFiles = this.db.prepare(`
        SELECT DISTINCT file_path FROM exports
        WHERE file_path LIKE ?
      `).all(`%/${lastComponent}.py`) as Array<{ file_path: string }>;

      for (const file of matchingFiles) {
        // Check if the file path ends with the module path
        const normalizedFilePath = file.file_path.replace(/\\/g, "/");
        if (normalizedFilePath.includes(filePath)) {
          possiblePaths.push(normalizedFilePath);
        }
      }
    }

    return possiblePaths;
  }

  /**
   * Resolve a class method call like ClassName.method_name
   * Handles: static methods, class methods, imported classes
   */
  resolveClassMethod(className: string, methodName: string, callerFilePath: string): string | null {
    // Strategy 1: Check if the class is imported in the caller file
    const classNodeId = this.resolveImport(callerFilePath, className);

    if (classNodeId) {
      // Find the method within this class
      const methods = this.db.prepare(`
        SELECT target_id FROM edges
        WHERE source_id = ? AND type = 'contains'
      `).all(classNodeId) as Array<{ target_id: string }>;

      for (const edge of methods) {
        const methodNode = this.getNode(edge.target_id);
        if (methodNode && methodNode.name === methodName) {
          return methodNode.id;
        }
      }
    }

    // Strategy 2: Search for class in the same file
    const classNode = this.db.prepare(`
      SELECT id FROM nodes
      WHERE file_path = ? AND name = ? AND type = 'class'
    `).get(callerFilePath, className) as { id: string } | undefined;

    if (classNode) {
      // Find the method within this class
      const methodNode = this.db.prepare(`
        SELECT n.id FROM nodes n
        JOIN edges e ON e.target_id = n.id
        WHERE e.source_id = ? AND e.type = 'contains' AND n.name = ?
      `).get(classNode.id, methodName) as { id: string } | undefined;

      if (methodNode) {
        return methodNode.id;
      }
    }

    // Strategy 3: Search globally for the class
    const allClasses = this.db.prepare(`
      SELECT id FROM nodes WHERE name = ? AND type = 'class'
    `).all(className) as Array<{ id: string }>;

    for (const cls of allClasses) {
      const methodNode = this.db.prepare(`
        SELECT n.id FROM nodes n
        JOIN edges e ON e.target_id = n.id
        WHERE e.source_id = ? AND e.type = 'contains' AND n.name = ?
      `).get(cls.id, methodName) as { id: string } | undefined;

      if (methodNode) {
        return methodNode.id;
      }
    }

    return null;
  }

  // ============ Variable Type Tracking ============

  /**
   * Register a variable type (from assignment or parameter)
   */
  registerVariableType(
    variableName: string,
    typeName: string,
    scopeNodeId: string,
    filePath: string,
    line: number,
    isParameter: boolean = false
  ): void {
    const id = `${scopeNodeId}:var:${variableName}`;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO variable_types
        (id, variable_name, type_name, scope_node_id, file_path, line, is_parameter)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, variableName, typeName, scopeNodeId, filePath, line, isParameter ? 1 : 0);
  }

  /**
   * Resolve variable.method to actual method node
   * Example: user.get_name() where user is of type User
   */
  resolveVariableMethod(variableName: string, methodName: string, scopeNodeId: string): string | null {
    // Special case: self.method calls - resolve to methods in parent class
    if (variableName === "self") {
      return this.resolveSelfMethod(methodName, scopeNodeId);
    }

    // Get the variable's type
    const varType = this.db.prepare(`
      SELECT type_name FROM variable_types
      WHERE scope_node_id = ? AND variable_name = ?
    `).get(scopeNodeId, variableName) as { type_name: string } | undefined;

    if (!varType) {
      return null;
    }

    // Now resolve ClassName.method_name
    return this.resolveClassMethod(varType.type_name, methodName, "");
  }

  /**
   * Resolve self.method() calls to methods in the same class
   */
  private resolveSelfMethod(methodName: string, scopeNodeId: string): string | null {
    // Find the parent class of this method
    const parentClass = this.db.prepare(`
      SELECT source_id FROM edges
      WHERE target_id = ? AND type = 'contains'
    `).get(scopeNodeId) as { source_id: string } | undefined;

    if (!parentClass) {
      return null;
    }

    // Find the method with this name in the same class
    const method = this.db.prepare(`
      SELECT n.id FROM nodes n
      JOIN edges e ON e.target_id = n.id
      WHERE e.source_id = ? AND e.type = 'contains' AND n.name = ?
    `).get(parentClass.source_id, methodName) as { id: string } | undefined;

    return method?.id || null;
  }

  /**
   * Resolve super().method() calls to parent class methods
   */
  resolveSuperMethod(methodName: string, scopeNodeId: string): string | null {
    // Find the parent class of the current method
    const parentClass = this.db.prepare(`
      SELECT source_id FROM edges
      WHERE target_id = ? AND type = 'contains'
    `).get(scopeNodeId) as { source_id: string } | undefined;

    if (!parentClass) {
      return null;
    }

    // Get the class node
    const classNode = this.getNode(parentClass.source_id);
    if (!classNode || classNode.type !== 'class') {
      return null;
    }

    // Find the parent class (via extends edge)
    const baseClass = this.db.prepare(`
      SELECT target_id FROM edges
      WHERE source_id = ? AND type = 'extends'
    `).get(classNode.id) as { target_id: string } | undefined;

    if (!baseClass) {
      return null;
    }

    // The target might be a ref, resolve it first
    let baseClassId = baseClass.target_id;
    if (baseClassId.startsWith('ref:')) {
      const baseClassName = baseClassId.replace('ref:', '');
      // Search for the class by name
      const resolvedClass = this.db.prepare(`
        SELECT id FROM nodes WHERE name = ? AND type = 'class'
      `).get(baseClassName) as { id: string } | undefined;

      if (!resolvedClass) {
        return null;
      }
      baseClassId = resolvedClass.id;
    }

    // Find the method in the parent class
    const method = this.db.prepare(`
      SELECT n.id FROM nodes n
      JOIN edges e ON e.target_id = n.id
      WHERE e.source_id = ? AND e.type = 'contains' AND n.name = ?
    `).get(baseClassId, methodName) as { id: string } | undefined;

    return method?.id || null;
  }

  // ============ File Operations ============

  upsertFile(filePath: string, language: string, hash: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, language, hash, analyzed_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(filePath, language, hash, new Date().toISOString());
  }

  getFileHash(filePath: string): string | null {
    const stmt = this.db.prepare("SELECT hash FROM files WHERE path = ?");
    const row = stmt.get(filePath) as { hash: string } | undefined;
    return row?.hash || null;
  }

  deleteFileData(filePath: string): void {
    this.db.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM exports WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM imports WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
  }

  // ============ Stats ============

  getStats(): {
    totalFiles: number;
    totalNodes: number;
    totalEdges: number;
    resolvedCalls: number;
    unresolvedCalls: number;
    httpEndpoints: number;
    frameworkDependencies: number;
    resolvedDependencies: number;
    containers: number;
  } {
    const totalFiles = (this.db.prepare("SELECT COUNT(*) as count FROM files").get() as { count: number }).count;
    const totalNodes = (this.db.prepare("SELECT COUNT(*) as count FROM nodes").get() as { count: number }).count;
    const totalEdges = (this.db.prepare("SELECT COUNT(*) as count FROM edges WHERE type = 'calls'").get() as { count: number }).count;
    const resolvedCalls = (this.db.prepare("SELECT COUNT(*) as count FROM edges WHERE type = 'calls' AND target_id NOT LIKE 'ref:%'").get() as { count: number }).count;
    const unresolvedCalls = totalEdges - resolvedCalls;
    const httpEndpoints = (this.db.prepare("SELECT COUNT(*) as count FROM http_endpoints").get() as { count: number }).count;
    const frameworkDependencies = (this.db.prepare("SELECT COUNT(*) as count FROM framework_dependencies").get() as { count: number }).count;
    const resolvedDependencies = (this.db.prepare("SELECT COUNT(*) as count FROM framework_dependencies WHERE target_node_id IS NOT NULL").get() as { count: number }).count;
    const containers = (this.db.prepare("SELECT COUNT(*) as count FROM containers").get() as { count: number }).count;

    return {
      totalFiles,
      totalNodes,
      totalEdges,
      resolvedCalls,
      unresolvedCalls,
      httpEndpoints,
      frameworkDependencies,
      resolvedDependencies,
      containers,
    };
  }

  // ============ Container Operations ============

  insertContainer(container: {
    id: string;
    name: string;
    image?: string;
    ports?: Array<{ host: number; container: number }>;
    environment?: Record<string, string>;
    depends_on?: string[];
    networks?: string[];
    metadata?: Record<string, unknown>;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO containers (id, name, image, ports, environment, depends_on, networks, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      container.id,
      container.name,
      container.image || null,
      container.ports ? JSON.stringify(container.ports) : null,
      container.environment ? JSON.stringify(container.environment) : null,
      container.depends_on ? JSON.stringify(container.depends_on) : null,
      container.networks ? JSON.stringify(container.networks) : null,
      container.metadata ? JSON.stringify(container.metadata) : null
    );
  }

  getContainer(id: string): any | null {
    const stmt = this.db.prepare("SELECT * FROM containers WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      image: row.image,
      ports: row.ports ? JSON.parse(row.ports as string) : [],
      environment: row.environment ? JSON.parse(row.environment as string) : {},
      depends_on: row.depends_on ? JSON.parse(row.depends_on as string) : [],
      networks: row.networks ? JSON.parse(row.networks as string) : [],
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    };
  }

  getAllContainers(): any[] {
    const stmt = this.db.prepare("SELECT * FROM containers");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      image: row.image,
      ports: row.ports ? JSON.parse(row.ports as string) : [],
      environment: row.environment ? JSON.parse(row.environment as string) : {},
      depends_on: row.depends_on ? JSON.parse(row.depends_on as string) : [],
      networks: row.networks ? JSON.parse(row.networks as string) : [],
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    }));
  }

  // ============ HTTP Endpoint Operations ============

  insertHttpEndpoint(endpoint: {
    id: string;
    method: string;
    path: string;
    handler_node_id?: string;
    container_id?: string;
    middleware?: string[];
    metadata?: Record<string, unknown>;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO http_endpoints (id, method, path, handler_node_id, container_id, middleware, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      endpoint.id,
      endpoint.method,
      endpoint.path,
      endpoint.handler_node_id || null,
      endpoint.container_id || null,
      endpoint.middleware ? JSON.stringify(endpoint.middleware) : null,
      endpoint.metadata ? JSON.stringify(endpoint.metadata) : null
    );
  }

  insertDatabaseOperation(dbOp: {
    id: string;
    node_id: string;
    database_type: string;
    operation: string;
    collection?: string;
    line?: number;
    metadata?: Record<string, unknown>;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO database_operations (id, node_id, database_type, operation, collection, line, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      dbOp.id,
      dbOp.node_id,
      dbOp.database_type,
      dbOp.operation,
      dbOp.collection || null,
      dbOp.line || null,
      dbOp.metadata ? JSON.stringify(dbOp.metadata) : null
    );
  }

  findHttpEndpoint(method: string, path: string): any | null {
    const stmt = this.db.prepare("SELECT * FROM http_endpoints WHERE method = ? AND path = ?");
    const row = stmt.get(method, path) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id,
      method: row.method,
      path: row.path,
      handler_node_id: row.handler_node_id,
      container_id: row.container_id,
      middleware: row.middleware ? JSON.parse(row.middleware as string) : [],
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    };
  }

  // ============ Framework Dependency Operations ============

  insertFrameworkDependency(dep: {
    id: string;
    source_node_id: string;
    target_node_id?: string;
    framework: string;
    pattern: string;
    parameter_name?: string;
    line?: number;
    unresolved_name?: string;
    metadata?: Record<string, unknown>;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO framework_dependencies
      (id, source_node_id, target_node_id, framework, pattern, parameter_name, line, unresolved_name, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      dep.id,
      dep.source_node_id,
      dep.target_node_id || null,
      dep.framework,
      dep.pattern,
      dep.parameter_name || null,
      dep.line || null,
      dep.unresolved_name || null,
      dep.metadata ? JSON.stringify(dep.metadata) : null
    );
  }

  getFrameworkDependencies(sourceNodeId: string): any[] {
    const stmt = this.db.prepare("SELECT * FROM framework_dependencies WHERE source_node_id = ?");
    const rows = stmt.all(sourceNodeId) as Record<string, unknown>[];
    return rows.map(row => ({
      id: row.id,
      source_node_id: row.source_node_id,
      target_node_id: row.target_node_id,
      framework: row.framework,
      pattern: row.pattern,
      parameter_name: row.parameter_name,
      line: row.line,
      unresolved_name: row.unresolved_name,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    }));
  }

  getAllUnresolvedDependencies(): any[] {
    const stmt = this.db.prepare("SELECT * FROM framework_dependencies WHERE target_node_id IS NULL");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => ({
      id: row.id,
      source_node_id: row.source_node_id,
      framework: row.framework,
      pattern: row.pattern,
      unresolved_name: row.unresolved_name,
      line: row.line,
    }));
  }

  updateFrameworkDependencyTarget(id: string, targetNodeId: string): void {
    const stmt = this.db.prepare("UPDATE framework_dependencies SET target_node_id = ? WHERE id = ?");
    stmt.run(targetNodeId, id);
  }

  clear(): void {
    this.db.exec(`
      DELETE FROM nodes;
      DELETE FROM edges;
      DELETE FROM files;
      DELETE FROM exports;
      DELETE FROM imports;
      DELETE FROM containers;
      DELETE FROM http_endpoints;
      DELETE FROM http_calls;
      DELETE FROM framework_dependencies;
      DELETE FROM database_operations;
      DELETE FROM message_queue_operations;
    `);
  }

  /**
   * Get all file hashes (for detecting changes)
   */
  getAllFileHashes(): Record<string, string> {
    const stmt = this.db.prepare("SELECT path, hash FROM files WHERE hash IS NOT NULL");
    const rows = stmt.all() as Array<{ path: string; hash: string }>;
    const hashes: Record<string, string> = {};
    for (const row of rows) {
      hashes[row.path] = row.hash;
    }
    return hashes;
  }

  /**
   * Get all nodes (for impact comparison)
   */
  getAllNodes(): Array<{ id: string; name: string; type: string; filePath: string }> {
    const stmt = this.db.prepare("SELECT id, name, type, file_path FROM nodes");
    return stmt.all() as Array<{ id: string; name: string; type: string; filePath: string }>;
  }

  /**
   * Get all edges (for impact comparison)
   */
  getAllEdges(): Array<{ id: string; source_id: string; target_id: string; type: string }> {
    const stmt = this.db.prepare("SELECT id, source_id, target_id, type FROM edges");
    return stmt.all() as Array<{ id: string; source_id: string; target_id: string; type: string }>;
  }

  /**
   * Get resolved callers with file/line info (for impact analysis)
   */
  getResolvedCallersWithLocation(nodeId: string): Array<{ id: string; name: string; file: string; line: number }> {
    const stmt = this.db.prepare(`
      SELECT n.id, n.name, n.file_path as file, n.start_line as line
      FROM edges e
      JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ? AND e.type = 'calls' AND e.target_id NOT LIKE 'ref:%'
    `);
    return stmt.all(nodeId) as Array<{ id: string; name: string; file: string; line: number }>;
  }

  /**
   * Get HTTP endpoints by handler node ID
   */
  getHttpEndpointsByHandler(handlerNodeId: string): Array<{ method: string; path: string }> {
    const stmt = this.db.prepare("SELECT method, path FROM http_endpoints WHERE handler_node_id = ?");
    return stmt.all(handlerNodeId) as Array<{ method: string; path: string }>;
  }

  close(): void {
    this.db.close();
  }
}
