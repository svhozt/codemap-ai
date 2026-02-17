/**
 * Core types for CodeMap
 */

// ============ Graph Node Types ============

export type NodeType =
  | "file"
  | "function"
  | "class"
  | "method"
  | "variable"
  | "module"
  | "import";

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  metadata?: Record<string, unknown>;
}

// ============ Graph Edge Types ============

export type EdgeType =
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "contains"
  | "uses"
  | "exports"
  | "depends";

export interface GraphEdge {
  id: string;
  type: EdgeType;
  sourceId: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

// ============ Analysis Results ============

export interface FileAnalysis {
  filePath: string;
  language: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  variableTypes?: VariableTypeInfo[];
  databaseOperations?: DatabaseOperationInfo[];
}

export interface VariableTypeInfo {
  variableName: string;
  typeName: string;
  scopeId: string;
  line: number;
}

export interface DatabaseOperationInfo {
  nodeId: string;
  operation: string;
  collection: string;
  databaseType: string;
  line: number;
}

export interface ImportInfo {
  source: string;
  /** Local names bound by this import. */
  specifiers: string[];
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
  /**
   * Local name -> name in the source module, when they differ or when the
   * binding is special: "default" for a default import, "*" for a whole
   * module / namespace binding.
   */
  aliases?: Record<string, string>;
  /** True for `export ... from "x"` re-exports (bindings are not usable locally). */
  isReExport?: boolean;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  line: number;
  /** Name of the local symbol, when it is exported under a different name. */
  localName?: string;
}

// ============ Project Analysis ============

export interface ProjectAnalysis {
  rootPath: string;
  files: FileAnalysis[];
  totalNodes: number;
  totalEdges: number;
  languages: Record<string, number>;
  analyzedAt: string;
  parseErrors?: string[];
}

// ============ Query Results ============

export interface AffectedFile {
  filePath: string;
  reason: string;
  depth: number;
  connections: string[];
}

export interface CallChain {
  caller: GraphNode;
  callee: GraphNode;
  filePath: string;
  line: number;
}

// ============ Skill Generation ============

export interface GeneratedSkill {
  name: string;
  description: string;
  content: string;
  filePath: string;
}

export interface SkillConfig {
  projectName: string;
  outputDir: string;
  includeArchitecture: boolean;
  includePatterns: boolean;
  includeDependencies: boolean;
}

// ============ Configuration ============

export interface CodeMapConfig {
  rootPath: string;
  include: string[];
  exclude: string[];
  languages: string[];
  dbPath: string;
  skillsOutputDir: string;
}

/** File extensions the parsers understand. */
export const SUPPORTED_EXTENSIONS = [
  ".py",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

/** Files larger than this (in bytes) are skipped during indexing. */
export const MAX_FILE_SIZE = 200_000;

export const DEFAULT_CONFIG: Partial<CodeMapConfig> = {
  include: [
    "**/*.ts",
    "**/*.tsx",
    "**/*.mts",
    "**/*.cts",
    "**/*.js",
    "**/*.jsx",
    "**/*.mjs",
    "**/*.cjs",
    "**/*.py",
  ],
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/venv/**",
    "**/.venv/**",
    "**/site-packages/**",
    "**/__pycache__/**",
    "**/.next/**",
    "**/.codemap/**",
    "**/coverage/**",
    "**/*.min.js",
  ],
  languages: ["typescript", "javascript", "python"],
};

// ============ MCP Types ============

export interface MCPToolResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}
