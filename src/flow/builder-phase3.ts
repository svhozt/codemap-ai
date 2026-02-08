/**
 * Phase 3 Builder Integration
 * Integrates data flow analysis into the build process
 */

import Parser from "tree-sitter";
import { Database } from "better-sqlite3";
import { extractPropertyAccesses } from "../analysis/property-tracker.js";
import { analyzeReturnStatements } from "../analysis/return-analyzer.js";
import {
  storePropertyAccesses,
  storeReturnInfo,
} from "./storage-queries-phase3.js";

/**
 * Run Phase 3 analysis on a function node
 */
export function analyzeDataFlow(
  functionNode: Parser.SyntaxNode,
  functionId: string,
  functionName: string,
  filePath: string,
  db: Database
): void {
  // Extract property accesses
  const accesses = extractPropertyAccesses(
    functionNode,
    functionId,
    functionName,
    filePath
  );

  // Store property accesses
  if (accesses.length > 0) {
    storePropertyAccesses(db, accesses);
  }

  // Analyze return statements
  const returns = analyzeReturnStatements(
    functionNode,
    functionId,
    functionName,
    filePath
  );

  // Store return info
  if (returns.length > 0) {
    storeReturnInfo(db, returns);
  }
}

/**
 * Get Phase 3 statistics
 */
export function getPhase3Stats(db: Database): {
  propertyAccesses: number;
  returnShapes: number;
} {
  const accessCount = db
    .prepare(`SELECT COUNT(*) as count FROM property_accesses`)
    .get() as { count: number };

  const returnCount = db
    .prepare(`SELECT COUNT(*) as count FROM return_shapes`)
    .get() as { count: number };

  return {
    propertyAccesses: accessCount.count,
    returnShapes: returnCount.count,
  };
}
