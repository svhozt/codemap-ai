# Contributing to CodeMap AI

Thanks for your interest in improving CodeMap! Bug reports, fixes, new
language or framework support and documentation improvements are all welcome.

## Ground rules

- Be respectful. Assume good intent and keep discussions about the code.
- For anything larger than a small fix, open an issue first so we can agree
  on the approach before you spend time on it.
- Do not paste private source code into issues. A minimal example that shows
  the problem is better anyway.

## Development setup

Requirements: Node.js 20 or newer, npm, and git. CodeMap uses native modules
(`tree-sitter`, `better-sqlite3`); prebuilt binaries are downloaded for common
platforms, otherwise a C/C++ toolchain is needed to compile them.

```bash
git clone https://github.com/svhozt/codemap-ai.git
cd codemap-ai
npm ci
npm run build      # CLI/library (tsup) + web visualization (vite)
npm test           # builds, then runs the test suite (vitest)
```

Run your local build against any project:

```bash
node dist/cli.js init /path/to/project --skip-mcp
node dist/cli.js impact /path/to/project
```

Useful scripts:

| Script | What it does |
|---|---|
| `npm run build` | Build `dist/` (CLI, library, MCP server) and `web-dist/` (web app) |
| `npm run dev` | Rebuild `dist/` on change |
| `npm run dev:web` | Run the web app with hot reload (needs a running `codemap visualize` for its API) |
| `npm run typecheck` | Type-check the Node code and the web app |
| `npm run lint` | ESLint |
| `npm test` | Build, then run all tests |

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the parts fit
together. In short:

- `src/parsers/` - tree-sitter parsers that turn a source file into nodes and edges
- `src/flow/` - SQLite storage, the indexer (`builder.ts`) and call resolution (`resolver.ts`, `module-resolver.ts`)
- `src/analysis/` - change analysis used by `codemap impact` (function diff, removed calls, imports, Docker, data shapes)
- `src/commands/` - `impact` and `visualize`
- `src/mcp/` - the MCP server used by Claude Code
- `src/web/` - the visualization server and React app
- `test/` - vitest tests; `test/helpers/project.ts` builds throwaway projects on disk

## Making a change

1. Create a branch from `main`.
2. Add or update tests. Parser and resolver changes should come with a small
   project in a test that shows the new behaviour (see `test/call-graph.test.ts`).
3. Run `npm run build && npm run typecheck && npm run lint && npm test`.
4. Add a line to the "Unreleased" section of `CHANGELOG.md` for anything users
   will notice.
5. Open a pull request and fill in the template.

### Guidelines

- **Prefer no edge over a wrong edge.** Impact analysis is only useful if its
  answers can be trusted. When a call cannot be resolved with reasonable
  confidence, leave it unresolved.
- **Keep backwards compatibility** for the CLI commands and options, the MCP
  tool names and arguments, and the exports of the library entry point
  (`src/index.ts`). If the meaning of stored data changes, bump
  `INDEX_FORMAT_VERSION` in `src/flow/storage.ts` so old indexes are rebuilt.
- **Never write outside the analyzed project** (except the user's explicit
  output, such as the terminal). Tests run the CLI with a temporary `HOME`.

## Adding a language

1. Add the tree-sitter grammar as a dependency and mark it `external` in `tsup.config.ts`.
2. Implement a parser in `src/parsers/` extending `BaseParser` (see `python.ts`):
   emit a `file` node, `function` / `class` / `method` nodes, `contains` edges,
   `calls` edges to `ref:<name as written>`, and the file's imports.
3. Register it in `src/parsers/index.ts`, add the extension to
   `SUPPORTED_EXTENSIONS` and `DEFAULT_CONFIG.include` in `src/types.ts`.
4. Teach `src/flow/module-resolver.ts` how the language finds modules.
5. Add parser and call-graph tests.

## Reporting security issues

Please do not open a public issue for security problems. Use GitHub's
"Report a vulnerability" (private security advisory) on the repository instead.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
