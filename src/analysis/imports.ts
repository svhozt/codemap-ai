/**
 * Import dependency analyzer
 * Detects missing/unused imports and tracks what they're used for
 * Uses regex-based parsing for fast analysis
 */

import { readFileSync } from "fs";

export interface ImportIssue {
  identifier: string;
  line: number;
  type: "missing" | "unused";
  usedAt?: number[]; // Line numbers where it's used (for missing imports)
}

export interface ImportAnalysisResult {
  missing: ImportIssue[];
  unused: ImportIssue[];
}

/**
 * Check if identifier is a JavaScript/TypeScript builtin
 */
function isJavaScriptBuiltin(identifier: string): boolean {
  // Common JavaScript globals and keywords
  const builtins = new Set([
    "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp",
    "Error", "TypeError", "SyntaxError", "ReferenceError",
    "Promise", "Map", "Set", "WeakMap", "WeakSet",
    "JSON", "Math", "Infinity", "NaN", "undefined",
    "Function", "Symbol", "Proxy", "Reflect",
    "Int8Array", "Uint8Array", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
    "BigInt", "ArrayBuffer", "DataView",
    "Intl", "WebAssembly", "Buffer", "URL", "URLSearchParams",
    "console", "process", "global", "window", "document",
    // Common keywords that look like types
    "TRUE", "FALSE", "NULL",
  ]);

  return builtins.has(identifier);
}

/**
 * Check if identifier is a Python builtin
 */
function isPythonBuiltin(identifier: string): boolean {
  const builtins = new Set([
    "True", "False", "None",
    "Exception", "BaseException", "ValueError", "TypeError", "KeyError",
    "AttributeError", "IndexError", "RuntimeError", "NotImplementedError",
    "Dict", "List", "Tuple", "Set", "FrozenSet",
    "Optional", "Union", "Any", "Callable",
  ]);

  return builtins.has(identifier);
}

/**
 * Analyze import integrity in a JavaScript/TypeScript file
 */
export function analyzeJavaScriptImports(filePath: string): ImportAnalysisResult {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Extract imports using regex
  const imports = new Map<string, number>(); // identifier -> line number

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match: import X from 'Y'
    const defaultMatch = line.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultMatch) {
      imports.set(defaultMatch[1], i + 1);
    }

    // Match: import { X, Y } from 'Z'
    const namedMatch = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (namedMatch) {
      const names = namedMatch[1].split(",").map(n => n.trim().split(" as ")[0].trim());
      names.forEach(name => imports.set(name, i + 1));
    }
  }

  // Extract used identifiers (simplified - exclude comments/strings)
  const usedIdentifiers = new Map<string, number[]>(); // identifier -> line numbers

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip import lines and comments
    if (line.trim().startsWith("import ") || line.trim().startsWith("//") || line.trim().startsWith("*")) {
      continue;
    }

    // Find all identifiers in this line
    for (const [identifier] of imports) {
      // Simple regex to find identifier usage (not perfect but good enough)
      const regex = new RegExp(`\\b${identifier}\\b`, "g");
      if (regex.test(line)) {
        if (!usedIdentifiers.has(identifier)) {
          usedIdentifiers.set(identifier, []);
        }
        usedIdentifiers.get(identifier)!.push(i + 1);
      }
    }
  }

  // Find unused imports
  const unused: ImportIssue[] = [];
  for (const [identifier, line] of imports) {
    const usage = usedIdentifiers.get(identifier);
    if (!usage || usage.length === 0) {
      unused.push({ identifier, line, type: "unused" });
    }
  }

  // Find missing imports (UNIVERSAL - detect ANY identifier used but not imported)
  const missing: ImportIssue[] = [];

  // First, extract locally-defined identifiers (classes, functions, const)
  const localDefinitions = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match: class ClassName
    const classMatch = line.match(/^(?:export\s+)?class\s+([A-Z][a-zA-Z0-9]*)/);
    if (classMatch) {
      localDefinitions.add(classMatch[1]);
    }

    // Match: function functionName
    const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Z][a-zA-Z0-9]*)/);
    if (funcMatch) {
      localDefinitions.add(funcMatch[1]);
    }

    // Match: const ConstantName =
    const constMatch = line.match(/^(?:export\s+)?const\s+([A-Z][a-z][a-zA-Z0-9]*)\s*=/);
    if (constMatch) {
      localDefinitions.add(constMatch[1]);
    }
  }

  // Extract all capitalized identifiers that look like they should be imported
  // Patterns: CapitalizedWords, UPPERCASE_CONSTANTS
  const potentialImports = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Skip import lines, comments
    if (line.trim().startsWith("import ") ||
        line.trim().startsWith("//") ||
        line.trim().startsWith("*") ||
        line.trim().startsWith("#")) {
      continue;
    }

    // Remove inline comments (// and /* */)
    line = line.replace(/\/\/.*$/g, "");
    line = line.replace(/\/\*.*?\*\//g, "");

    // Remove strings and template literals to avoid false positives
    line = line.replace(/[`"'].*?[`"']/g, "");

    // Match identifiers that look like imported types/classes
    // Pattern: PascalCase or mixedCase (not SCREAMING_SNAKE_CASE)
    // Examples: CallToolRequestSchema, Redis, MongoClient (YES)
    // Skip: LOG_LEVEL, ECONNREFUSED, MAX_VALUE (NO - these are constants)
    // Skip: obj.Property (property access chains)
    const matches = line.matchAll(/(?<!\.)([A-Z][a-z][a-zA-Z0-9]*)(?!\.)/g);
    for (const match of matches) {
      const identifier = match[1];

      // Skip common JavaScript globals and keywords
      if (!isJavaScriptBuiltin(identifier)) {
        potentialImports.add(identifier);
      }
    }
  }

  // Check which potential imports are actually missing
  for (const identifier of potentialImports) {
    // Skip if it's imported OR defined locally
    if (!imports.has(identifier) && !localDefinitions.has(identifier)) {
      // Find where it's used
      const usageLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match whole word only (not part of another identifier)
        const regex = new RegExp(`\\b${identifier}\\b`);
        if (regex.test(line) && !line.trim().startsWith("//")) {
          usageLines.push(i + 1);
        }
      }

      if (usageLines.length > 0) {
        missing.push({
          identifier,
          line: usageLines[0],
          type: "missing",
          usedAt: usageLines,
        });
      }
    }
  }

  return { missing, unused };
}

/**
 * Analyze import integrity in a Python file
 */
export function analyzePythonImports(filePath: string): ImportAnalysisResult {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Extract imports
  const imports = new Map<string, number>(); // identifier -> line number

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match: import X
    const importMatch = line.match(/^import\s+(\w+)/);
    if (importMatch) {
      imports.set(importMatch[1], i + 1);
    }

    // Match: from X import Y
    const fromMatch = line.match(/^from\s+[\w.]+\s+import\s+(.+)/);
    if (fromMatch) {
      const names = fromMatch[1].split(",").map(n => n.trim().split(" as ")[0].trim());
      names.forEach(name => imports.set(name, i + 1));
    }
  }

  // Extract used identifiers
  const usedIdentifiers = new Map<string, number[]>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip import lines and comments
    if (line.trim().startsWith("import ") || line.trim().startsWith("from ") || line.trim().startsWith("#")) {
      continue;
    }

    // Find all identifiers in this line
    for (const [identifier] of imports) {
      const regex = new RegExp(`\\b${identifier}\\b`, "g");
      if (regex.test(line)) {
        if (!usedIdentifiers.has(identifier)) {
          usedIdentifiers.set(identifier, []);
        }
        usedIdentifiers.get(identifier)!.push(i + 1);
      }
    }
  }

  // Find unused imports
  const unused: ImportIssue[] = [];
  for (const [identifier, line] of imports) {
    const usage = usedIdentifiers.get(identifier);
    if (!usage || usage.length === 0) {
      unused.push({ identifier, line, type: "unused" });
    }
  }

  // Find missing imports (UNIVERSAL - detect ANY identifier used but not imported)
  const missing: ImportIssue[] = [];

  // First, extract locally-defined identifiers (classes, functions)
  const localDefinitions = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match: class ClassName
    const classMatch = line.match(/^class\s+([A-Z][a-zA-Z0-9_]*)/);
    if (classMatch) {
      localDefinitions.add(classMatch[1]);
    }

    // Match: def FunctionName
    const funcMatch = line.match(/^(?:async\s+)?def\s+([A-Z][a-zA-Z0-9_]*)/);
    if (funcMatch) {
      localDefinitions.add(funcMatch[1]);
    }
  }

  // Extract all capitalized identifiers (likely classes/types)
  const potentialImports = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Skip import lines and comments
    if (line.trim().startsWith("import ") ||
        line.trim().startsWith("from ") ||
        line.trim().startsWith("#")) {
      continue;
    }

    // Remove inline comments
    line = line.replace(/#.*$/g, "");

    // Remove strings to avoid false positives
    line = line.replace(/[`"'f].*?[`"']/g, "");

    // Match capitalized identifiers (likely imported classes/types)
    // Skip property access chains
    const matches = line.matchAll(/(?<!\.)([A-Z][a-zA-Z0-9_]*)(?!\.)/g);
    for (const match of matches) {
      const identifier = match[1];

      // Skip Python builtins
      if (!isPythonBuiltin(identifier)) {
        potentialImports.add(identifier);
      }
    }
  }

  // Check which potential imports are actually missing
  for (const identifier of potentialImports) {
    // Skip if it's imported OR defined locally
    if (!imports.has(identifier) && !localDefinitions.has(identifier)) {
      // Find where it's used
      const usageLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const regex = new RegExp(`\\b${identifier}\\b`);
        if (regex.test(line) && !line.trim().startsWith("#")) {
          usageLines.push(i + 1);
        }
      }

      if (usageLines.length > 0) {
        missing.push({
          identifier,
          line: usageLines[0],
          type: "missing",
          usedAt: usageLines,
        });
      }
    }
  }

  return { missing, unused };
}

/**
 * Main entry point - analyzes imports based on file type
 */
export function analyzeImports(filePath: string): ImportAnalysisResult {
  if (filePath.endsWith(".py")) {
    return analyzePythonImports(filePath);
  } else if (filePath.match(/\.(js|jsx|ts|tsx)$/)) {
    return analyzeJavaScriptImports(filePath);
  }

  return { missing: [], unused: [] };
}
