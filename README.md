# CodeMap AI

**Call graph analyzer for understanding code impact and execution flows - built for Claude Code**

[![npm](https://img.shields.io/npm/v/codemap-ai.svg)](https://www.npmjs.com/package/codemap-ai)
[![CI](https://github.com/svhozt/codemap-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/svhozt/codemap-ai/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Stop guessing what breaks when you change code. CodeMap builds a call graph of
your Python, TypeScript and JavaScript code. It tells you, and Claude, which
functions, endpoints and services depend on what you are about to change.

- **Call graph**: functions, classes and methods, and who calls whom across files.
  Follows imports, aliases, re-exports, `tsconfig` paths, Python packages,
  `self`/`this`/`super` and typed variables.
- **Impact of your changes**: `codemap impact` compares your working tree with
  the last commit and reports:
  - changed functions and their callers
  - affected HTTP endpoints
  - removed calls (security checks flagged)
  - imports removed while still used
  - returned fields that callers still read
  - Docker Compose services whose entry point changed
- **Claude Code integration**: an MCP server with `codemap_impact`,
  `codemap_callers` and `codemap_trace_flow`, so Claude can look up the real
  callers instead of guessing.
- **Visualization**: `codemap visualize` opens an interactive graph of the
  impact in your browser.
- **Framework aware**: FastAPI routes and `Depends()`, MongoDB-style calls,
  React components used in JSX.
- **Fast and local**: incremental, hash-based re-indexing into a SQLite file in
  `.codemap/`. Nothing leaves your machine.

## Requirements

- Node.js **20 or newer**
- git (optional, needed for precise change detection in `codemap impact`)
- macOS or Linux (tested in CI). Windows is not tested yet; reports are welcome.
- CodeMap uses native modules (`tree-sitter`, `better-sqlite3`). Prebuilt
  binaries cover the common platforms; elsewhere npm compiles them, which needs
  Python and a C/C++ toolchain.

## Installation

```bash
# Run it without installing
npx codemap-ai init

# Or install it globally (provides the `codemap` and `codemap-ai` commands)
npm install -g codemap-ai
```

## Quick start

```bash
cd your-project

# 1. Index the project and register the MCP server for Claude Code
npx codemap-ai init

# 2. Before opening a PR: what do my uncommitted changes affect?
npx codemap-ai impact

# 3. See it as a graph in the browser
npx codemap-ai visualize
```

Then ask Claude things like:

- "What would break if I change `authenticate_user`?"
- "Who calls `get_user_permissions`?"
- "Show me the call path from `handle_checkout` to `save_order`."

Add `.codemap/` to your `.gitignore`: the index is local to each checkout.

## Commands

All commands take an optional project path (default: the current directory).

### `codemap init [path]`

Indexes the whole project and registers the MCP server in the project's
`.mcp.json` (Claude Code's project-scoped configuration). Other servers in
that file are kept. Claude Code asks you to approve the server the next time
it starts in this project.

| Option | |
|---|---|
| `--include <patterns...>` | Glob patterns to index (default: all supported source files) |
| `--exclude <patterns...>` | Glob patterns to skip (default: `node_modules`, `dist`, `build`, `.git`, `venv`, `.venv`, `__pycache__`, `.next`, `coverage`, `*.min.js`, ...) |
| `--skip-mcp` | Do not touch `.mcp.json` |
| `-f, --force` | Re-initialize an already initialized project |

### `codemap index [path]`

Builds or updates the index. Only files whose content changed are re-parsed;
deleted files are removed from the index. Include/exclude patterns given here
are remembered for later runs.

| Option | |
|---|---|
| `-f, --force` | Re-parse every file |
| `--include <patterns...>`, `--exclude <patterns...>` | As for `init` |

### `codemap reindex [path]`

Rebuilds the index from scratch (same as `index --force`). Accepts `--include`
and `--exclude`.

### `codemap impact [path]`

Analyzes your uncommitted changes (staged, unstaged and untracked files)
against the last commit.

```
  CodeMap Impact Analysis

✔ Detected 1 modified file

  Modified Files:
    • auth.py

  Changed Functions:
    • get_user (auth.py:5)

  Impact Analysis:
    get_user:
      2 direct callers
        • profile (api.py:8)
        • name (api.py:14)

  Affected HTTP Endpoints:
    • GET /name
    • GET /profile

  🚨 Removed Function Calls:
    CRITICAL: validate_token()
       Removed from: get_user() (was line 6)
       File: auth.py
       ⚠️ ORPHANED: No longer called anywhere!
       Impact: 3 dependent functions

  Risk Assessment:
    CRITICAL - 3 components affected
```

What it reports:

- **Changed functions**: functions whose code differs from the last commit
  (also added and deleted ones), with their direct callers.
- **Affected HTTP endpoints**: FastAPI routes handled by a changed function or
  one of its direct callers.
- **Removed function calls**: calls a function no longer makes. They are
  flagged when the callee is no longer called anywhere ("orphaned") or looks
  security-related (`validate_*`, `*auth*`, `check_permission`...).
- **Import problems**: an import that was removed while the name is still
  used. Unused imports are shown with `--verbose`.
- **Data-flow changes**: a field a function stopped returning (from a returned
  dict/object literal) that one of its callers still reads, e.g. `user["email"]`.
- **Docker services**: if a changed file is the entry point of a Docker Compose
  service, that service and every service that depends on it.
- **Risk level**: `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`.

| Option | |
|---|---|
| `-v, --verbose` | Show callers, impacted functions and unused imports in detail |
| `--json` | Print the full result as JSON (for scripts and CI) |
| `--fail-on <level>` | Exit with code 2 when the risk is at least `LOW`, `MEDIUM`, `HIGH` or `CRITICAL` |

Without git, or before the first commit, changes are detected by comparing
file hashes with the index, and only changed files are reported.

`impact` looks at uncommitted changes, so it fits best before you commit or
push. For example, in a git `pre-commit` hook:

```bash
npx codemap-ai impact --fail-on critical
```

### `codemap visualize [path]`

Runs the impact analysis and opens an interactive view in your browser:

- a sidebar of affected functions grouped by file
- a call graph with changed functions at the bottom and their callers above, colored by severity
- a detail popup with callers and callees; click one to jump to it

The server listens on `127.0.0.1` only. Stop it with Ctrl+C.

| Option | |
|---|---|
| `-p, --port <number>` | Port for the local server (default `37421`) |
| `--no-open` | Do not open a browser (useful over SSH) |
| `-v, --verbose` | Passed to the analysis |

### `codemap mcp-server`

Starts the MCP server on stdio. You do not normally run this yourself; Claude
Code starts it. The project root is `--path`, otherwise `$CLAUDE_PROJECT_DIR`,
otherwise the current directory.

## Claude Code integration

`codemap init` adds this to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "codemap": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "codemap-ai", "mcp-server", "--path", "${CLAUDE_PROJECT_DIR:-.}"]
    }
  }
}
```

You can commit `.mcp.json` to share the setup with your team (each person
still runs `codemap init` or `codemap index` to build their own index). To
register the server only for yourself instead, skip that step and run:

```bash
claude mcp add codemap -- npx -y codemap-ai mcp-server
```

### MCP tools

| Tool | Arguments | Returns |
|---|---|---|
| `codemap_impact` | `target` (function, method or class; `Class.method` works), optional `depth` (1-10, default 3) and `file` | Direct callers, everything that transitively calls it, affected files and HTTP endpoints, a risk level |
| `codemap_callers` | `function`, optional `file` | Every function that calls it, with file and line |
| `codemap_trace_flow` | `from`, `to` | The shortest call path between two functions |

If several functions share a name, the answer says so and lists them; pass
`file` (relative to the project root) to pick one. Re-run `codemap index`
after larger changes so the answers stay current. `codemap impact` updates
the index for the files you changed.

## Supported languages

| | Functions & methods | Classes & inheritance | Imports | Calls across files | Type-based method calls |
|---|---|---|---|---|---|
| Python (`.py`) | ✅ | ✅ | ✅ absolute, relative, packages, aliases, `*` | ✅ | ✅ annotations, `x = Foo()`, `self.attr` |
| TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`) | ✅ incl. arrow functions, class fields, object namespaces | ✅ | ✅ ESM, re-exports, barrels, `tsconfig` paths | ✅ | ✅ annotations, `new Foo()`, constructor properties |
| JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`) | ✅ incl. `exports.x = function` | ✅ | ✅ ESM and CommonJS `require` | ✅ | ✅ `new Foo()` |

Framework detection:

- **FastAPI**: route decorators (`@router.post("/orders")`, `@app.get(...)`) and
  `Depends(...)` (also inside `Annotated[...]`).
- **React**: components used in JSX count as calls.
- **MongoDB**: `collection.find_one(...)`-style operations are recorded.

### Limits

CodeMap does static analysis. It does not follow:

- dynamic calls (`getattr`, `obj[name]()`)
- callbacks passed as values
- dependency-injection containers
- calls into libraries

When it cannot tell which function a call refers to, it leaves the call
unresolved instead of guessing. The "call resolution rate" printed by
`index` therefore counts library calls too, and is expected to be well below
100%. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Programmatic use

```ts
import { FlowStorage, FlowBuilder, DEFAULT_CONFIG, analyzeImpact } from "codemap-ai";

const storage = new FlowStorage("/path/to/project/.codemap/graph.db");
await new FlowBuilder(storage, {
  rootPath: "/path/to/project",
  include: DEFAULT_CONFIG.include!,
  exclude: DEFAULT_CONFIG.exclude!,
  forceReindex: false,
}).build();

const [fn] = storage.findSymbols("authenticate_user");
console.log(storage.getResolvedCallers(fn.id));
storage.close();

const impact = await analyzeImpact({ path: "/path/to/project" });
console.log(impact.riskLevel, impact.changedFunctions);
```

## Configuration and data

- The index lives in `.codemap/graph.db` (SQLite) in the project root;
  `visualize` also writes `.codemap/impact.json`. Delete the folder at any
  time to start over.
- Files larger than 200 KB are skipped.
- Indexes written by older versions of CodeMap are rebuilt automatically by
  `index` and `impact`. Until then, the MCP tools ask you to run
  `npx codemap-ai reindex` instead of answering from the old index.

## Troubleshooting

**"Not initialized"**: run `npx codemap-ai init` (or `index`) in the project first.

**`impact` says "No changes detected"**: it compares against the last commit.
Check `git status`. Committed changes are not "uncommitted changes".

**Claude does not see the tools**:

1. Check that `.mcp.json` in the project contains the `codemap` server.
2. Restart Claude Code in that project and approve the server when asked.
3. Run `claude mcp list` to check its status.

**`npm install` fails while building `better-sqlite3` or `tree-sitter`**:
use a supported Node.js version (20 or newer, even-numbered releases are best
supported). If there is no prebuilt binary for your platform, install a C/C++
toolchain (Xcode Command Line Tools, `build-essential`, or Visual Studio Build
Tools).

**A call is missing from the graph**: it may be dynamic or go through a library
(see [Limits](#limits)). Please open an issue with a small example.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup, how to run the tests, and how to add a language. Please
report bugs at https://github.com/svhozt/codemap-ai/issues.

## License

Copyright 2026 Sahan Nishshanka.

Licensed under the [Apache License, Version 2.0](LICENSE); see also
[NOTICE](NOTICE). Releases up to and including 3.8.0 were published under the
MIT License.

## Links

- npm: https://www.npmjs.com/package/codemap-ai
- GitHub: https://github.com/svhozt/codemap-ai
- Changelog: [CHANGELOG.md](CHANGELOG.md)
