/**
 * Base parser interface and utilities
 */

import type { FileAnalysis, GraphNode, GraphEdge, ImportInfo, ExportInfo } from "../types.js";

export interface Parser {
  language: string;
  extensions: string[];
  treeSitterParser?: any; // Optional: tree-sitter parser for Phase 3 AST access
  parse(filePath: string, content: string): FileAnalysis;
}

export abstract class BaseParser implements Parser {
  abstract language: string;
  abstract extensions: string[];

  protected nodeIdCounter = 0;
  protected edgeIdCounter = 0;

  abstract parse(filePath: string, content: string): FileAnalysis;

  protected generateNodeId(filePath: string, name: string, line: number): string {
    return `${filePath}:${name}:${line}`;
  }

  protected generateEdgeId(): string {
    return `edge_${++this.edgeIdCounter}`;
  }

  protected createNode(
    type: GraphNode["type"],
    name: string,
    filePath: string,
    startLine: number,
    endLine: number,
    metadata?: Record<string, unknown>
  ): GraphNode {
    return {
      id: this.generateNodeId(filePath, name, startLine),
      type,
      name,
      filePath,
      startLine,
      endLine,
      language: this.language,
      metadata,
    };
  }

  protected createEdge(
    type: GraphEdge["type"],
    sourceId: string,
    targetId: string,
    metadata?: Record<string, unknown>
  ): GraphEdge {
    return {
      id: this.generateEdgeId(),
      type,
      sourceId,
      targetId,
      metadata,
    };
  }

  protected createEmptyAnalysis(filePath: string): FileAnalysis {
    return {
      filePath,
      language: this.language,
      nodes: [],
      edges: [],
      imports: [],
      exports: [],
    };
  }
}

/**
 * Registry for all parsers
 */
export class ParserRegistry {
  private parsers: Map<string, Parser> = new Map();
  private extensionMap: Map<string, Parser> = new Map();

  register(parser: Parser): void {
    this.parsers.set(parser.language, parser);
    for (const ext of parser.extensions) {
      this.extensionMap.set(ext, parser);
    }
  }

  getByLanguage(language: string): Parser | undefined {
    return this.parsers.get(language);
  }

  getByExtension(extension: string): Parser | undefined {
    // Normalize extension (remove leading dot if present)
    const ext = extension.startsWith(".") ? extension : `.${extension}`;
    return this.extensionMap.get(ext);
  }

  getForFile(filePath: string): Parser | undefined {
    const ext = filePath.substring(filePath.lastIndexOf("."));
    return this.getByExtension(ext);
  }

  getSupportedExtensions(): string[] {
    return Array.from(this.extensionMap.keys());
  }

  getSupportedLanguages(): string[] {
    return Array.from(this.parsers.keys());
  }
}

export const parserRegistry = new ParserRegistry();
