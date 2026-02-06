/**
 * MCP Server for CodeMap - Integrates with Claude Code
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GraphStorage } from "../graph/storage.js";
import { SemanticStorage } from "../semantic/storage.js";
import { resolve } from "path";
import { existsSync } from "fs";

// Get config from environment
const DB_PATH = process.env.CODEMAP_DB_PATH || ".codemap/graph.db";
const SEMANTIC_DB_PATH = process.env.CODEMAP_SEMANTIC_DB_PATH || ".codemap/semantic.db";
const PROJECT_ROOT = process.env.CODEMAP_PROJECT_ROOT || process.cwd();

let storage: GraphStorage | null = null;
let semanticStorage: SemanticStorage | null = null;

function getStorage(): GraphStorage {
  if (!storage) {
    const dbPath = resolve(PROJECT_ROOT, DB_PATH);
    storage = new GraphStorage(dbPath);
  }
  return storage;
}

function getSemanticStorage(): SemanticStorage | null {
  if (!semanticStorage) {
    const dbPath = resolve(PROJECT_ROOT, SEMANTIC_DB_PATH);
    if (existsSync(dbPath)) {
      semanticStorage = new SemanticStorage(dbPath);
    }
  }
  return semanticStorage;
}

const server = new Server(
  {
    name: "codemap",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ============ Tools ============

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const semanticDb = getSemanticStorage();
  const hasSemanticIndex = semanticDb !== null;

  const tools: MCPTool[] = [
    {
      name: "codemap_search",
      description: hasSemanticIndex
        ? "Search code by name, description, or purpose. Returns AI-generated descriptions of what each function/class does."
        : "Search for functions, classes, or files in the codebase",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (function name, description, or purpose)",
          },
          type: {
            type: "string",
            enum: ["function", "class", "method", "file", "all"],
            description: "Type of entity to search for",
            default: "all",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "codemap_callers",
      description: "Find all functions/methods that call a specific function",
      inputSchema: {
        type: "object",
        properties: {
          functionName: {
            type: "string",
            description: "Name of the function to find callers for",
          },
        },
        required: ["functionName"],
      },
    },
    {
      name: "codemap_dependencies",
      description: "Get import/dependency information for a file",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Path to the file (relative or absolute)",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "codemap_impact",
      description: "Analyze what files would be affected by changes to a file or function",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "File path or function name to analyze",
          },
          depth: {
            type: "number",
            description: "How many levels of dependencies to follow (default: 2)",
            default: 2,
          },
        },
        required: ["target"],
      },
    },
    {
      name: "codemap_stats",
      description: "Get statistics about the codebase",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "codemap_file_contents",
      description: "Get all functions and classes defined in a file with descriptions",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Path to the file",
          },
        },
        required: ["filePath"],
      },
    },
  ];

  // Add semantic-only tools if semantic index exists
  if (hasSemanticIndex) {
    tools.push({
      name: "codemap_explain",
      description: "Get a detailed explanation of what a function, class, or file does",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the function, class, or file to explain",
          },
        },
        required: ["name"],
      },
    });

    tools.push({
      name: "codemap_flow",
      description: "Trace the call flow: what functions does X call, and what calls X",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the function or method to trace",
          },
        },
        required: ["name"],
      },
    });
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const db = getStorage();
  const semanticDb = getSemanticStorage();

  try {
    switch (name) {
      case "codemap_search": {
        const query = args?.query as string;
        const type = (args?.type as string) || "all";

        // Use semantic search if available
        if (semanticDb) {
          const entries = semanticDb.searchEntries(query);
          const filtered = type === "all" ? entries : entries.filter((e) => e.type === type);

          const results = filtered.slice(0, 20).map((e) => ({
            name: e.name,
            type: e.type,
            file: e.filePath,
            line: e.startLine,
            description: e.description,
            calls: e.calls.slice(0, 5),
          }));

          return {
            content: [
              {
                type: "text",
                text: results.length > 0
                  ? `Found ${results.length} matches:\n\n${results.map((r) =>
                      `• ${r.name} (${r.type}) - ${r.file}:${r.line}\n  ${r.description}${r.calls.length > 0 ? `\n  Calls: ${r.calls.join(", ")}` : ""}`
                    ).join("\n\n")}`
                  : `No matches found for "${query}"`,
              },
            ],
          };
        }

        // Fallback to graph-based search
        let nodes = db.searchNodes(query);
        if (type !== "all") {
          nodes = nodes.filter((n) => n.type === type);
        }

        const results = nodes.slice(0, 20).map((n) => ({
          name: n.name,
          type: n.type,
          file: n.filePath,
          line: n.startLine,
          language: n.language,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case "codemap_callers": {
        const functionName = args?.functionName as string;
        const callers = db.getCallers(functionName);

        const results = callers.map((n) => ({
          name: n.name,
          type: n.type,
          file: n.filePath,
          line: n.startLine,
        }));

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} callers of "${functionName}":\n${JSON.stringify(results, null, 2)}`,
            },
          ],
        };
      }

      case "codemap_dependencies": {
        const filePath = args?.filePath as string;
        const deps = db.getFileDependencies(filePath);

        return {
          content: [
            {
              type: "text",
              text: `Dependencies for ${filePath}:\n\nImports:\n${deps.imports.map((i) => `  - ${i}`).join("\n")}\n\nImported by:\n${deps.importedBy.map((i) => `  - ${i}`).join("\n")}`,
            },
          ],
        };
      }

      case "codemap_impact": {
        const target = args?.target as string;
        const depth = (args?.depth as number) || 2;

        // Find the target
        const nodes = db.searchNodes(target);
        if (nodes.length === 0) {
          return {
            content: [{ type: "text", text: `No matches found for "${target}"` }],
          };
        }

        const targetNode = nodes[0];
        const affected: Set<string> = new Set();

        // BFS to find affected files
        const queue: Array<{ id: string; depth: number }> = [{ id: targetNode.id, depth: 0 }];
        const visited = new Set<string>();

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (visited.has(current.id) || current.depth > depth) continue;
          visited.add(current.id);

          // Find edges pointing to this node
          const incomingEdges = db.getEdgesTo(current.id);
          for (const edge of incomingEdges) {
            const sourceNode = db.getNode(edge.sourceId);
            if (sourceNode) {
              affected.add(sourceNode.filePath);
              if (current.depth < depth) {
                queue.push({ id: sourceNode.id, depth: current.depth + 1 });
              }
            }
          }

          // Also check file-level dependencies
          if (targetNode.type === "file" || targetNode.type === "function") {
            const importers = db.getFilesThatImport(targetNode.filePath);
            for (const importer of importers) {
              affected.add(importer);
            }
          }
        }

        const affectedList = [...affected].filter((f) => f !== targetNode.filePath);

        return {
          content: [
            {
              type: "text",
              text: `Impact analysis for "${target}":\n\nTarget: ${targetNode.name} (${targetNode.type}) in ${targetNode.filePath}\n\nAffected files (${affectedList.length}):\n${affectedList.map((f) => `  - ${f}`).join("\n") || "  (none found)"}`,
            },
          ],
        };
      }

      case "codemap_stats": {
        const stats = db.getStats();
        const rootPath = db.getMeta("rootPath") || "unknown";
        const analyzedAt = db.getMeta("analyzedAt") || "unknown";

        return {
          content: [
            {
              type: "text",
              text: `CodeMap Statistics:

Project: ${rootPath}
Last analyzed: ${analyzedAt}

Files: ${stats.totalFiles}
Nodes: ${stats.totalNodes}
Edges: ${stats.totalEdges}

By type:
${Object.entries(stats.nodesByType).map(([t, c]) => `  - ${t}: ${c}`).join("\n")}

By language:
${Object.entries(stats.languages).map(([l, c]) => `  - ${l}: ${c}`).join("\n")}

Relationships:
${Object.entries(stats.edgesByType).map(([t, c]) => `  - ${t}: ${c}`).join("\n")}`,
            },
          ],
        };
      }

      case "codemap_file_contents": {
        const filePath = args?.filePath as string;

        // Use semantic data if available
        if (semanticDb) {
          const file = semanticDb.getFile(filePath);
          const entries = semanticDb.getEntriesByFile(filePath);

          if (file || entries.length > 0) {
            const fileDesc = file?.description || "No description";
            const contents = entries.map((e) => ({
              name: e.name,
              type: e.type,
              lines: `${e.startLine}-${e.endLine}`,
              description: e.description,
              calls: e.calls,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `File: ${filePath}\n${fileDesc}\n\nContents (${contents.length}):\n${contents.map((c) =>
                    `• ${c.name} (${c.type}) [${c.lines}]\n  ${c.description}${c.calls.length > 0 ? `\n  Calls: ${c.calls.join(", ")}` : ""}`
                  ).join("\n\n")}`,
                },
              ],
            };
          }
        }

        // Fallback to graph data
        const nodes = db.getNodesByFile(filePath);

        const contents = nodes
          .filter((n) => n.type !== "file")
          .map((n) => ({
            name: n.name,
            type: n.type,
            line: `${n.startLine}-${n.endLine}`,
            metadata: n.metadata,
          }));

        return {
          content: [
            {
              type: "text",
              text: `Contents of ${filePath}:\n${JSON.stringify(contents, null, 2)}`,
            },
          ],
        };
      }

      case "codemap_explain": {
        if (!semanticDb) {
          return {
            content: [{ type: "text", text: "Semantic index not available. Run 'codemap index' first." }],
            isError: true,
          };
        }

        const searchName = args?.name as string;
        const entries = semanticDb.searchEntries(searchName);

        if (entries.length === 0) {
          return {
            content: [{ type: "text", text: `No matches found for "${searchName}"` }],
          };
        }

        const entry = entries[0];
        const explanation = `
# ${entry.name} (${entry.type})

**File:** ${entry.filePath}:${entry.startLine}-${entry.endLine}

**Purpose:** ${entry.description}

**Calls:** ${entry.calls.length > 0 ? entry.calls.join(", ") : "None tracked"}

**Called by:** ${entry.calledBy.length > 0 ? entry.calledBy.join(", ") : "Unknown (run full index to populate)"}
`.trim();

        return {
          content: [{ type: "text", text: explanation }],
        };
      }

      case "codemap_flow": {
        if (!semanticDb) {
          return {
            content: [{ type: "text", text: "Semantic index not available. Run 'codemap index' first." }],
            isError: true,
          };
        }

        const searchName = args?.name as string;
        const entries = semanticDb.searchEntries(searchName);

        if (entries.length === 0) {
          return {
            content: [{ type: "text", text: `No matches found for "${searchName}"` }],
          };
        }

        const entry = entries[0];

        // Find what this function calls and describe them
        const callsInfo: string[] = [];
        for (const callName of entry.calls.slice(0, 10)) {
          const called = semanticDb.searchEntries(callName);
          if (called.length > 0) {
            callsInfo.push(`  → ${callName}: ${called[0].description}`);
          } else {
            callsInfo.push(`  → ${callName}: (external/built-in)`);
          }
        }

        const flow = `
# Call Flow: ${entry.name}

**Location:** ${entry.filePath}:${entry.startLine}

**What it does:** ${entry.description}

## Calls (outgoing):
${callsInfo.length > 0 ? callsInfo.join("\n") : "  No tracked calls"}

## Called by (incoming):
${entry.calledBy.length > 0 ? entry.calledBy.map((c) => `  ← ${c}`).join("\n") : "  Unknown (run full index to populate)"}
`.trim();

        return {
          content: [{ type: "text", text: flow }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// ============ Resources ============

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "codemap://stats",
        name: "Codebase Statistics",
        description: "Overview statistics of the analyzed codebase",
        mimeType: "application/json",
      },
      {
        uri: "codemap://graph",
        name: "Dependency Graph",
        description: "Full dependency graph for visualization",
        mimeType: "application/json",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const db = getStorage();

  if (uri === "codemap://stats") {
    const stats = db.getStats();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }

  if (uri === "codemap://graph") {
    const graph = db.exportForVisualization();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(graph, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ============ Main ============

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CodeMap MCP server started");
}

main().catch(console.error);
