/**
 * Base parser interface and utilities
 */

import type TreeSitter from "tree-sitter";
import type { FileAnalysis, GraphNode, GraphEdge } from "../types.js";

export interface LanguageParser {
  language: string;
  extensions: string[];
  /** The underlying tree-sitter parser, for callers that need raw AST access. */
  treeSitterParser?: TreeSitter;
  parse(filePath: string, content: string): FileAnalysis;
  /**
   * Parse `content` and return the raw syntax tree, with the grammar that
   * matches `filePath` selected. Returns null when the source cannot be parsed.
   */
  parseTree?(filePath: string, content: string): TreeSitter.Tree | null;
  /** The syntax tree of the most recent `parse(filePath, ...)` call, if it was for `filePath`. */
  getLastTree?(filePath: string): TreeSitter.Tree | null;
}

/** Historical name of {@link LanguageParser}. */
export type Parser = LanguageParser;

/** Chunk size used when feeding source text to tree-sitter. */
const PARSE_CHUNK_SIZE = 16 * 1024;

/**
 * Parse a string with tree-sitter using the callback API.
 *
 * `parser.parse(string)` fails with "Invalid argument" for inputs larger than
 * the binding's internal buffer (32 KB), which used to make large source files
 * silently come out empty. Feeding the text in chunks has no such limit.
 */
export function parseSource(parser: TreeSitter, source: string): TreeSitter.Tree {
  return parser.parse((index: number) => {
    if (index >= source.length) return null;
    return source.slice(index, index + PARSE_CHUNK_SIZE);
  });
}

/** Last path segment, for both POSIX and Windows separators. */
export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export abstract class BaseParser implements LanguageParser {
  abstract language: string;
  abstract extensions: string[];

  protected nodeIdCounter = 0;
  protected edgeIdCounter = 0;

  /** File currently being parsed; edge ids are scoped to it. */
  private currentFile = "";
  private lastTree: TreeSitter.Tree | null = null;
  private lastTreeFile = "";

  abstract parse(filePath: string, content: string): FileAnalysis;

  /**
   * Start a new file. Edge ids are `<file>#<n>`, numbered from 1 per file, so
   * they are stable across runs and can never collide between files, parsers
   * or processes.
   */
  protected beginFile(filePath: string): void {
    this.currentFile = filePath;
    this.edgeIdCounter = 0;
    this.lastTree = null;
    this.lastTreeFile = "";
  }

  protected rememberTree(filePath: string, tree: TreeSitter.Tree): void {
    this.lastTree = tree;
    this.lastTreeFile = filePath;
  }

  getLastTree(filePath: string): TreeSitter.Tree | null {
    return this.lastTreeFile === filePath ? this.lastTree : null;
  }

  protected generateNodeId(filePath: string, name: string, line: number): string {
    return `${filePath}:${name}:${line}`;
  }

  protected generateEdgeId(): string {
    return `${this.currentFile}#${++this.edgeIdCounter}`;
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

  /** A file node covering the whole source. */
  protected createFileNode(filePath: string, source: string): GraphNode {
    return this.createNode("file", baseName(filePath), filePath, 1, source.split("\n").length);
  }
}

/**
 * Registry for all parsers
 */
export class ParserRegistry {
  private parsers: Map<string, LanguageParser> = new Map();
  private extensionMap: Map<string, LanguageParser> = new Map();

  register(parser: LanguageParser): void {
    this.parsers.set(parser.language, parser);
    for (const ext of parser.extensions) {
      this.extensionMap.set(ext, parser);
    }
  }

  getByLanguage(language: string): LanguageParser | undefined {
    return this.parsers.get(language);
  }

  getByExtension(extension: string): LanguageParser | undefined {
    // Normalize extension (add leading dot if missing)
    const ext = extension.startsWith(".") ? extension : `.${extension}`;
    return this.extensionMap.get(ext.toLowerCase());
  }

  getForFile(filePath: string): LanguageParser | undefined {
    const dot = filePath.lastIndexOf(".");
    if (dot < 0) return undefined;
    return this.getByExtension(filePath.substring(dot));
  }

  getSupportedExtensions(): string[] {
    return Array.from(this.extensionMap.keys());
  }

  getSupportedLanguages(): string[] {
    return Array.from(this.parsers.keys());
  }
}

export const parserRegistry = new ParserRegistry();
