/**
 * Return Value Analyzer
 * Analyzes function return statements to track data shapes and types
 */

import type Parser from "tree-sitter";

export interface ReturnInfo {
  functionId: string;
  functionName: string;
  returnType: string | null;        // Inferred type
  objectShape: ObjectShape | null;  // If returns object literal
  line: number;
  returnExpression: string;         // Raw return expression
}

export interface ObjectShape {
  properties: string[];                        // ["id", "name", "email"]
  propertyTypes: Map<string, string>;         // property -> type
  nestedShapes: Map<string, ObjectShape>;     // property -> nested shape
  isArray: boolean;
  isDictionary: boolean;
  isOptional: boolean;
}

/**
 * Analyze all return statements in a function
 */
export function analyzeReturnStatements(
  functionNode: Parser.SyntaxNode,
  functionId: string,
  functionName: string,
  filePath: string
): ReturnInfo[] {
  const returns: ReturnInfo[] = [];
  const isJS = /\.(js|ts|jsx|tsx)$/.test(filePath);
  const isPython = /\.py$/.test(filePath);

  if (isJS) {
    extractJavaScriptReturns(functionNode, functionId, functionName, returns);
  } else if (isPython) {
    extractPythonReturns(functionNode, functionId, functionName, returns);
  }

  return returns;
}

/**
 * Extract return statements from JavaScript/TypeScript
 */
function extractJavaScriptReturns(
  node: Parser.SyntaxNode,
  functionId: string,
  functionName: string,
  returns: ReturnInfo[]
): void {
  traverseNode(node, (current) => {
    if (current.type === "return_statement") {
      const returnNode = current.children.find(
        (c) => c.type !== "return" && c.type !== ";"
      );

      if (returnNode) {
        const returnInfo = parseJavaScriptReturnValue(
          returnNode,
          functionId,
          functionName
        );
        if (returnInfo) {
          returns.push(returnInfo);
        }
      }
    }
  });
}

/**
 * Parse JavaScript return value
 */
function parseJavaScriptReturnValue(
  returnNode: Parser.SyntaxNode,
  functionId: string,
  functionName: string
): ReturnInfo | null {
  const line = returnNode.startPosition.row + 1;
  const returnExpression = returnNode.text;

  let returnType: string | null = null;
  let objectShape: ObjectShape | null = null;

  // Pattern 1: Object literal - return { id: 1, name: "John" }
  if (returnNode.type === "object") {
    objectShape = extractJavaScriptObjectShape(returnNode);
    returnType = "object";
  }

  // Pattern 2: Array literal - return [1, 2, 3]
  else if (returnNode.type === "array") {
    returnType = "array";
    objectShape = {
      properties: [],
      propertyTypes: new Map(),
      nestedShapes: new Map(),
      isArray: true,
      isDictionary: false,
      isOptional: false,
    };
  }

  // Pattern 3: New expression - return new User(...)
  else if (returnNode.type === "new_expression") {
    const constructorNode = returnNode.childForFieldName("constructor");
    if (constructorNode) {
      returnType = constructorNode.text;
    }
  }

  // Pattern 4: Identifier - return user
  else if (returnNode.type === "identifier") {
    returnType = `@var:${returnNode.text}`; // Mark as variable reference
  }

  // Pattern 5: Call expression - return getUser()
  else if (returnNode.type === "call_expression") {
    const funcNode = returnNode.childForFieldName("function");
    if (funcNode) {
      returnType = `@call:${funcNode.text}`;
    }
  }

  return {
    functionId,
    functionName,
    returnType,
    objectShape,
    line,
    returnExpression,
  };
}

/**
 * Extract object shape from JavaScript object literal
 */
function extractJavaScriptObjectShape(objectNode: Parser.SyntaxNode): ObjectShape {
  const properties: string[] = [];
  const propertyTypes = new Map<string, string>();
  const nestedShapes = new Map<string, ObjectShape>();

  for (const child of objectNode.children) {
    if (child.type === "pair") {
      const keyNode = child.childForFieldName("key");
      const valueNode = child.childForFieldName("value");

      if (keyNode) {
        const propertyName = keyNode.text.replace(/['"]/g, "");
        properties.push(propertyName);

        if (valueNode) {
          // Infer property type
          const propertyType = inferJavaScriptType(valueNode);
          propertyTypes.set(propertyName, propertyType);

          // Extract nested object shape
          if (valueNode.type === "object") {
            const nestedShape = extractJavaScriptObjectShape(valueNode);
            nestedShapes.set(propertyName, nestedShape);
          }
        }
      }
    }
  }

  return {
    properties,
    propertyTypes,
    nestedShapes,
    isArray: false,
    isDictionary: false,
    isOptional: false,
  };
}

/**
 * Infer JavaScript type from value node
 */
function inferJavaScriptType(valueNode: Parser.SyntaxNode): string {
  switch (valueNode.type) {
    case "number":
      return "number";
    case "string":
    case "template_string":
      return "string";
    case "true":
    case "false":
      return "boolean";
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "array":
      return "array";
    case "object":
      return "object";
    case "arrow_function":
    case "function_expression":
      return "function";
    case "identifier":
      return `@var:${valueNode.text}`;
    case "call_expression":
      return "@call";
    default:
      return "unknown";
  }
}

/**
 * Extract return statements from Python
 */
function extractPythonReturns(
  node: Parser.SyntaxNode,
  functionId: string,
  functionName: string,
  returns: ReturnInfo[]
): void {
  traverseNode(node, (current) => {
    if (current.type === "return_statement") {
      // Find the return value (skip 'return' keyword)
      const returnNode = current.children.find((c) => c.type !== "return");

      if (returnNode) {
        const returnInfo = parsePythonReturnValue(
          returnNode,
          functionId,
          functionName
        );
        if (returnInfo) {
          returns.push(returnInfo);
        }
      }
    }
  });
}

/**
 * Parse Python return value
 */
function parsePythonReturnValue(
  returnNode: Parser.SyntaxNode,
  functionId: string,
  functionName: string
): ReturnInfo | null {
  const line = returnNode.startPosition.row + 1;
  const returnExpression = returnNode.text;

  let returnType: string | null = null;
  let objectShape: ObjectShape | null = null;

  // Pattern 1: Dictionary literal - return {"id": 1, "name": "John"}
  if (returnNode.type === "dictionary") {
    objectShape = extractPythonDictionaryShape(returnNode);
    returnType = "dict";
  }

  // Pattern 2: List literal - return [1, 2, 3]
  else if (returnNode.type === "list") {
    returnType = "list";
    objectShape = {
      properties: [],
      propertyTypes: new Map(),
      nestedShapes: new Map(),
      isArray: true,
      isDictionary: false,
      isOptional: false,
    };
  }

  // Pattern 3: Call expression - return User() or get_user()
  else if (returnNode.type === "call") {
    const funcNode = returnNode.childForFieldName("function");
    if (funcNode) {
      const funcName = funcNode.text;
      // If capitalized, likely a class instantiation
      if (funcName[0] === funcName[0].toUpperCase()) {
        returnType = funcName;
      } else {
        returnType = `@call:${funcName}`;
      }
    }
  }

  // Pattern 4: Identifier - return user
  else if (returnNode.type === "identifier") {
    returnType = `@var:${returnNode.text}`;
  }

  // Pattern 5: List comprehension - return [x for x in items]
  else if (returnNode.type === "list_comprehension") {
    returnType = "list";
    objectShape = {
      properties: [],
      propertyTypes: new Map(),
      nestedShapes: new Map(),
      isArray: true,
      isDictionary: false,
      isOptional: false,
    };
  }

  return {
    functionId,
    functionName,
    returnType,
    objectShape,
    line,
    returnExpression,
  };
}

/**
 * Extract object shape from Python dictionary literal
 */
function extractPythonDictionaryShape(dictNode: Parser.SyntaxNode): ObjectShape {
  const properties: string[] = [];
  const propertyTypes = new Map<string, string>();
  const nestedShapes = new Map<string, ObjectShape>();

  for (const child of dictNode.children) {
    if (child.type === "pair") {
      const keyNode = child.children.find((c) => c.type === "string");
      const valueNode = child.children.find(
        (c) => c.type !== "string" && c.type !== ":"
      );

      if (keyNode) {
        // Extract string content
        const stringContent = keyNode.children.find(
          (c) => c.type === "string_content"
        );
        const propertyName = stringContent
          ? stringContent.text
          : keyNode.text.replace(/['"]/g, "");

        properties.push(propertyName);

        if (valueNode) {
          // Infer property type
          const propertyType = inferPythonType(valueNode);
          propertyTypes.set(propertyName, propertyType);

          // Extract nested dictionary shape
          if (valueNode.type === "dictionary") {
            const nestedShape = extractPythonDictionaryShape(valueNode);
            nestedShapes.set(propertyName, nestedShape);
          }
        }
      }
    }
  }

  return {
    properties,
    propertyTypes,
    nestedShapes,
    isArray: false,
    isDictionary: true,
    isOptional: false,
  };
}

/**
 * Infer Python type from value node
 */
function inferPythonType(valueNode: Parser.SyntaxNode): string {
  switch (valueNode.type) {
    case "integer":
    case "float":
      return "number";
    case "string":
      return "string";
    case "true":
    case "false":
      return "boolean";
    case "none":
      return "None";
    case "list":
      return "list";
    case "dictionary":
      return "dict";
    case "lambda":
      return "function";
    case "identifier":
      return `@var:${valueNode.text}`;
    case "call":
      return "@call";
    default:
      return "unknown";
  }
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
 * Merge multiple object shapes into one
 * (for functions with multiple return statements)
 */
export function mergeObjectShapes(shapes: ObjectShape[]): ObjectShape | null {
  if (shapes.length === 0) return null;
  if (shapes.length === 1) return shapes[0];

  // Combine all properties from all shapes
  const allProperties = new Set<string>();
  const propertyTypes = new Map<string, string>();
  const nestedShapes = new Map<string, ObjectShape>();
  let isArray = false;
  let isDictionary = false;

  for (const shape of shapes) {
    for (const prop of shape.properties) {
      allProperties.add(prop);
    }

    // Merge property types (take first occurrence)
    for (const [prop, type] of shape.propertyTypes) {
      if (!propertyTypes.has(prop)) {
        propertyTypes.set(prop, type);
      }
    }

    // Merge nested shapes
    for (const [prop, nested] of shape.nestedShapes) {
      if (!nestedShapes.has(prop)) {
        nestedShapes.set(prop, nested);
      }
    }

    isArray = isArray || shape.isArray;
    isDictionary = isDictionary || shape.isDictionary;
  }

  return {
    properties: Array.from(allProperties),
    propertyTypes,
    nestedShapes,
    isArray,
    isDictionary,
    isOptional: false,
  };
}

/**
 * Find missing properties between two shapes
 */
export function findMissingProperties(
  oldShape: ObjectShape,
  newShape: ObjectShape
): string[] {
  const missing: string[] = [];

  for (const prop of oldShape.properties) {
    if (!newShape.properties.includes(prop)) {
      missing.push(prop);
    }
  }

  return missing;
}

/**
 * Find added properties between two shapes
 */
export function findAddedProperties(
  oldShape: ObjectShape,
  newShape: ObjectShape
): string[] {
  const added: string[] = [];

  for (const prop of newShape.properties) {
    if (!oldShape.properties.includes(prop)) {
      added.push(prop);
    }
  }

  return added;
}

/**
 * Compare two object shapes and return differences
 */
export interface ShapeComparison {
  removedProperties: string[];
  addedProperties: string[];
  changedTypes: Array<{
    property: string;
    oldType: string;
    newType: string;
  }>;
  isCompatible: boolean;
}

export function compareObjectShapes(
  oldShape: ObjectShape,
  newShape: ObjectShape
): ShapeComparison {
  const removedProperties = findMissingProperties(oldShape, newShape);
  const addedProperties = findAddedProperties(oldShape, newShape);
  const changedTypes: Array<{
    property: string;
    oldType: string;
    newType: string;
  }> = [];

  // Check for type changes
  for (const prop of oldShape.properties) {
    if (newShape.properties.includes(prop)) {
      const oldType = oldShape.propertyTypes.get(prop);
      const newType = newShape.propertyTypes.get(prop);

      if (oldType && newType && oldType !== newType) {
        changedTypes.push({
          property: prop,
          oldType,
          newType,
        });
      }
    }
  }

  const isCompatible =
    removedProperties.length === 0 && changedTypes.length === 0;

  return {
    removedProperties,
    addedProperties,
    changedTypes,
    isCompatible,
  };
}

/**
 * Get property paths for all nested properties
 * E.g., { user: { profile: { name: "John" } } } -> ["user", "user.profile", "user.profile.name"]
 */
export function getAllPropertyPaths(shape: ObjectShape, prefix = ""): string[] {
  const paths: string[] = [];

  for (const prop of shape.properties) {
    const fullPath = prefix ? `${prefix}.${prop}` : prop;
    paths.push(fullPath);

    // Add nested paths
    const nested = shape.nestedShapes.get(prop);
    if (nested) {
      paths.push(...getAllPropertyPaths(nested, fullPath));
    }
  }

  return paths;
}
