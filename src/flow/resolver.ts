/**
 * Call resolver
 *
 * Parsers emit edges whose target is an unresolved reference (`ref:<name>`).
 * This module turns those references into node ids using, in order:
 *
 *   1. scope rules      - same-file definitions, imports (including aliases,
 *                         re-exports, barrel files and star imports)
 *   2. class knowledge  - self/this/super calls through the inheritance chain
 *   3. type knowledge   - `x = Foo()`, `x: Foo`, `self.repo = Repo()` etc.
 *   4. a last-resort heuristic for method calls on receivers of unknown type:
 *      a distinctive method name that exists exactly once in the project
 *
 * Names are always matched exactly, and Python never resolves to JS/TS or the
 * other way round. A reference that cannot be resolved with reasonable
 * confidence stays unresolved: for impact analysis a missing edge is better
 * than a wrong one.
 */

import type { FlowStorage } from "./storage.js";
import { ModuleResolver, languageFamily, type LanguageFamily } from "./module-resolver.js";

interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  family: LanguageFamily;
}

interface Binding {
  module: string;
  /** Name inside the module; "*" = the module itself, "default" = default export. */
  original: string;
}

type Target = { kind: "node"; id: string } | { kind: "module"; file: string } | null;

export type ResolutionMethod = "scope" | "class" | "type" | "heuristic";

export interface Resolution {
  id: string;
  by: ResolutionMethod;
}

const SELF_NAMES = new Set(["self", "this", "cls"]);

/** Receivers that are never project objects. */
const BUILTIN_RECEIVERS = new Set([
  // JavaScript
  "console", "Math", "JSON", "Object", "Array", "Promise", "Number", "String", "Boolean", "Date",
  "Symbol", "Reflect", "Intl", "Buffer", "process", "window", "document", "navigator", "globalThis",
  "localStorage", "sessionStorage", "crypto", "performance", "history", "location", "module",
  "exports", "require", "React", "fs", "path",
  // Python
  "os", "sys", "json", "re", "math", "time", "datetime", "logging", "logger", "log", "asyncio",
  "random", "typing", "pathlib", "subprocess", "shutil", "itertools", "functools", "collections",
  "np", "pd", "str", "int", "float", "dict", "list", "set", "tuple", "bytes",
]);

/**
 * Method names so common on library objects (lists, dicts, strings, promises,
 * loggers, DB sessions, HTTP clients) that a project-wide name match on an
 * untyped receiver is more likely wrong than right.
 */
const COMMON_METHOD_NAMES = new Set([
  "get", "set", "add", "put", "post", "patch", "delete", "remove", "update", "save", "load", "read",
  "write", "open", "close", "send", "run", "start", "stop", "init", "reset", "clear", "copy", "keys",
  "values", "items", "entries", "push", "pop", "shift", "map", "filter", "find", "sort", "join",
  "split", "format", "append", "extend", "insert", "index", "count", "strip", "trim", "replace",
  "encode", "decode", "json", "text", "then", "catch", "finally", "next", "emit", "on", "off", "once",
  "log", "info", "debug", "warn", "warning", "error", "exception", "critical", "execute", "call",
  "apply", "bind", "toString", "valueOf", "render", "parse", "stringify", "dump", "dumps", "loads",
  "lower", "upper", "startswith", "endswith", "startsWith", "endsWith", "includes", "indexOf",
  "slice", "splice", "concat", "forEach", "reduce", "some", "every", "test", "match", "exec",
  "commit", "rollback", "flush", "query", "fetch", "create", "connect", "disconnect", "exists",
  "has", "subscribe", "unsubscribe", "dispatch", "setState", "isoformat", "strftime", "mkdir",
  "resolve", "reject", "all", "any", "first", "last", "size", "length", "toLowerCase", "toUpperCase",
  "padStart", "padEnd", "flat", "flatMap", "fill", "reverse", "seek", "tell", "readline", "readlines",
  "setdefault", "popitem", "sleep", "wait", "cancel", "done", "result", "addEventListener",
  "removeEventListener", "preventDefault", "stopPropagation", "focus", "blur", "click", "submit",
  "status", "end", "use", "listen", "pipe", "destroy", "raise_for_status", "model_dump",
  "model_validate", "dict", "invoke", "ainvoke", "stream",
  // database drivers / ORMs / queues
  "find_one", "find_many", "insert_one", "insert_many", "update_one", "update_many", "delete_one",
  "delete_many", "replace_one", "aggregate", "count_documents", "bulk_write", "distinct",
  "fetchone", "fetchall", "fetchmany", "scalar", "scalars", "refresh", "merge", "upsert",
  "search", "publish", "consume", "declare_queue", "declare_exchange", "acknowledge", "ack", "nack",
  "create_collection", "delete_collection", "get_collection", "list_collections", "scroll",
  "upload", "download", "put_object", "get_object", "delete_object", "list_objects",
  "generate", "complete", "completions", "embed", "embeddings", "transcribe", "chat",
]);

export class CallResolver {
  private nodes = new Map<string, NodeInfo>();
  /** file -> name -> node id, for symbols defined directly at module level. */
  private topLevel = new Map<string, Map<string, string>>();
  /** file -> exported name -> node id. */
  private exports = new Map<string, Map<string, string>>();
  /** file -> local name -> binding (regular imports). */
  private bindings = new Map<string, Map<string, Binding>>();
  /** file -> exported name -> binding (`export { x } from "./y"`). */
  private reExports = new Map<string, Map<string, Binding>>();
  /** file -> modules pulled in wholesale (`from x import *`, `export * from "./x"`). */
  private starModules = new Map<string, string[]>();
  /** owner (class / namespace object) -> member name -> node id. */
  private members = new Map<string, Map<string, string>>();
  /** member -> owner. */
  private ownerOf = new Map<string, string>();
  /** class -> resolved parent classes. */
  private parents = new Map<string, string[]>();
  /** scope node -> variable name -> type name. */
  private varTypes = new Map<string, Map<string, string>>();
  /** "<family>\0<name>" -> methods / member functions with that name. */
  private methodsByName = new Map<string, string[]>();
  /** "<family>\0<name>" -> classes with that name. */
  private classesByName = new Map<string, string[]>();
  private fileNodeIds = new Map<string, string>();
  private fileFamily = new Map<string, LanguageFamily>();
  private modules: ModuleResolver;

  constructor(private storage: FlowStorage, rootPath: string) {
    this.modules = new ModuleResolver(storage.getIndexedFiles(), rootPath);
    this.load();
  }

  // ------------------------------------------------------------------ load

  private load(): void {
    const db = this.storage.db;

    const nodeRows = db
      .prepare("SELECT id, type, name, file_path, language FROM nodes")
      .all() as Array<{ id: string; type: string; name: string; file_path: string; language: string }>;
    for (const row of nodeRows) {
      const family = languageFamily(row.language);
      this.nodes.set(row.id, { id: row.id, type: row.type, name: row.name, file: row.file_path, family });
      if (row.type === "file") {
        this.fileNodeIds.set(row.file_path, row.id);
        this.fileFamily.set(row.file_path, family);
      } else if (row.type === "class") {
        push(this.classesByName, `${family}\0${row.name}`, row.id);
      }
    }

    const containsRows = db
      .prepare("SELECT source_id, target_id FROM edges WHERE type = 'contains'")
      .all() as Array<{ source_id: string; target_id: string }>;
    for (const row of containsRows) {
      const owner = this.nodes.get(row.source_id);
      const member = this.nodes.get(row.target_id);
      if (!owner || !member) continue;
      if (owner.type === "file") {
        const names = getOrCreate(this.topLevel, owner.file);
        // Functions and classes win over namespace objects of the same name.
        if (!names.has(member.name) || member.type !== "variable") names.set(member.name, member.id);
      } else {
        const names = getOrCreate(this.members, owner.id);
        if (!names.has(member.name)) names.set(member.name, member.id);
        this.ownerOf.set(member.id, owner.id);
        push(this.methodsByName, `${member.family}\0${member.name}`, member.id);
      }
    }

    // Functions attached from outside (`Foo.prototype.bar = ...`, `obj.fn = ...`)
    // are top-level nodes with a memberOf marker: usable as methods by name.
    const attached = db
      .prepare(
        "SELECT id FROM nodes WHERE type = 'function' AND json_extract(metadata, '$.memberOf') IS NOT NULL"
      )
      .all() as Array<{ id: string }>;
    for (const row of attached) {
      const node = this.nodes.get(row.id);
      if (!node || this.ownerOf.has(node.id)) continue;
      push(this.methodsByName, `${node.family}\0${node.name}`, node.id);
    }

    const exportRows = db
      .prepare("SELECT file_path, symbol_name, node_id FROM exports")
      .all() as Array<{ file_path: string; symbol_name: string; node_id: string }>;
    for (const row of exportRows) {
      getOrCreate(this.exports, row.file_path).set(row.symbol_name, row.node_id);
    }

    const importRows = db
      .prepare(
        "SELECT file_path, imported_symbol, from_module, original_name, is_reexport FROM imports ORDER BY line"
      )
      .all() as Array<{
        file_path: string;
        imported_symbol: string;
        from_module: string;
        original_name: string | null;
        is_reexport: number | null;
      }>;
    for (const row of importRows) {
      if (row.imported_symbol === "*") {
        push(this.starModules, row.file_path, row.from_module);
        continue;
      }
      const binding: Binding = {
        module: row.from_module,
        original: row.original_name || row.imported_symbol,
      };
      const table = row.is_reexport ? this.reExports : this.bindings;
      getOrCreate(table, row.file_path).set(row.imported_symbol, binding);
    }

    const typeRows = db
      .prepare("SELECT variable_name, type_name, scope_node_id FROM variable_types ORDER BY line")
      .all() as Array<{ variable_name: string; type_name: string; scope_node_id: string }>;
    for (const row of typeRows) {
      getOrCreate(this.varTypes, row.scope_node_id).set(row.variable_name, row.type_name);
    }
  }

  // --------------------------------------------------------------- resolve

  /**
   * Resolve every unresolved `extends`, `calls` and `depends` edge plus the
   * framework dependencies, writing the results back to storage.
   */
  resolveAll(): { resolved: number } {
    const db = this.storage.db;
    let resolved = 0;

    type EdgeRow = { id: string; source_id: string; target_id: string; metadata: string | null };
    const update = db.prepare("UPDATE edges SET target_id = ?, metadata = ? WHERE id = ?");

    const applyTo = (type: string): void => {
      const rows = db
        .prepare("SELECT id, source_id, target_id, metadata FROM edges WHERE type = ? AND target_id LIKE 'ref:%'")
        .all(type) as EdgeRow[];
      for (const row of rows) {
        const source = this.nodes.get(row.source_id);
        if (!source) continue;
        const name = row.target_id.slice("ref:".length);
        const resolution =
          type === "extends" ? this.resolveClassReference(source, name) : this.resolveCall(source, name);
        if (!resolution) continue;

        let metadata: Record<string, unknown> = {};
        if (row.metadata) {
          try {
            metadata = JSON.parse(row.metadata);
          } catch {
            metadata = {};
          }
        }
        if (metadata.unresolvedName === undefined) metadata.unresolvedName = name;
        metadata.resolvedBy = resolution.by;
        update.run(resolution.id, JSON.stringify(metadata), row.id);
        resolved++;
      }
    };

    this.storage.transaction(() => {
      // Inheritance first: method lookup depends on it.
      applyTo("extends");
      this.loadParents();
      applyTo("calls");
      applyTo("depends");

      // Framework dependencies (FastAPI Depends) also become call edges.
      for (const dep of this.storage.getAllUnresolvedDependencies()) {
        const source = this.nodes.get(dep.source_node_id as string);
        if (!source || !dep.unresolved_name) continue;
        const resolution = this.resolveCall(source, dep.unresolved_name as string);
        if (!resolution) continue;
        this.storage.updateFrameworkDependencyTarget(dep.id as string, resolution.id);
        this.storage.insertEdge({
          id: `${dep.id}:edge`,
          type: "calls",
          sourceId: source.id,
          targetId: resolution.id,
          metadata: {
            framework: dep.framework,
            pattern: dep.pattern,
            line: dep.line,
            resolvedBy: resolution.by,
          },
        });
        resolved++;
      }
    });

    return { resolved };
  }

  private loadParents(): void {
    this.parents.clear();
    const rows = this.storage.db
      .prepare("SELECT source_id, target_id FROM edges WHERE type = 'extends' AND target_id NOT LIKE 'ref:%'")
      .all() as Array<{ source_id: string; target_id: string }>;
    for (const row of rows) {
      if (row.source_id !== row.target_id) push(this.parents, row.source_id, row.target_id);
    }
  }

  /**
   * Resolve a callee name as written in `fromFile` (optionally inside the
   * function/method `scopeNodeId`). Used by impact analysis for names taken
   * from a diff. Requires inheritance to be resolved already.
   */
  resolveName(fromFile: string, name: string, scopeNodeId?: string): string | null {
    if (this.parents.size === 0) this.loadParents();
    const source =
      (scopeNodeId && this.nodes.get(scopeNodeId)) || this.nodes.get(this.fileNodeIds.get(fromFile) ?? "");
    if (!source) return null;
    return this.resolveCall(source, name)?.id ?? null;
  }

  private resolveClassReference(source: NodeInfo, name: string): Resolution | null {
    const target = this.resolvePath(source.file, name.split("."));
    if (target?.kind === "node" && this.nodes.get(target.id)?.type === "class") {
      return { id: target.id, by: "scope" };
    }
    return null;
  }

  private resolveCall(source: NodeInfo, name: string): Resolution | null {
    const parts = name.split(".");
    const enclosingClass = this.enclosingClass(source);

    // super(...) in a JS/TS constructor
    if (name === "super") {
      if (!enclosingClass) return null;
      for (const parent of this.parents.get(enclosingClass) ?? []) {
        const ctor = this.findMember(parent, "constructor");
        return { id: ctor ?? parent, by: "class" };
      }
      return null;
    }

    // Bare name: foo()
    if (parts.length === 1) {
      const target = this.resolveBare(source.file, name);
      if (!target) return null;
      if (target.kind === "node") return { id: target.id, by: "scope" };
      // Calling a module binding means calling its default export (CommonJS / ESM default).
      const defaultExport = this.exports.get(target.file)?.get("default");
      return defaultExport ? { id: defaultExport, by: "scope" } : null;
    }

    const method = parts[parts.length - 1];
    const receiver = parts.slice(0, -1);
    const root = receiver[0];

    // super().method() (Python) / super.method() (JS)
    if (root === "super()" || root === "super") {
      if (!enclosingClass || receiver.length !== 1) return null;
      for (const parent of this.parents.get(enclosingClass) ?? []) {
        const found = this.findMember(parent, method);
        if (found) return { id: found, by: "class" };
      }
      return null;
    }

    // self.method() / this.method() / cls.method()
    if (SELF_NAMES.has(root)) {
      if (!enclosingClass) return null;
      if (receiver.length === 1) {
        const found = this.findMember(enclosingClass, method);
        return found ? { id: found, by: "class" } : null;
      }
      if (receiver.length === 2) {
        // self.repo.save() with a known attribute type
        const typeName = this.attributeType(enclosingClass, receiver[1]);
        if (typeName) {
          const cls = this.resolveTypeName(source.file, typeName, source.family);
          if (cls) {
            const found = this.findMember(cls, method);
            return found ? { id: found, by: "type" } : null;
          }
        }
      }
      return this.heuristic(source, method, root);
    }

    if (root === "?") return this.heuristic(source, method, root);

    // variable.method() with a known variable type
    if (receiver.length === 1) {
      const typeName =
        this.varTypes.get(source.id)?.get(root) ??
        this.varTypes.get(this.fileNodeIds.get(source.file) ?? "")?.get(root);
      if (typeName && !typeName.startsWith("@call:")) {
        const cls = this.resolveTypeName(source.file, typeName, source.family);
        if (cls) {
          const found = this.findMember(cls, method);
          return found ? { id: found, by: "type" } : null;
        }
      }
    }

    // ClassName.method() / module.function() / namespace.member()
    const owner = this.resolvePath(source.file, receiver);
    if (owner) {
      if (owner.kind === "module") {
        const exported = this.lookupExport(owner.file, method);
        return exported?.kind === "node" ? { id: exported.id, by: "scope" } : null;
      }
      const ownerNode = this.nodes.get(owner.id);
      if (ownerNode && (ownerNode.type === "class" || ownerNode.type === "variable")) {
        const found = this.findMember(owner.id, method);
        return found ? { id: found, by: "class" } : null;
      }
      return null; // a property of a function: not something we track
    }

    // The receiver is imported from somewhere we do not index: an external library.
    if (this.isImportedName(source.file, receiver)) return null;

    return this.heuristic(source, method, root);
  }

  /**
   * Unknown receiver: accept a method defined exactly once in the same file,
   * or a distinctive method name defined exactly once in the whole project.
   */
  private heuristic(source: NodeInfo, method: string, root: string): Resolution | null {
    if (BUILTIN_RECEIVERS.has(root)) return null;
    if (method.length < 4 || COMMON_METHOD_NAMES.has(method)) return null;
    if (method.startsWith("__") && method.endsWith("__")) return null;

    // A method calling `<something>.<its own name>()` is almost always a wrapper
    // around a library object (def delete(self): self.client.delete()), not recursion.
    const candidates = (this.methodsByName.get(`${source.family}\0${method}`) ?? []).filter(
      (id) => id !== source.id
    );
    if (candidates.length === 0) return null;
    if ((this.methodsByName.get(`${source.family}\0${method}`) ?? []).includes(source.id)) return null;

    const sameFile = candidates.filter((id) => this.nodes.get(id)?.file === source.file);
    if (sameFile.length === 1) return { id: sameFile[0], by: "heuristic" };
    if (candidates.length === 1) return { id: candidates[0], by: "heuristic" };
    return null;
  }

  // ---------------------------------------------------------------- lookup

  private enclosingClass(source: NodeInfo): string | null {
    if (source.type === "class") return source.id;
    const owner = this.ownerOf.get(source.id);
    if (owner && this.nodes.get(owner)?.type === "class") return owner;
    return null;
  }

  /** Member `name` of a class (searching base classes) or of a namespace object. */
  private findMember(ownerId: string, name: string): string | null {
    const seen = new Set<string>();
    const queue = [ownerId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const found = this.members.get(current)?.get(name);
      if (found) return found;
      for (const parent of this.parents.get(current) ?? []) queue.push(parent);
    }
    return null;
  }

  /** Declared type of `self.<attribute>` / `this.<attribute>`, searching base classes. */
  private attributeType(classId: string, attribute: string): string | null {
    const seen = new Set<string>();
    const queue = [classId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const types = this.varTypes.get(current);
      const found = types?.get(`self.${attribute}`) ?? types?.get(`this.${attribute}`);
      if (found) return found;
      for (const parent of this.parents.get(current) ?? []) queue.push(parent);
    }
    return null;
  }

  private resolveTypeName(file: string, typeName: string, family: LanguageFamily): string | null {
    const target = this.resolvePath(file, typeName.split("."));
    if (target?.kind === "node" && this.nodes.get(target.id)?.type === "class") return target.id;
    // Type names used only in annotations are often not importable from here
    // (TYPE_CHECKING blocks, string annotations): accept a unique class name.
    const simple = typeName.split(".").pop()!;
    const candidates = this.classesByName.get(`${family}\0${simple}`);
    return candidates && candidates.length === 1 ? candidates[0] : null;
  }

  /** True when the first segment(s) of `path` are bound by an import in `file`. */
  private isImportedName(file: string, path: string[]): boolean {
    const bindings = this.bindings.get(file);
    if (!bindings) return false;
    for (let i = path.length; i >= 1; i--) {
      if (bindings.has(path.slice(0, i).join("."))) return true;
    }
    // `import a.b` also makes `a` an imported name.
    const prefix = `${path[0]}.`;
    for (const local of bindings.keys()) {
      if (local.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Resolve a dotted path (`Foo`, `pkg.mod.Foo`, `ns.Foo`) as seen from `file`. */
  private resolvePath(file: string, path: string[]): Target {
    if (path.length === 0 || path[0] === "?") return null;

    // Python `import a.b.c` binds the dotted name as a whole: prefer the longest match.
    let target: Target = null;
    let consumed = 0;
    const bindings = this.bindings.get(file);
    if (bindings) {
      for (let i = path.length; i > 1; i--) {
        const binding = bindings.get(path.slice(0, i).join("."));
        if (binding) {
          target = this.resolveBinding(file, binding);
          consumed = i;
          break;
        }
      }
    }
    if (consumed === 0) {
      target = this.resolveBare(file, path[0]);
      consumed = 1;
    }

    for (let i = consumed; i < path.length && target; i++) {
      const part = path[i];
      if (target.kind === "module") {
        target = this.lookupExport(target.file, part);
      } else {
        const member = this.findMember(target.id, part);
        target = member ? { kind: "node", id: member } : null;
      }
    }
    return target;
  }

  /** A bare name as visible in `file`: local definition, import, or star import. */
  private resolveBare(file: string, name: string): Target {
    const local = this.topLevel.get(file)?.get(name);
    if (local) return { kind: "node", id: local };

    const binding = this.bindings.get(file)?.get(name);
    if (binding) return this.resolveBinding(file, binding);

    for (const moduleName of this.starModules.get(file) ?? []) {
      const moduleFile = this.modules.resolve(file, moduleName, this.familyOf(file));
      if (!moduleFile) continue;
      const found = this.lookupExport(moduleFile, name);
      if (found) return found;
    }
    return null;
  }

  private resolveBinding(file: string, binding: Binding, depth = 0): Target {
    const family = this.familyOf(file);
    const moduleFile = this.modules.resolve(file, binding.module, family);

    if (binding.original === "*") {
      return moduleFile ? { kind: "module", file: moduleFile } : null;
    }

    if (moduleFile) {
      const found = this.lookupExport(moduleFile, binding.original, depth + 1);
      if (found) return found;
    }

    // Python: `from pkg import mod` / `from . import mod` imports a submodule.
    if (family === "python") {
      const submodule = binding.module.endsWith(".")
        ? `${binding.module}${binding.original}`
        : `${binding.module}.${binding.original}`;
      const submoduleFile = this.modules.resolve(file, submodule, family);
      if (submoduleFile) return { kind: "module", file: submoduleFile };
    }
    return null;
  }

  /** What `file` exports under `name`, following re-exports and barrel files. */
  private lookupExport(file: string, name: string, depth = 0, seen = new Set<string>()): Target {
    const key = `${file}\0${name}`;
    if (depth > 8 || seen.has(key)) return null;
    seen.add(key);

    const direct = this.exports.get(file)?.get(name);
    if (direct) return { kind: "node", id: direct };

    const family = this.familyOf(file);

    // export { x } from "./y"   /   import { x } from "./y"; export { x }   /   Python re-import
    const binding = this.reExports.get(file)?.get(name) ?? this.bindings.get(file)?.get(name);
    if (binding) {
      const moduleFile = this.modules.resolve(file, binding.module, family);
      if (binding.original === "*") {
        if (moduleFile) return { kind: "module", file: moduleFile };
      } else if (moduleFile) {
        const found = this.lookupExport(moduleFile, binding.original, depth + 1, seen);
        if (found) return found;
      }
      if (family === "python" && binding.original !== "*") {
        const submodule = binding.module.endsWith(".")
          ? `${binding.module}${binding.original}`
          : `${binding.module}.${binding.original}`;
        const submoduleFile = this.modules.resolve(file, submodule, family);
        if (submoduleFile) return { kind: "module", file: submoduleFile };
      }
    }

    // export * from "./y"   /   from .y import *
    for (const moduleName of this.starModules.get(file) ?? []) {
      const moduleFile = this.modules.resolve(file, moduleName, family);
      if (!moduleFile) continue;
      const found = this.lookupExport(moduleFile, name, depth + 1, seen);
      if (found) return found;
    }

    // Python package: `pkg.mod` where mod is a file next to pkg/__init__.py
    if (family === "python" && file.endsWith("/__init__.py")) {
      const dir = file.slice(0, -"/__init__.py".length);
      for (const candidate of [`${dir}/${name}.py`, `${dir}/${name}/__init__.py`]) {
        if (this.modules.has(candidate)) return { kind: "module", file: candidate };
      }
    }

    return null;
  }

  private familyOf(file: string): LanguageFamily {
    return this.fileFamily.get(file) ?? (file.endsWith(".py") ? "python" : "javascript");
  }
}

function getOrCreate<K, K2, V>(map: Map<K, Map<K2, V>>, key: K): Map<K2, V> {
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
