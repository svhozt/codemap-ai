# Architecture

CodeMap builds a **call graph** of a Python / TypeScript / JavaScript project,
stores it in a local SQLite database, and answers two kinds of questions with it:

- *"What depends on this function?"* through the MCP tools Claude Code calls
  (`codemap_impact`, `codemap_callers`, `codemap_trace_flow`).
- *"What do my uncommitted changes affect?"* through `codemap impact` and the
  browser view `codemap visualize`.

Everything runs locally. Nothing is sent anywhere.

```
                    ┌──────────────┐
  source files ───▶ │   parsers    │  tree-sitter: nodes, edges (ref:<name>), imports, types
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │   builder    │  discover files, hash, parse changed ones, store
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐      ┌───────────────────┐
                    │   storage    │◀────▶│ resolver + module │  ref:<name> ─▶ node id
                    │  (SQLite)    │      │     resolver      │
                    └──────┬───────┘      └───────────────────┘
          ┌────────────────┼────────────────────────┐
          ▼                ▼                        ▼
   ┌─────────────┐  ┌─────────────┐          ┌─────────────┐
   │ MCP server  │  │   impact    │ ──JSON──▶│  visualize  │ ─▶ Express + React app
   │ (Claude)    │  │ (git diff)  │          │             │
   └─────────────┘  └─────────────┘          └─────────────┘
```

## Source layout

| Path | Role |
|---|---|
| `src/cli-flow.ts` | The `codemap` / `codemap-ai` command (commander). Bundled to `dist/cli.js`. |
| `src/index.ts` | Library entry point (`dist/index.js`): storage, builder, parsers, `analyzeImpact`. |
| `src/types.ts` | Shared types (`GraphNode`, `GraphEdge`, `FileAnalysis`...) and default include/exclude patterns. |
| `src/parsers/` | Language parsers on top of tree-sitter. |
| `src/flow/storage.ts` | SQLite schema and queries (`FlowStorage`). |
| `src/flow/builder.ts` | The indexer (`FlowBuilder`). |
| `src/flow/resolver.ts` | Turns unresolved references into node ids (`CallResolver`). |
| `src/flow/module-resolver.ts` | Maps import specifiers to indexed files (relative imports, tsconfig paths, Python packages). |
| `src/flow/phase3-analyzer.ts`, `storage-*-phase3.ts` | Data-flow facts: property reads and returned object shapes. |
| `src/analysis/` | Change analysis used by `impact`: function-level diff, removed calls, imports, Docker Compose, return shapes. |
| `src/commands/impact.ts` | `analyzeImpact()`, the core of `codemap impact`. |
| `src/commands/export-impact.ts`, `visualize.ts` | Turn an impact result into the web view's JSON and serve it. |
| `src/mcp/flow-server.ts` | The MCP server (stdio). Bundled to `dist/mcp-server.js`; started by `codemap mcp-server`. |
| `src/web/impact-server.ts` | Express server for the web view (binds to 127.0.0.1). |
| `src/web/app/` | React + React Flow app, built by Vite into `web-dist/`. |

## 1. Parsing

Every parser extends `BaseParser` (`src/parsers/base.ts`) and returns a
`FileAnalysis` for one file:

- **Nodes**: one `file` node, plus `function`, `class` and `method` nodes.
  The TS/JS parser also creates `variable` nodes for object-literal
  "namespaces" (`export const api = { load() {}, save: () => {} }`), whose
  function members become function nodes. Node ids are
  `<absolute path>:<name>:<start line>`.
- **Edges**:
  - `contains` (file → class → method)
  - `calls` (function → `ref:<callee as written>`, e.g. `ref:self.repo.save`)
  - `extends` (class → `ref:<base class>`)
  - `depends` (FastAPI `Depends(x)` → `ref:x`)

  Edge ids are `<file>#<n>`: stable between runs and unique across files and languages.
- **Imports** with their local names and aliases (`import { a as b }`,
  `from x import y as z`, `const { a } = require("x")`, re-exports, star imports).
- **Variable types** for later method resolution: parameter annotations,
  `x = Foo()`, `const x = new Foo()`, `self.repo = Repo()`, `constructor(private db: Db)`.
- Python extras: FastAPI routes (`@router.get("/path")`), `Depends()`
  (also inside `Annotated[...]`), MongoDB-style operations (`collection.find_one`).

Calls are attributed to the enclosing **module-level function or method**.
Nested functions and callbacks do not get their own node, so a call inside
`items.map(x => helper(x))` belongs to the function containing it.
That keeps chains connected for impact analysis.

Source is passed to tree-sitter in chunks (`parseSource`), because the
binding fails on strings larger than 32 KB. Files over 200 KB are skipped
during discovery.

## 2. Indexing (`FlowBuilder.build`)

1. **Discover** files with the include/exclude globs (defaults in
   `DEFAULT_CONFIG`). On a full run, indexed files that disappeared or are no
   longer matched are removed. An incremental run (`files: [...]`, used by
   `impact`) only looks at the listed files.
2. **Hash** each file (SHA-256). Unchanged files are skipped unless forced.
3. **Parse and store** each changed file in one transaction. The file's old
   data is removed first with `deleteFileData()`. That removes everything the
   file owns: nodes, edges, imports, exports, types, endpoints and data-flow
   rows. Edges *from other files* that pointed into it are turned back into
   `ref:<name>`, so they can re-attach to the re-parsed symbols.
4. **Data flow**: the parser's syntax tree is reused to record property reads
   (`user.email`, `data["id"]`) and returned object/dict literal shapes for
   every function.
5. **Resolve** all `ref:` edges (see below), then record the index format
   version and the include/exclude patterns in the `meta` table.

If the database was written by an older, incompatible version
(`INDEX_FORMAT_VERSION`), it is cleared and rebuilt automatically.

## 3. Resolution (`CallResolver`)

The resolver loads nodes, `contains` edges, imports, exports and variable
types into memory once, then resolves every unresolved `extends`, `calls` and
`depends` edge, and every FastAPI dependency. In order:

1. **Scope**: names defined in the same file, then imports. An imported
   name is followed to the file that defines it, through aliases, default
   exports, `export { x } from`, `export *`, `from x import *` and package
   `__init__.py` re-exports.
   - JS/TS modules are resolved relative to the importing file, with extension
     probing (`./x.js` → `x.ts`), `index.*` files, and `tsconfig.json` /
     `jsconfig.json` `paths` and `baseUrl`.
   - Python modules are resolved relative to the importing file (`from .x`) or
     against each parent directory of the importing file and `src/`.
   - Imports of packages that are not indexed stay unresolved: calls into
     libraries are not project edges.
2. **Class**: `self.m()` / `this.m()` / `super().m()` / `super.m()` /
   `ClassName.m()` are looked up through the inheritance chain, which is
   resolved first from `extends` edges.
3. **Type**: `x.m()` when the type of `x` is known in that scope (parameter
   annotation, assignment, constructor parameter property, `self.attr` /
   `this.attr` types declared anywhere in the class or its bases).
4. **Heuristic**: an unknown receiver (`obj.m()`) resolves only when `m` is
   a distinctive method name (not a common library name like `get`, `save`,
   `find_one`) defined exactly once in the same file, or exactly once in the
   project. A method never resolves to itself this way, which avoids
   false recursion in wrappers like `def delete(self): self.client.delete()`.

Names are matched exactly and Python never resolves to JS/TS (or the other way
round). Each resolved edge records `resolvedBy` in its metadata.

## 4. Storage

`.codemap/graph.db` in the project root (SQLite via better-sqlite3).
The main tables:

| Table | Contents |
|---|---|
| `nodes` | Files, functions, classes, methods, namespace objects; JSON metadata (decorators, `parentClass`, `httpEndpoint`...) |
| `edges` | `contains`, `calls`, `extends`, `depends`. Unresolved targets are `ref:<name>`. |
| `files` | Indexed files with content hash and language |
| `imports`, `exports` | Per-file bindings used by the resolver |
| `variable_types` | Known variable/attribute types per scope |
| `http_endpoints`, `framework_dependencies` | FastAPI routes and `Depends()` |
| `database_operations` | MongoDB-style calls (`users.find_one`) |
| `property_accesses`, `return_shapes` | Data-flow facts |
| `meta` | Index format version, include/exclude patterns |

`containers`, `http_calls`, `message_queue_operations` and `data_flows` exist
in the schema but are not populated yet.

## 5. Impact analysis (`analyzeImpact`)

With git and at least one commit:

1. `git diff HEAD --name-status` plus untracked files give the changed files
   (relative to the analyzed directory, which may be a subdirectory of the repository).
2. The changed source files are re-indexed incrementally.
3. Each changed file is parsed **twice**, as it is in `HEAD` and as it is now
   (`src/analysis/file-diff.ts`). Functions are matched by qualified name.
   - **Changed functions**: functions whose source text differs, plus added and deleted ones.
   - **Removed calls**: calls a function made before and no longer makes anywhere in its body.
   - **Return shapes**: properties a function no longer returns.
4. From the graph:
   - **Direct callers** of each changed function.
   - **Affected HTTP endpoints**, handled by a changed function or a direct caller.
   - For removed calls: whether the callee is now **orphaned**, and everything
     that transitively calls the function that lost the call (5 levels).
   - For lost return properties: the callers that **read** them.
5. **Imports** (`src/analysis/imports.ts`) are checked syntactically:
   - unused imports
   - imports that were removed while the name is still used
6. **Docker Compose**: if a changed file is a service's entry point (from
   `command`, `entrypoint` or the Dockerfile `CMD`/`ENTRYPOINT`), that service
   and every service that `depends_on` it are reported.
7. A **risk level** (`LOW` / `MEDIUM` / `HIGH` / `CRITICAL`) is derived from all of the above.
   For example, removing a call to a security-related function (`validate_*`,
   `*auth*`, `check_permission`...) makes the change `CRITICAL` when that
   function becomes orphaned or many functions depend on the caller.

Without git, or before the first commit, changed files are found by comparing
content hashes with the index, and only file-level information is reported.

## 6. MCP server

`codemap mcp-server` sets `CODEMAP_PROJECT_ROOT` and starts
`src/mcp/flow-server.ts` on stdio. The project root defaults to
`CLAUDE_PROJECT_DIR`, which Claude Code sets, and then to the working directory.
`codemap init` registers the server in the project's `.mcp.json`.

| Tool | Arguments | Answer |
|---|---|---|
| `codemap_impact` | `target`, `depth` (1-10, default 3), `file` | Direct callers, transitive callers up to `depth`, affected files and endpoints, risk |
| `codemap_callers` | `function`, `file` | Direct callers with locations |
| `codemap_trace_flow` | `from`, `to` | Shortest call path |

Symbols are looked up with `FlowStorage.findSymbols`, in this order:

1. qualified name (`Class.method`)
2. exact name
3. case-insensitive name
4. partial name

When several symbols share a name, the answer says so, lists the others, and
`file` selects one. A partial-only match with several candidates returns a
"did you mean" list instead of guessing. Paths in answers are relative to the
project root.

## 7. Visualization

`codemap visualize` runs `analyzeImpact`, converts the result with
`buildImpactData` into `.codemap/impact.json`, and starts an Express server on
`127.0.0.1:37421` (`--port` to change it). The server serves `/api/impact`
and the React app in `web-dist/`.

The app (`src/web/app`, React 19 + React Flow + dagre) shows:

- a sidebar of affected functions grouped by file
- a top-down call graph, with changed functions at the bottom and their callers above
- a detail popup with callers and callees, where clicking one navigates to it

## 8. Build and packaging

- `tsup` bundles `src/cli-flow.ts` → `dist/cli.js` (with a shebang),
  `src/index.ts` → `dist/index.js` (plus `.d.ts`), and `src/mcp/flow-server.ts`
  → `dist/mcp-server.js`. Native modules stay external.
- `vite build` builds the web app into `web-dist/`.
- The npm package contains `dist/`, `web-dist/`, `README.md`, `CHANGELOG.md`,
  `LICENSE` and `NOTICE` (the `files` field in `package.json`).

## Known limitations

- Static analysis only: dynamic dispatch, `getattr`, callbacks passed around,
  dependency injection containers and similar patterns are not followed.
  Calls into external libraries stay unresolved by design.
- Calls are attributed to module-level functions and methods. Inner functions
  have no node of their own.
- JavaScript `this` inside plain functions, prototype chains beyond
  `Foo.prototype.bar = function`, and TypeScript type-level information
  (interfaces, generics) are not used for resolution.
- Data-flow checks only compare object/dict *literals* returned by a function
  with direct property reads by its callers.
- Paths are stored as absolute paths, so an index is tied to the directory it was built in.
