import { defineConfig } from "tsup";

/** Native modules (and their grammars) are loaded from node_modules at runtime. */
const external = [
  "tree-sitter",
  "tree-sitter-python",
  "tree-sitter-javascript",
  "tree-sitter-typescript",
  "better-sqlite3",
];

export default defineConfig([
  // CLI entry - with shebang
  {
    entry: { cli: "src/cli-flow.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node20",
    shims: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
    external,
  },
  // Library and MCP server - no shebang
  {
    entry: {
      index: "src/index.ts",
      "mcp-server": "src/mcp/flow-server.ts",
    },
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "node20",
    shims: true,
    external,
  },
]);
