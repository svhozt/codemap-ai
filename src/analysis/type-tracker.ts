/**
 * Variable Type Tracker
 * Tracks variable types within function scopes for improved method call resolution
 */

import Parser from "tree-sitter";
import type { FlowNode } from "../graph/types.js";

export interface VariableType {
  name: string;           // Variable name
  type: string;           // Inferred type (class name, 'string', 'number', etc.)
  scope: string;          // Function/scope where declared
  line: number;           // Line where declared
  definitionNode?: string; // Node ID if type is a known class/function
}

export interface TypeInfo {
  variables: Map<string, VariableType>;  // variable_name -> type
  functionScope: string;                  // Current function name
}

/**
 * Extract variable types from a function's AST node
 */
export function extractVariableTypes(
  functionNode: Parser.SyntaxNode,
  functionName: string,
  parser: Parser,
  filePath: string
): VariableType[] {
  const variables: VariableType[] = [];
  const isJS = /\.(js|ts|jsx|tsx)$/.test(filePath);
  const isPython = /\.py$/.test(filePath);

  if (isJS) {
    extractJavaScriptTypes(functionNode, functionName, variables);
  } else if (isPython) {
    extractPythonTypes(functionNode, functionName, variables);
  }

  return variables;
}

/**
 * Extract variable types from JavaScript/TypeScript code
 */
function extractJavaScriptTypes(
  node: Parser.SyntaxNode,
  functionName: string,
  variables: VariableType[]
): void {
  // Pattern 1: const user = new UserHandler()
  // Pattern 2: const user: UserHandler = ...
  // Pattern 3: const user = getUserHandler()
  // Pattern 4: function processUser(user: UserHandler) { ... }

  traverseNode(node, (current) => {
    // Variable declarations with 'new' keyword
    if (current.type === "variable_declarator") {
      const nameNode = current.childForFieldName("name");
      const valueNode = current.childForFieldName("value");

      if (nameNode && valueNode) {
        const varName = nameNode.text;

        // Pattern: new ClassName()
        if (valueNode.type === "new_expression") {
          const classNode = valueNode.childForFieldName("constructor");
          if (classNode) {
            variables.push({
              name: varName,
              type: classNode.text,
              scope: functionName,
              line: nameNode.startPosition.row + 1,
            });
          }
        }

        // Pattern: variable with type annotation (TypeScript)
        const typeAnnotation = nameNode.nextNamedSibling;
        if (typeAnnotation && typeAnnotation.type === "type_annotation") {
          const typeNode = typeAnnotation.childForFieldName("type");
          if (typeNode) {
            variables.push({
              name: varName,
              type: typeNode.text,
              scope: functionName,
              line: nameNode.startPosition.row + 1,
            });
          }
        }

        // Pattern: function call that might return typed object
        // e.g., const user = getUserHandler()
        if (valueNode.type === "call_expression") {
          const funcNode = valueNode.childForFieldName("function");
          if (funcNode) {
            const funcName = funcNode.text;
            // Heuristic: if function name ends with class-like pattern, infer type
            // e.g., getUserHandler() -> UserHandler
            const inferredType = inferTypeFromFunctionName(funcName);
            if (inferredType) {
              variables.push({
                name: varName,
                type: inferredType,
                scope: functionName,
                line: nameNode.startPosition.row + 1,
              });
            }
          }
        }
      }
    }

    // Function parameters with type annotations
    if (current.type === "formal_parameters" || current.type === "required_parameter") {
      const paramNode = current.type === "required_parameter" ? current : null;
      if (paramNode) {
        const nameNode = paramNode.childForFieldName("pattern");
        const typeNode = paramNode.childForFieldName("type");

        if (nameNode && typeNode) {
          variables.push({
            name: nameNode.text,
            type: typeNode.text,
            scope: functionName,
            line: nameNode.startPosition.row + 1,
          });
        }
      }
    }
  });
}

/**
 * Extract variable types from Python code
 */
function extractPythonTypes(
  node: Parser.SyntaxNode,
  functionName: string,
  variables: VariableType[]
): void {
  // Pattern 1: user = UserHandler()
  // Pattern 2: user: UserHandler = ...
  // Pattern 3: def process_user(user: UserHandler): ...

  traverseNode(node, (current) => {
    // Assignment with class instantiation
    if (current.type === "assignment") {
      const leftNode = current.childForFieldName("left");
      const rightNode = current.childForFieldName("right");

      if (leftNode && rightNode) {
        const varName = leftNode.text;

        // Pattern: ClassName()
        if (rightNode.type === "call") {
          const funcNode = rightNode.childForFieldName("function");
          if (funcNode) {
            const className = funcNode.text;
            // If starts with uppercase, likely a class
            if (className[0] === className[0].toUpperCase()) {
              variables.push({
                name: varName,
                type: className,
                scope: functionName,
                line: leftNode.startPosition.row + 1,
              });
            }
          }
        }
      }
    }

    // Annotated assignment: user: UserHandler = ...
    if (current.type === "typed_parameter" || current.type === "type") {
      const parent = current.parent;
      if (parent && parent.type === "assignment") {
        const leftNode = parent.childForFieldName("left");
        if (leftNode && leftNode.type === "typed_default_parameter") {
          const nameNode = leftNode.childForFieldName("name");
          const typeNode = leftNode.childForFieldName("type");

          if (nameNode && typeNode) {
            variables.push({
              name: nameNode.text,
              type: typeNode.text,
              scope: functionName,
              line: nameNode.startPosition.row + 1,
            });
          }
        }
      }
    }

    // Function parameters with type hints
    if (current.type === "typed_parameter") {
      const nameNode = current.childForFieldName("name");
      const typeNode = current.childForFieldName("type");

      if (nameNode && typeNode) {
        variables.push({
          name: nameNode.text,
          type: typeNode.text,
          scope: functionName,
          line: nameNode.startPosition.row + 1,
        });
      }
    }
  });
}

/**
 * Infer type from function name using common naming patterns
 * E.g., getUserHandler() -> UserHandler
 */
function inferTypeFromFunctionName(funcName: string): string | null {
  // Pattern: getXxx() or createXxx() -> Xxx
  const patterns = [
    /^get([A-Z][a-zA-Z0-9]+)$/,      // getUser -> User
    /^create([A-Z][a-zA-Z0-9]+)$/,   // createHandler -> Handler
    /^new([A-Z][a-zA-Z0-9]+)$/,      // newUser -> User
    /^make([A-Z][a-zA-Z0-9]+)$/,     // makeHandler -> Handler
  ];

  for (const pattern of patterns) {
    const match = funcName.match(pattern);
    if (match) {
      return match[1]; // Return the class name
    }
  }

  return null;
}

/**
 * Traverse AST node and apply visitor function
 */
function traverseNode(
  node: Parser.SyntaxNode,
  visitor: (node: Parser.SyntaxNode) => void
): void {
  visitor(node);

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      traverseNode(child, visitor);
    }
  }
}

/**
 * Build a type map for a function scope
 */
export function buildTypeMap(variables: VariableType[]): Map<string, string> {
  const typeMap = new Map<string, string>();

  for (const variable of variables) {
    typeMap.set(variable.name, variable.type);
  }

  return typeMap;
}

/**
 * Resolve variable type from type map
 */
export function resolveVariableType(
  varName: string,
  typeMap: Map<string, string>
): string | null {
  return typeMap.get(varName) || null;
}

/**
 * Check if a type matches a known class from nodes
 */
export function matchTypeToNode(
  typeName: string,
  nodes: FlowNode[]
): FlowNode | null {
  // Direct match: type name exactly matches node name
  const exactMatch = nodes.find(
    (n) => n.type === "class" && n.name === typeName
  );

  if (exactMatch) {
    return exactMatch;
  }

  // Partial match: handle namespaced classes
  // E.g., "handlers.UserHandler" -> "UserHandler"
  const partialMatch = nodes.find(
    (n) => n.type === "class" && typeName.endsWith(n.name)
  );

  return partialMatch || null;
}
