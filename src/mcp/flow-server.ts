/**
 * MCP Server for CodeMap Flow Edition
 * Provides 3 focused tools: impact analysis, flow tracing, and caller lookup
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { FlowStorage } from "../flow/storage.js";
import { resolve } from "path";
import { existsSync } from "fs";

// Get config from environment
const DB_PATH = process.env.CODEMAP_DB_PATH || ".codemap/graph.db";
const PROJECT_ROOT = process.env.CODEMAP_PROJECT_ROOT || process.cwd();

let storage: FlowStorage | null = null;

function getStorage(): FlowStorage {
  if (!storage) {
    const dbPath = resolve(PROJECT_ROOT, DB_PATH);
    if (!existsSync(dbPath)) {
      throw new Error(`CodeMap database not found at ${dbPath}. Run 'codemap index' first.`);
    }
    storage = new FlowStorage(dbPath);
  }
  return storage;
}

const server = new Server(
  {
    name: "codemap-flow",
    version: "3.6.0",
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
        description: "Analyze what would break if you change a function/class. Shows all callers and affected files with risk assessment.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Function or class name to analyze",
            },
            depth: {
              type: "number",
              description: "How many levels deep to analyze (default: 3)",
              default: 3,
            },
          },
          required: ["target"],
        },
      },
      {
        name: "codemap_trace_flow",
        description: "Trace the execution flow between two functions. Shows the complete call path from source to target.",
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
        description: "Find all functions that call a specific function. Shows where and how a function is used.",
        inputSchema: {
          type: "object",
          properties: {
            function: {
              type: "string",
              description: "Function name to find callers for",
            },
          },
          required: ["function"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const db = getStorage();

  try {
    switch (name) {
      case "codemap_impact": {
        const target = args?.target as string;
        const depth = (args?.depth as number) || 3;

        // Find the target node(s)
        const nodes = db.searchNodesByName(target);

        if (nodes.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No function or class found with name "${target}"`,
              },
            ],
          };
        }

        const targetNode = nodes[0];

        // Get impacted nodes
        const impacted = db.getImpactedNodes(targetNode.id, depth);

        // Get unique files
        const affectedFiles = new Set(impacted.map((n) => n.filePath));

        // Assess risk
        const directCallers = db.getResolvedCallers(targetNode.id);
        let risk = "LOW";
        if (directCallers.length > 10) risk = "HIGH";
        else if (directCallers.length > 5) risk = "MEDIUM";

        const response = `# Impact Analysis: ${targetNode.name}

**Location:** ${targetNode.filePath}:${targetNode.startLine}
**Type:** ${targetNode.type}
**Risk Level:** ${risk}

## Direct Callers (${directCallers.length})
${directCallers.slice(0, 10).map((c) => `- ${c.name} in ${c.filePath}:${c.startLine}`).join("\n")}
${directCallers.length > 10 ? `\n... and ${directCallers.length - 10} more` : ""}

## Total Impact
- **Affected functions:** ${impacted.length}
- **Affected files:** ${affectedFiles.size}

## Affected Files
${[...affectedFiles].slice(0, 20).map((f) => `- ${f}`).join("\n")}
${affectedFiles.size > 20 ? `\n... and ${affectedFiles.size - 20} more` : ""}

⚠️ **Recommendation:** ${risk === "HIGH" ? "High-risk change. Review all callers before modifying." : risk === "MEDIUM" ? "Moderate risk. Test affected files after changes." : "Low risk. Changes unlikely to cause wide impact."}
`;

        return {
          content: [{ type: "text", text: response }],
        };
      }

      case "codemap_trace_flow": {
        const from = args?.from as string;
        const to = args?.to as string;

        // Find source and target nodes
        const sourceNodes = db.searchNodesByName(from);
        const targetNodes = db.searchNodesByName(to);

        if (sourceNodes.length === 0) {
          return {
            content: [{ type: "text", text: `Source function "${from}" not found` }],
          };
        }

        if (targetNodes.length === 0) {
          return {
            content: [{ type: "text", text: `Target function "${to}" not found` }],
          };
        }

        const sourceNode = sourceNodes[0];
        const targetNode = targetNodes[0];

        // Trace path
        const path = db.traceCallPath(sourceNode.id, targetNode.id);

        if (!path) {
          return {
            content: [
              {
                type: "text",
                text: `No call path found from "${from}" to "${to}". They may not be connected.`,
              },
            ],
          };
        }

        const response = `# Execution Flow: ${from} → ${to}

${path.nodes
  .map(
    (n, i) =>
      `${i + 1}. **${n.name}**\n   File: ${n.file}:${n.line}${i < path.nodes.length - 1 ? "\n   ↓ calls" : ""}`
  )
  .join("\n\n")}

**Total steps:** ${path.nodes.length}
`;

        return {
          content: [{ type: "text", text: response }],
        };
      }

      case "codemap_callers": {
        const functionName = args?.function as string;

        // Find the function
        const nodes = db.searchNodesByName(functionName);

        if (nodes.length === 0) {
          return {
            content: [{ type: "text", text: `Function "${functionName}" not found` }],
          };
        }

        const targetNode = nodes[0];

        // Get all callers
        const callers = db.getResolvedCallers(targetNode.id);

        if (callers.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No callers found for "${functionName}". It may be unused or only called externally.`,
              },
            ],
          };
        }

        const response = `# Callers of ${functionName}

**Function:** ${targetNode.name} (${targetNode.type})
**Location:** ${targetNode.filePath}:${targetNode.startLine}
**Total callers:** ${callers.length}

## Who Calls This Function

${callers
  .map(
    (c) => `- **${c.name}** (${c.type})
  File: ${c.filePath}:${c.startLine}`
  )
  .join("\n\n")}
`;

        return {
          content: [{ type: "text", text: response }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
