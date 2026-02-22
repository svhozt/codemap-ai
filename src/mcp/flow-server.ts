/**
 * MCP Server for CodeMap Flow Edition
 * Provides 3 focused tools: impact analysis, flow tracing, and caller lookup
 *
 * Configuration (environment):
 *   CODEMAP_PROJECT_ROOT  project root (default: CLAUDE_PROJECT_DIR, then the working directory)
 *   CODEMAP_DB_PATH       database path (default: <root>/.codemap/graph.db)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "path";
import { existsSync } from "fs";
import { FlowStorage, type SymbolMatch } from "../flow/storage.js";
import { VERSION } from "../version.js";

// Get config from environment
const PROJECT_ROOT = resolve(
  process.env.CODEMAP_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd()
);
const DB_PATH = resolve(PROJECT_ROOT, process.env.CODEMAP_DB_PATH || ".codemap/graph.db");

let storage: FlowStorage | null = null;

function getStorage(): FlowStorage {
  if (!storage) {
    if (!existsSync(DB_PATH)) {
      throw new Error(
        `CodeMap database not found at ${DB_PATH}. Run 'npx codemap-ai init' in ${PROJECT_ROOT} first.`
      );
    }
    const opened = new FlowStorage(DB_PATH);
    if (opened.isIndexOutdated()) {
      opened.close();
      // Answering from an index built by an older version would give wrong callers.
      throw new Error(
        `The CodeMap index in ${PROJECT_ROOT} was built by an older version of codemap-ai. ` +
          "Run 'npx codemap-ai reindex' in the project, then ask again."
      );
    }
    storage = opened;
  }
  return storage;
}

/** Paths in answers are shown relative to the project root. */
function rel(filePath: string): string {
  const root = PROJECT_ROOT.replace(/\\/g, "/");
  return filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath;
}

function location(node: { filePath: string; startLine: number }): string {
  return `${rel(node.filePath)}:${node.startLine}`;
}

function displayName(node: SymbolMatch | { name: string; metadata?: Record<string, unknown> }): string {
  const owner = (node.metadata?.parentClass ?? node.metadata?.memberOf) as string | undefined;
  return owner && owner !== "default" ? `${owner}.${node.name}` : node.name;
}

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], ...(isError ? { isError: true } : {}) };
}

/**
 * Look up the symbol a tool argument refers to.
 * Returns either the chosen node or a message explaining what went wrong.
 */
function pickSymbol(
  db: FlowStorage,
  query: unknown,
  file: unknown,
  label: string
): { node: SymbolMatch; note: string } | { error: string } {
  if (typeof query !== "string" || !query.trim()) {
    return { error: `Missing argument: ${label} (a function, method or class name).` };
  }

  let matches = db.findSymbols(query);
  if (typeof file === "string" && file.trim()) {
    const wanted = file.trim().replace(/\\/g, "/");
    matches = matches.filter((m) => rel(m.filePath) === wanted || m.filePath.endsWith(`/${wanted}`));
  }

  if (matches.length === 0) {
    return { error: `No function, method or class named "${query}" found in the index.` };
  }

  const [first] = matches;
  if (first.match === "partial" && matches.length > 1) {
    const list = matches
      .slice(0, 15)
      .map((m) => `- ${displayName(m)} (${m.type}) - ${location(m)}`)
      .join("\n");
    return {
      error: `No exact match for "${query}". Did you mean one of these?\n${list}\n\nCall the tool again with the exact name.`,
    };
  }

  let note = "";
  if (first.match === "partial" || first.match === "case-insensitive") {
    note = `Note: no exact match for "${query}"; showing ${displayName(first)}.\n\n`;
  }
  if (matches.length > 1) {
    const others = matches
      .slice(1, 8)
      .map((m) => `- ${displayName(m)} (${m.type}) - ${location(m)}`)
      .join("\n");
    note +=
      `Note: ${matches.length} symbols are named "${query}"; showing the one in ${location(first)}. ` +
      `Pass "file" to choose another:\n${others}${matches.length > 8 ? `\n- ... and ${matches.length - 8} more` : ""}\n\n`;
  }
  return { node: first, note };
}

const fileProperty = {
  type: "string",
  description: "Optional file path (relative to the project root) to pick between symbols with the same name",
};

const server = new Server(
  {
    name: "codemap-flow",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ============ Tools ============

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "codemap_impact",
        description:
          "Analyze what would break if you change a function/class. Shows all callers and affected files with risk assessment.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Function, method or class name to analyze (e.g. authenticate_user or UserService.authenticate)",
            },
            depth: {
              type: "number",
              description: "How many levels of callers to follow (default: 3, max: 10)",
              default: 3,
            },
            file: fileProperty,
          },
          required: ["target"],
        },
      },
      {
        name: "codemap_trace_flow",
        description:
          "Trace the execution flow between two functions. Shows the complete call path from source to target.",
        inputSchema: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Starting function name",
            },
            to: {
              type: "string",
              description: "Target function name",
            },
          },
          required: ["from", "to"],
        },
      },
      {
        name: "codemap_callers",
        description:
          "Find all functions that call a specific function. Shows where and how a function is used.",
        inputSchema: {
          type: "object",
          properties: {
            function: {
              type: "string",
              description: "Function name to find callers for",
            },
            file: fileProperty,
          },
          required: ["function"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    const db = getStorage();

    switch (name) {
      case "codemap_impact": {
        const picked = pickSymbol(db, args.target, args.file, "target");
        if ("error" in picked) return text(picked.error);
        const { node: targetNode, note } = picked;

        const requestedDepth = Number(args.depth ?? 3);
        const depth = Number.isFinite(requestedDepth) ? Math.min(Math.max(Math.trunc(requestedDepth), 1), 10) : 3;

        // A class is used through its methods: include their callers too.
        const roots = [targetNode.id];
        if (targetNode.type === "class") {
          const members = db.db
            .prepare("SELECT target_id FROM edges WHERE source_id = ? AND type = 'contains'")
            .all(targetNode.id) as Array<{ target_id: string }>;
          roots.push(...members.map((m) => m.target_id));
        }

        const directCallers = new Map<string, ReturnType<FlowStorage["getResolvedCallers"]>[number]>();
        const impacted = new Map<string, ReturnType<FlowStorage["getImpactedNodes"]>[number]>();
        for (const root of roots) {
          for (const caller of db.getResolvedCallers(root)) {
            if (!roots.includes(caller.id)) directCallers.set(caller.id, caller);
          }
          for (const node of db.getImpactedNodes(root, depth)) {
            if (!roots.includes(node.id)) impacted.set(node.id, node);
          }
        }

        const affectedFiles = new Set([...impacted.values()].map((n) => rel(n.filePath)));
        const callers = [...directCallers.values()];

        let risk = "LOW";
        if (callers.length > 10 || impacted.size > 30) risk = "HIGH";
        else if (callers.length > 5 || impacted.size > 10) risk = "MEDIUM";

        const endpoints = new Set<string>();
        for (const id of [...roots, ...impacted.keys()]) {
          for (const endpoint of db.getHttpEndpointsByHandler(id)) {
            endpoints.add(`${endpoint.method} ${endpoint.path}`);
          }
        }

        const response = `${note}# Impact Analysis: ${displayName(targetNode)}

**Location:** ${location(targetNode)}
**Type:** ${targetNode.type}
**Risk Level:** ${risk}

## Direct Callers (${callers.length})
${callers.length === 0 ? "None found in the index." : callers.slice(0, 20).map((c) => `- ${displayName(c)} in ${location(c)}`).join("\n")}${callers.length > 20 ? `\n... and ${callers.length - 20} more` : ""}

## Total Impact (up to ${depth} level${depth === 1 ? "" : "s"} of callers)
- **Affected functions:** ${impacted.size}
- **Affected files:** ${affectedFiles.size}
${endpoints.size > 0 ? `- **HTTP endpoints:** ${[...endpoints].sort().join(", ")}\n` : ""}
## Affected Files
${affectedFiles.size === 0 ? "None." : [...affectedFiles].sort().slice(0, 20).map((f) => `- ${f}`).join("\n")}${affectedFiles.size > 20 ? `\n... and ${affectedFiles.size - 20} more` : ""}

**Recommendation:** ${risk === "HIGH" ? "High-risk change. Review all callers before modifying." : risk === "MEDIUM" ? "Moderate risk. Test affected files after changes." : "Low risk. Changes unlikely to cause wide impact."}

_Only calls CodeMap could resolve statically are counted; dynamic calls may add more callers._
`;
        return text(response);
      }

      case "codemap_trace_flow": {
        const source = pickSymbol(db, args.from, undefined, "from");
        if ("error" in source) return text(source.error);
        const target = pickSymbol(db, args.to, undefined, "to");
        if ("error" in target) return text(target.error);

        // Try every pair of candidates with the requested names; report the shortest path.
        const sources = db.findSymbols(String(args.from)).filter((m) => m.match === source.node.match);
        const targets = db.findSymbols(String(args.to)).filter((m) => m.match === target.node.match);
        let best: ReturnType<FlowStorage["traceCallPath"]> = null;
        for (const s of sources.slice(0, 10)) {
          for (const t of targets.slice(0, 10)) {
            const path = db.traceCallPath(s.id, t.id);
            if (path && (!best || path.nodes.length < best.nodes.length)) best = path;
          }
        }

        if (!best) {
          return text(
            `No call path found from "${args.from}" to "${args.to}". They may not be connected, or the connection goes through calls CodeMap could not resolve.`
          );
        }

        const response = `# Execution Flow: ${args.from} → ${args.to}

${best.nodes
  .map(
    (n, i) =>
      `${i + 1}. **${n.name}**\n   File: ${rel(n.file)}:${n.line}${i < best!.nodes.length - 1 ? "\n   ↓ calls" : ""}`
  )
  .join("\n\n")}

**Total steps:** ${best.nodes.length}
`;
        return text(response);
      }

      case "codemap_callers": {
        const picked = pickSymbol(db, args.function, args.file, "function");
        if ("error" in picked) return text(picked.error);
        const { node: targetNode, note } = picked;

        const callers = db.getResolvedCallers(targetNode.id).filter((c) => c.id !== targetNode.id);

        if (callers.length === 0) {
          return text(
            `${note}No callers found for "${displayName(targetNode)}" (${location(targetNode)}). It may be unused, called dynamically, or only called from outside the project.`
          );
        }

        const response = `${note}# Callers of ${displayName(targetNode)}

**Function:** ${displayName(targetNode)} (${targetNode.type})
**Location:** ${location(targetNode)}
**Total callers:** ${callers.length}

## Who Calls This Function

${callers
  .map(
    (c) => `- **${displayName(c)}** (${c.type})
  File: ${location(c)}`
  )
  .join("\n\n")}
`;
        return text(response);
      }

      default:
        return text(`Unknown tool: ${name}`, true);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return text(`Error: ${errorMessage}`, true);
  }
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
