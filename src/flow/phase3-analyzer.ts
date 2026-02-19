/**
 * Phase 3 File Analyzer
 * Re-parses files to extract Phase 3 data (property accesses, return shapes)
 */

import type Parser from "tree-sitter";
import { readFileSync } from "fs";
import type { Database } from "better-sqlite3";
import { extractPropertyAccesses } from "../analysis/property-tracker.js";
import { analyzeReturnStatements } from "../analysis/return-analyzer.js";
import {
  storePropertyAccesses,
  storeReturnInfo,
} from "./storage-queries-phase3.js";
import { parserRegistry } from "../parsers/index.js";

/**
 * Analyze a file for Phase 3 data.
 *
 * `tree` is the syntax tree the parser already produced for this file; when it
 * is not supplied the file is read and parsed again.
 */
export function analyzeFileForPhase3(
  filePath: string,
  functionNodes: Array<{ id: string; name: string; startLine: number; endLine: number }>,
  db: Database,
  tree?: Parser.Tree | null
): void {
  try {
    let syntaxTree = tree ?? null;
    if (!syntaxTree) {
      const parserInstance = parserRegistry.getForFile(filePath);
      if (!parserInstance?.parseTree) return;
      syntaxTree = parserInstance.parseTree(filePath, readFileSync(filePath, "utf-8"));
    }
    if (!syntaxTree) return;
    const rootNode = syntaxTree.rootNode;

    // Analyze each function
    for (const func of functionNodes) {
      // Find the function AST node
      const funcNode = findNodeAtLine(rootNode, func.startLine, func.endLine);
      if (!funcNode) continue;

      // Extract property accesses
      const accesses = extractPropertyAccesses(funcNode, func.id, func.name, filePath);
      if (accesses.length > 0) {
        // Add file path to each access
        const accessesWithFile = accesses.map((a) => ({ ...a, filePath }));
        storePropertyAccesses(db, accessesWithFile);
      }

      // Analyze return statements
      const returns = analyzeReturnStatements(funcNode, func.id, func.name, filePath);
      if (returns.length > 0) {
        storeReturnInfo(db, returns);
      }
    }
  } catch {
    // Data-flow analysis is best effort: a failure here must never fail indexing.
  }
}

/**
 * Find AST node at specific line range
 */
export function findNodeAtLine(
  node: Parser.SyntaxNode,
  startLine: number,
  endLine: number
): Parser.SyntaxNode | null {
  // Check if this node matches the line range
  const nodeStart = node.startPosition.row + 1;
  const nodeEnd = node.endPosition.row + 1;

  if (nodeStart === startLine && nodeEnd === endLine) {
    return node;
  }

  // Search children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const result = findNodeAtLine(child, startLine, endLine);
      if (result) return result;
    }
  }

  // If exact match not found but this node contains the range, return it
  if (nodeStart <= startLine && nodeEnd >= endLine) {
    // Check if it's a function/method node
    if (
      node.type === "function_definition" ||
      node.type === "function_declaration" ||
      node.type === "method_definition" ||
      node.type === "arrow_function" ||
      node.type === "function_expression"
    ) {
      return node;
    }
  }

  return null;
}
