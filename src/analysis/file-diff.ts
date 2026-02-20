/**
 * Function-level comparison of two versions of a source file.
 *
 * Both versions are parsed with the same parsers the indexer uses, so "which
 * functions changed" and "which calls were removed" are answered from syntax
 * trees rather than from diff hunks and regular expressions:
 *
 *   - a function is "modified" when its source text differs
 *   - a call is "removed" when the old version of a function made it and the
 *     new version of the same function does not make it at all
 */

import type Parser from "tree-sitter";
import { parserRegistry } from "../parsers/index.js";
import { findNodeAtLine } from "../flow/phase3-analyzer.js";
import {
  analyzeReturnStatements,
  mergeObjectShapes,
  type ObjectShape,
} from "./return-analyzer.js";
import type { ImportInfo } from "../types.js";

export interface FunctionSnapshot {
  /** Unique within the file: `name`, `Class.name`, with `#n` appended for repeats. */
  key: string;
  /** Display name (`name` or `Class.name`). */
  displayName: string;
  name: string;
  type: "function" | "method";
  startLine: number;
  endLine: number;
  /** Source text of the function. */
  text: string;
  /** Calls made by the function, as written. */
  calls: Array<{ name: string; line: number }>;
  /** Union of the object/dict literals the function returns, if it returns any. */
  returnShape: ObjectShape | null;
  /** Node id the indexer gives this function for this version of the file. */
  nodeId: string;
}

export interface FileSnapshot {
  functions: Map<string, FunctionSnapshot>;
  imports: ImportInfo[];
  lines: string[];
  tree: Parser.Tree | null;
}

export interface FunctionChange {
  changeType: "added" | "modified" | "deleted";
  before?: FunctionSnapshot;
  after?: FunctionSnapshot;
}

export interface RemovedCallSite {
  /** Callee as written in the old source (`validate_token`, `self.repo.save`). */
  expression: string;
  /** Line in the old version of the file. */
  line: number;
  /** The old source line, trimmed. */
  source: string;
  /** Function the call was removed from (new version). */
  from: FunctionSnapshot;
}

/** Parse one version of a file. Returns null for unsupported file types. */
export function snapshotFile(filePath: string, content: string): FileSnapshot | null {
  const parser = parserRegistry.getForFile(filePath);
  if (!parser) return null;

  const analysis = parser.parse(filePath, content);
  const tree = parser.getLastTree?.(filePath) ?? null;
  const lines = content.split("\n");

  const callsBySource = new Map<string, Array<{ name: string; line: number }>>();
  for (const edge of analysis.edges) {
    if (edge.type !== "calls") continue;
    const name = edge.metadata?.unresolvedName;
    if (typeof name !== "string") continue;
    const list = callsBySource.get(edge.sourceId) ?? [];
    list.push({ name, line: Number(edge.metadata?.line ?? 0) });
    callsBySource.set(edge.sourceId, list);
  }

  const functions = new Map<string, FunctionSnapshot>();
  for (const node of analysis.nodes) {
    if (node.type !== "function" && node.type !== "method") continue;

    const owner = (node.metadata?.parentClass ?? node.metadata?.memberOf) as string | undefined;
    const displayName = owner && owner !== "default" ? `${owner}.${node.name}` : node.name;
    let key = displayName;
    for (let n = 2; functions.has(key); n++) key = `${displayName}#${n}`;

    let returnShape: ObjectShape | null = null;
    if (tree) {
      const astNode = findNodeAtLine(tree.rootNode, node.startLine, node.endLine);
      if (astNode) {
        const shapes = analyzeReturnStatements(astNode, node.id, node.name, filePath)
          .map((r) => r.objectShape)
          .filter((s): s is ObjectShape => !!s && !s.isArray);
        returnShape = mergeObjectShapes(shapes);
      }
    }

    functions.set(key, {
      key,
      displayName,
      name: node.name,
      type: node.type,
      startLine: node.startLine,
      endLine: node.endLine,
      text: lines.slice(node.startLine - 1, node.endLine).join("\n"),
      calls: callsBySource.get(node.id) ?? [],
      returnShape,
      nodeId: node.id,
    });
  }

  return { functions, imports: analysis.imports, lines, tree };
}

/** Functions added, modified or deleted between two versions of a file. */
export function diffFunctions(
  before: FileSnapshot | null,
  after: FileSnapshot | null
): FunctionChange[] {
  const changes: FunctionChange[] = [];
  const oldFunctions = before?.functions ?? new Map<string, FunctionSnapshot>();
  const newFunctions = after?.functions ?? new Map<string, FunctionSnapshot>();

  for (const [key, fn] of newFunctions) {
    const previous = oldFunctions.get(key);
    if (!previous) {
      // A brand new file is not a list of "changed functions"; a new function in an old file is.
      changes.push({ changeType: "added", after: fn });
    } else if (normalizeText(previous.text) !== normalizeText(fn.text)) {
      changes.push({ changeType: "modified", before: previous, after: fn });
    }
  }
  for (const [key, fn] of oldFunctions) {
    if (!newFunctions.has(key)) changes.push({ changeType: "deleted", before: fn });
  }
  return changes;
}

/** Calls that modified functions used to make and no longer make. */
export function findRemovedCalls(changes: FunctionChange[], before: FileSnapshot): RemovedCallSite[] {
  const removed: RemovedCallSite[] = [];
  for (const change of changes) {
    if (change.changeType !== "modified" || !change.before || !change.after) continue;
    // A method call counts as still present when the same method is still called
    // on any receiver: renaming a variable (`svc.run()` -> `service.run()`) is not
    // a removed call. This can miss a removal, but never invents one.
    const stillCalled = new Set<string>();
    for (const call of change.after.calls) {
      stillCalled.add(call.name);
      stillCalled.add(`.${lastSegment(call.name)}`);
    }
    const reported = new Set<string>();
    for (const call of change.before.calls) {
      if (reported.has(call.name) || stillCalled.has(call.name)) continue;
      if (call.name.includes(".") && stillCalled.has(`.${lastSegment(call.name)}`)) continue;
      reported.add(call.name);
      removed.push({
        expression: call.name,
        line: call.line,
        source: (before.lines[call.line - 1] ?? "").trim(),
        from: change.after,
      });
    }
  }
  return removed;
}

function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** Ignore trailing whitespace and line-ending differences. */
function normalizeText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}
