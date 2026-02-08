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
  specifiers: string[];
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  line: number;
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

export const DEFAULT_CONFIG: Partial<CodeMapConfig> = {
  include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.py"],
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/venv/**",
    "**/__pycache__/**",
    "**/.next/**",
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
