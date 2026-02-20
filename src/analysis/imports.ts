/**
 * Import dependency analyzer
 *
 * Works on syntax trees, so multi-line imports, type-only usages, JSX and
 * comments/strings are all handled correctly.
 *
 *   unused  - a name bound by an import that is never referenced in the file
 *   missing - a name that was imported in the previous version of the file,
 *             is no longer imported or declared, but is still referenced
 *
 * "Missing" is deliberately defined relative to the previous version: it
 * catches the real failure (an import was deleted while its uses remain)
 * without guessing which bare identifiers are globals.
 */

import { readFileSync } from "fs";
import type Parser from "tree-sitter";
import { parserRegistry } from "../parsers/index.js";
import type { ImportInfo } from "../types.js";

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

export interface ImportAnalysisOptions {
  /** Current content of the file. Read from disk when omitted. */
  content?: string;
  /** Content of the previous version, used to detect removed-but-still-used imports. */
  previousContent?: string | null;
}

type SyntaxNode = Parser.SyntaxNode;

const PY_IMPORT_STATEMENTS = new Set([
  "import_statement",
  "import_from_statement",
  "future_import_statement",
]);

/** Names an import binds in the importing file, with the line of the import. */
function boundNames(imports: ImportInfo[], isPython: boolean): Map<string, number> {
  const names = new Map<string, number>();
  for (const imp of imports) {
    if (imp.isReExport) continue;
    for (const spec of imp.specifiers) {
      if (spec === "*") continue;
      // Python `import a.b.c` binds only `a`.
      const local = isPython && spec.includes(".") ? spec.split(".")[0] : spec;
      if (!names.has(local)) names.set(local, imp.line);
    }
  }
  return names;
}

function isRequireDeclaration(node: SyntaxNode): boolean {
  if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return false;
  return node.namedChildren.some((declarator) => {
    let value = declarator.childForFieldName("value");
    if (value?.type === "member_expression") value = value.childForFieldName("object");
    if (value?.type !== "call_expression") return false;
    const fn = value.childForFieldName("function");
    return fn?.type === "identifier" && fn.text === "require";
  });
}

interface Usage {
  /** identifier -> lines where it is referenced outside import statements */
  references: Map<string, number[]>;
  /** identifiers declared by the file itself (functions, classes, variables, parameters...) */
  declared: Set<string>;
  hasJsx: boolean;
  /** Python `__all__` entries: re-exported names count as used. */
  exportedNames: Set<string>;
}

function collectUsage(root: SyntaxNode, isPython: boolean): Usage {
  const references = new Map<string, number[]>();
  const declared = new Set<string>();
  const exportedNames = new Set<string>();
  let hasJsx = false;

  const declare = (node: SyntaxNode | null): void => {
    if (!node) return;
    if (
      node.type === "identifier" ||
      node.type === "type_identifier" ||
      node.type === "shorthand_property_identifier_pattern"
    ) {
      declared.add(node.text);
      return;
    }
    // Destructuring patterns, tuples, typed parameters...
    for (const child of node.namedChildren) {
      if (child.type === "type_annotation" || child.type === "type") continue;
      declare(child);
    }
  };

  const walk = (node: SyntaxNode): void => {
    const type = node.type;

    if (isPython) {
      if (PY_IMPORT_STATEMENTS.has(type)) return;
      if (type === "function_definition" || type === "class_definition") {
        declare(node.childForFieldName("name"));
      } else if (type === "parameters" || type === "lambda_parameters") {
        declare(node);
      } else if (type === "assignment" || type === "augmented_assignment") {
        const left = node.childForFieldName("left");
        if (left && left.type !== "attribute" && left.type !== "subscript") declare(left);
        if (left?.text === "__all__") {
          for (const str of node.descendantsOfType("string_content")) exportedNames.add(str.text);
        }
      } else if (type === "for_statement" || type === "for_in_clause") {
        declare(node.childForFieldName("left"));
      } else if (type === "as_pattern") {
        declare(node.childForFieldName("alias"));
      } else if (type === "named_expression") {
        declare(node.childForFieldName("name"));
      } else if (type === "string" && hasAncestor(node, "type")) {
        // Forward references: def f(user: "User") / x: "Optional[User]"
        const line = node.startPosition.row + 1;
        for (const match of node.text.matchAll(/[A-Za-z_]\w*/g)) {
          const lines = references.get(match[0]);
          if (lines) lines.push(line);
          else references.set(match[0], [line]);
        }
        return;
      }
    } else {
      if (type === "import_statement" || isRequireDeclaration(node)) return;
      if (type.startsWith("jsx_")) hasJsx = true;
      if (
        type === "function_declaration" ||
        type === "generator_function_declaration" ||
        type === "class_declaration" ||
        type === "abstract_class_declaration" ||
        type === "interface_declaration" ||
        type === "type_alias_declaration" ||
        type === "enum_declaration" ||
        type === "function_expression" ||
        type === "class"
      ) {
        declare(node.childForFieldName("name"));
      } else if (type === "variable_declarator") {
        declare(node.childForFieldName("name"));
      } else if (type === "formal_parameters") {
        for (const param of node.namedChildren) {
          declare(param.childForFieldName("pattern") ?? param);
        }
      } else if (type === "arrow_function") {
        const single = node.childForFieldName("parameter");
        if (single) declare(single);
      } else if (type === "catch_clause") {
        declare(node.childForFieldName("parameter"));
      } else if (type === "type_parameter") {
        declare(node.childForFieldName("name") ?? node.namedChildren[0]);
      }
    }

    if (
      type === "identifier" ||
      type === "type_identifier" ||
      type === "shorthand_property_identifier"
    ) {
      if (!isPropertyName(node, isPython)) {
        const lines = references.get(node.text);
        const line = node.startPosition.row + 1;
        if (lines) {
          if (lines[lines.length - 1] !== line) lines.push(line);
        } else {
          references.set(node.text, [line]);
        }
      }
      return;
    }

    for (const child of node.namedChildren) walk(child);
  };

  walk(root);
  return { references, declared, hasJsx, exportedNames };
}

function hasAncestor(node: SyntaxNode, type: string): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === type) return true;
    if (current.type === "function_definition" || current.type === "block") return false;
  }
  return false;
}

/** True for identifiers that name a member or keyword rather than reference a binding. */
function isPropertyName(node: SyntaxNode, isPython: boolean): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (isPython) {
    if (parent.type === "attribute") {
      return parent.childForFieldName("attribute")?.id === node.id;
    }
    if (parent.type === "keyword_argument") {
      return parent.childForFieldName("name")?.id === node.id;
    }
  }
  return false;
}

/**
 * Analyze the imports of one file.
 *
 * With `previousContent`, imports that were removed while the imported name is
 * still used are reported as `missing`.
 */
export function analyzeImports(
  filePath: string,
  options: ImportAnalysisOptions = {}
): ImportAnalysisResult {
  const result: ImportAnalysisResult = { missing: [], unused: [] };

  const parser = parserRegistry.getForFile(filePath);
  if (!parser) return result;

  let content = options.content;
  if (content === undefined) {
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return result; // deleted or unreadable: nothing to analyze
    }
  }

  const isPython = parser.language === "python";

  // Parse the previous version first: the parser keeps the tree of its last parse.
  let previousNames: Map<string, number> | null = null;
  if (typeof options.previousContent === "string") {
    previousNames = boundNames(parser.parse(filePath, options.previousContent).imports, isPython);
  }

  const analysis = parser.parse(filePath, content);
  const tree = parser.getLastTree?.(filePath);
  if (!tree) return result;

  const currentNames = boundNames(analysis.imports, isPython);
  const usage = collectUsage(tree.rootNode, isPython);

  // Unused imports. Package __init__ files import in order to re-export.
  const isPackageInit = /(^|[\\/])__init__\.py$/.test(filePath);
  if (!isPackageInit) {
    for (const [identifier, line] of currentNames) {
      if (usage.references.has(identifier)) continue;
      if (usage.exportedNames.has(identifier)) continue;
      if (identifier === "React" && usage.hasJsx) continue; // classic JSX runtime
      if (identifier === "_") continue;
      result.unused.push({ identifier, line, type: "unused" });
    }
  }

  // Imports that were removed while the name is still in use.
  if (previousNames) {
    for (const identifier of previousNames.keys()) {
      if (currentNames.has(identifier) || usage.declared.has(identifier)) continue;
      const usedAt = usage.references.get(identifier);
      if (!usedAt || usedAt.length === 0) continue;
      result.missing.push({ identifier, line: usedAt[0], type: "missing", usedAt });
    }
  }

  return result;
}
