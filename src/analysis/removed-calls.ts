/**
 * Removed Call Extractor
 * Extracts function calls from removed lines of code
 */

import type { RemovedLine } from './line-diff.js';

export interface RemovedCall {
  callee: string;        // Function that was called
  removedFrom: string;   // Function it was removed from
  file: string;
  lineNumber: number;
  rawContent: string;    // Original line content
}

/**
 * Extract function calls from removed lines
 */
export function extractRemovedCalls(removedLines: RemovedLine[]): RemovedCall[] {
  const removedCalls: RemovedCall[] = [];

  for (const line of removedLines) {
    // Parse the line content to detect function calls
    const calls = parseLineForCalls(line.content, line.file);

    for (const call of calls) {
      removedCalls.push({
        callee: call.name,
        removedFrom: line.inFunction || 'unknown',
        file: line.file,
        lineNumber: line.lineNumber,
        rawContent: line.content.trim(),
      });
    }
  }

  return removedCalls;
}

/**
 * Parse a single line to extract function calls
 */
function parseLineForCalls(
  lineContent: string,
  filePath: string
): Array<{ name: string }> {
  const calls: Array<{ name: string }> = [];

  // Skip comments and strings
  if (isCommentOrString(lineContent)) {
    return calls;
  }

  // Remove inline comments
  lineContent = lineContent.replace(/\/\/.*$/g, '');  // JS comments
  lineContent = lineContent.replace(/#.*$/g, '');     // Python comments
  lineContent = lineContent.replace(/\/\*.*?\*\//g, ''); // Block comments

  // Remove strings to avoid false positives
  lineContent = lineContent.replace(/["'`].*?["'`]/g, '');

  // Detect language
  const isJS = /\.(js|ts|jsx|tsx)$/.test(filePath);
  const isPython = /\.py$/.test(filePath);

  if (isJS) {
    calls.push(...extractJavaScriptCalls(lineContent));
  }

  if (isPython) {
    calls.push(...extractPythonCalls(lineContent));
  }

  return calls;
}

/**
 * Check if line is a comment or string literal
 */
function isCommentOrString(line: string): boolean {
  const trimmed = line.trim();

  // Comments
  if (trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('#')) {
    return true;
  }

  // String literals (rough check)
  const stringPrefixes = ['"', "'", '`'];
  if (stringPrefixes.some(prefix => trimmed.startsWith(prefix))) {
    return true;
  }

  return false;
}

/**
 * Extract function calls from JavaScript/TypeScript code
 */
function extractJavaScriptCalls(lineContent: string): Array<{ name: string }> {
  const calls: Array<{ name: string }> = [];
  const seen = new Set<string>();

  // Pattern 1: Simple function calls - functionName(...)
  // Match: validateToken(token), process(data)
  const simplePattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  let match;

  while ((match = simplePattern.exec(lineContent)) !== null) {
    const functionName = match[1];

    // Skip keywords and common false positives
    if (!isJavaScriptKeyword(functionName) && !seen.has(functionName)) {
      calls.push({ name: functionName });
      seen.add(functionName);
    }
  }

  // Pattern 2: Method calls - obj.method(...)
  // Match: user.authenticate(), db.query()
  const methodPattern = /\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;

  while ((match = methodPattern.exec(lineContent)) !== null) {
    const methodName = match[1];

    if (!isJavaScriptKeyword(methodName) && !seen.has(methodName)) {
      calls.push({ name: methodName });
      seen.add(methodName);
    }
  }

  // Pattern 3: Async/await calls - await functionName(...)
  const awaitPattern = /await\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;

  while ((match = awaitPattern.exec(lineContent)) !== null) {
    const functionName = match[1];

    if (!isJavaScriptKeyword(functionName) && !seen.has(functionName)) {
      calls.push({ name: functionName });
      seen.add(functionName);
    }
  }

  return calls;
}

/**
 * Extract function calls from Python code
 */
function extractPythonCalls(lineContent: string): Array<{ name: string }> {
  const calls: Array<{ name: string }> = [];
  const seen = new Set<string>();

  // Pattern 1: Simple function calls - function_name(...)
  const simplePattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  let match;

  while ((match = simplePattern.exec(lineContent)) !== null) {
    const functionName = match[1];

    if (!isPythonKeyword(functionName) && !seen.has(functionName)) {
      calls.push({ name: functionName });
      seen.add(functionName);
    }
  }

  // Pattern 2: Method calls - obj.method(...)
  const methodPattern = /\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

  while ((match = methodPattern.exec(lineContent)) !== null) {
    const methodName = match[1];

    if (!isPythonKeyword(methodName) && !seen.has(methodName)) {
      calls.push({ name: methodName });
      seen.add(methodName);
    }
  }

  // Pattern 3: Async/await calls
  const awaitPattern = /await\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

  while ((match = awaitPattern.exec(lineContent)) !== null) {
    const functionName = match[1];

    if (!isPythonKeyword(functionName) && !seen.has(functionName)) {
      calls.push({ name: functionName });
      seen.add(functionName);
    }
  }

  return calls;
}

/**
 * Check if identifier is a JavaScript keyword
 */
function isJavaScriptKeyword(identifier: string): boolean {
  const keywords = new Set([
    // Keywords
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'return', 'throw', 'try', 'catch', 'finally', 'new', 'typeof', 'instanceof',
    'delete', 'void', 'async', 'await', 'yield', 'import', 'export', 'from',
    'class', 'extends', 'super', 'this', 'static', 'const', 'let', 'var',
    'function', 'constructor', 'get', 'set',

    // Common builtins to skip
    'console', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'require', 'module', 'exports', '__dirname', '__filename',
  ]);

  return keywords.has(identifier);
}

/**
 * Check if identifier is a Python keyword
 */
function isPythonKeyword(identifier: string): boolean {
  const keywords = new Set([
    // Keywords
    'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'pass',
    'return', 'raise', 'try', 'except', 'finally', 'with', 'as', 'yield',
    'import', 'from', 'class', 'def', 'lambda', 'global', 'nonlocal',
    'assert', 'del', 'in', 'is', 'not', 'and', 'or', 'async', 'await',

    // Common builtins to skip
    'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter',
    'sorted', 'reversed', 'sum', 'min', 'max', 'abs', 'round',
    'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  ]);

  return keywords.has(identifier);
}
