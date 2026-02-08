/**
 * Property Access Tracker
 * Extracts and tracks property accesses from code to detect breaking data shape changes
 */

import Parser from "tree-sitter";

export interface PropertyAccess {
  objectName: string;       // "user"
  propertyPath: string[];   // ["profile", "avatar"]
  fullPath: string;         // "user.profile.avatar"
  line: number;
  scopeId: string;          // Function/method where accessed
  accessType: 'dot' | 'bracket' | 'optional';
}

export interface PropertyAccessMap {
  [fullPath: string]: AccessLocation[];
}

export interface AccessLocation {
  scopeId: string;
  scopeName: string;
  file: string;
  line: number;
}

/**
 * Extract all property accesses from a function's AST node
 */
export function extractPropertyAccesses(
  functionNode: Parser.SyntaxNode,
  scopeId: string,
  scopeName: string,
  filePath: string
): PropertyAccess[] {
  const accesses: PropertyAccess[] = [];
  const isJS = /\.(js|ts|jsx|tsx)$/.test(filePath);
  const isPython = /\.py$/.test(filePath);

  if (isJS) {
    extractJavaScriptPropertyAccesses(functionNode, scopeId, scopeName, accesses);
  } else if (isPython) {
    extractPythonPropertyAccesses(functionNode, scopeId, scopeName, accesses);
  }

  return accesses;
}

/**
 * Extract property accesses from JavaScript/TypeScript code
 */
function extractJavaScriptPropertyAccesses(
  node: Parser.SyntaxNode,
  scopeId: string,
  scopeName: string,
  accesses: PropertyAccess[]
): void {
  traverseNode(node, (current) => {
    // Pattern 1: Member expression - obj.property
    if (current.type === "member_expression") {
      const access = parseJavaScriptMemberExpression(current, scopeId);
      if (access) {
        accesses.push(access);
      }
    }

    // Pattern 2: Optional chaining - obj?.property
    if (current.type === "optional_chain") {
      const memberExpr = current.children.find((c) => c.type === "member_expression");
      if (memberExpr) {
        const access = parseJavaScriptMemberExpression(memberExpr, scopeId);
        if (access) {
          access.accessType = 'optional';
          accesses.push(access);
        }
      }
    }

    // Pattern 3: Subscript expression - obj["property"]
    if (current.type === "subscript_expression") {
      const access = parseJavaScriptSubscript(current, scopeId);
      if (access) {
        accesses.push(access);
      }
    }
  });
}

/**
 * Parse JavaScript member expression (obj.property.nested)
 */
function parseJavaScriptMemberExpression(
  node: Parser.SyntaxNode,
  scopeId: string
): PropertyAccess | null {
  const propertyPath: string[] = [];
  let objectName = "";
  let currentNode: Parser.SyntaxNode | null = node;

  // Walk up the member expression chain
  while (currentNode && currentNode.type === "member_expression") {
    // Get property name
    const propertyNode = currentNode.childForFieldName("property");
    if (propertyNode) {
      propertyPath.unshift(propertyNode.text);
    }

    // Get object (might be another member expression)
    const objectNode = currentNode.childForFieldName("object");
    if (!objectNode) break;

    if (objectNode.type === "identifier") {
      objectName = objectNode.text;
      break;
    } else if (objectNode.type === "member_expression") {
      currentNode = objectNode;
    } else {
      // Complex expression (call, etc.) - skip
      return null;
    }
  }

  // Skip if no object name or common false positives
  if (!objectName || isCommonJavaScriptObject(objectName)) {
    return null;
  }

  // Skip if property path is empty
  if (propertyPath.length === 0) {
    return null;
  }

  return {
    objectName,
    propertyPath,
    fullPath: `${objectName}.${propertyPath.join(".")}`,
    line: node.startPosition.row + 1,
    scopeId,
    accessType: 'dot',
  };
}

/**
 * Parse JavaScript subscript expression (obj["property"])
 */
function parseJavaScriptSubscript(
  node: Parser.SyntaxNode,
  scopeId: string
): PropertyAccess | null {
  const objectNode = node.childForFieldName("object");
  const indexNode = node.childForFieldName("index");

  if (!objectNode || !indexNode) return null;

  // Only track static string keys, not dynamic variables
  if (indexNode.type !== "string") return null;

  const objectName = objectNode.text;
  const propertyName = indexNode.text.replace(/['"]/g, "");

  if (isCommonJavaScriptObject(objectName)) {
    return null;
  }

  return {
    objectName,
    propertyPath: [propertyName],
    fullPath: `${objectName}.${propertyName}`,
    line: node.startPosition.row + 1,
    scopeId,
    accessType: 'bracket',
  };
}

/**
 * Extract property accesses from Python code
 */
function extractPythonPropertyAccesses(
  node: Parser.SyntaxNode,
  scopeId: string,
  scopeName: string,
  accesses: PropertyAccess[]
): void {
  traverseNode(node, (current) => {
    // Pattern: Attribute access - obj.property
    if (current.type === "attribute") {
      const access = parsePythonAttribute(current, scopeId);
      if (access) {
        accesses.push(access);
      }
    }

    // Pattern: Subscript - obj["property"] or obj[key]
    if (current.type === "subscript") {
      const access = parsePythonSubscript(current, scopeId);
      if (access) {
        accesses.push(access);
      }
    }
  });
}

/**
 * Parse Python attribute access (obj.property.nested)
 */
function parsePythonAttribute(
  node: Parser.SyntaxNode,
  scopeId: string
): PropertyAccess | null {
  const propertyPath: string[] = [];
  let objectName = "";
  let currentNode: Parser.SyntaxNode | null = node;

  // Walk up the attribute chain
  while (currentNode && currentNode.type === "attribute") {
    // Get attribute name
    const attrNode = currentNode.childForFieldName("attribute");
    if (attrNode) {
      propertyPath.unshift(attrNode.text);
    }

    // Get object (might be another attribute)
    const objectNode = currentNode.childForFieldName("object");
    if (!objectNode) break;

    if (objectNode.type === "identifier") {
      objectName = objectNode.text;
      break;
    } else if (objectNode.type === "attribute") {
      currentNode = objectNode;
    } else {
      // Complex expression - skip
      return null;
    }
  }

  // Skip common false positives
  if (!objectName || isCommonPythonObject(objectName)) {
    return null;
  }

  // Skip if property path is empty
  if (propertyPath.length === 0) {
    return null;
  }

  return {
    objectName,
    propertyPath,
    fullPath: `${objectName}.${propertyPath.join(".")}`,
    line: node.startPosition.row + 1,
    scopeId,
    accessType: 'dot',
  };
}

/**
 * Parse Python subscript (obj["property"])
 */
function parsePythonSubscript(
  node: Parser.SyntaxNode,
  scopeId: string
): PropertyAccess | null {
  const valueNode = node.childForFieldName("value");

  // Find subscript children
  const subscriptChildren = node.children.filter(
    (c) => c.type === "string" || c.type === "identifier"
  );

  if (!valueNode || subscriptChildren.length === 0) return null;

  // Only track static string keys
  const keyNode = subscriptChildren.find((c) => c.type === "string");
  if (!keyNode) return null;

  const objectName = valueNode.text;

  // Extract string content
  const stringContent = keyNode.children.find((c) => c.type === "string_content");
  const propertyName = stringContent ? stringContent.text : keyNode.text.replace(/['"]/g, "");

  if (isCommonPythonObject(objectName)) {
    return null;
  }

  return {
    objectName,
    propertyPath: [propertyName],
    fullPath: `${objectName}.${propertyName}`,
    line: node.startPosition.row + 1,
    scopeId,
    accessType: 'bracket',
  };
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
 * Check if identifier is a common JavaScript object to skip
 */
function isCommonJavaScriptObject(name: string): boolean {
  const commonObjects = new Set([
    // Global objects
    'console', 'window', 'document', 'process', 'global',
    // Common libraries
    'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number',
    // Keywords
    'this', 'super',
    // Common module patterns
    'exports', 'module', 'require',
  ]);

  return commonObjects.has(name);
}

/**
 * Check if identifier is a common Python object to skip
 */
function isCommonPythonObject(name: string): boolean {
  const commonObjects = new Set([
    // Keywords
    'self', 'cls',
    // Built-in types
    'str', 'int', 'float', 'dict', 'list', 'tuple', 'set',
    // Common modules
    'os', 'sys', 'json', 'math', 'datetime',
  ]);

  return commonObjects.has(name);
}

/**
 * Build a map of property accesses grouped by full path
 */
export function buildAccessMap(
  accesses: PropertyAccess[],
  scopeName: string,
  file: string
): PropertyAccessMap {
  const map: PropertyAccessMap = {};

  for (const access of accesses) {
    const key = access.fullPath;

    if (!map[key]) {
      map[key] = [];
    }

    map[key].push({
      scopeId: access.scopeId,
      scopeName,
      file,
      line: access.line,
    });
  }

  return map;
}

/**
 * Get all accesses for a specific property path
 */
export function getAccessesForProperty(
  propertyPath: string,
  allAccesses: PropertyAccess[]
): PropertyAccess[] {
  return allAccesses.filter((access) => access.fullPath === propertyPath);
}

/**
 * Get all accesses on a specific object
 */
export function getAccessesForObject(
  objectName: string,
  allAccesses: PropertyAccess[]
): PropertyAccess[] {
  return allAccesses.filter((access) => access.objectName === objectName);
}

/**
 * Check if a property access matches a pattern
 * E.g., matches("user.email", "user.*") -> true
 */
export function matchesPattern(fullPath: string, pattern: string): boolean {
  // Convert pattern to regex
  const regexPattern = pattern
    .replace(/\./g, "\\.")  // Escape dots
    .replace(/\*/g, ".*");   // Wildcard

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(fullPath);
}

/**
 * Get property depth (number of nested levels)
 */
export function getPropertyDepth(access: PropertyAccess): number {
  return access.propertyPath.length;
}

/**
 * Get top-level property (first in path)
 */
export function getTopLevelProperty(access: PropertyAccess): string {
  return access.propertyPath[0];
}

/**
 * Filter accesses by depth
 */
export function filterByDepth(
  accesses: PropertyAccess[],
  minDepth: number,
  maxDepth?: number
): PropertyAccess[] {
  return accesses.filter((access) => {
    const depth = getPropertyDepth(access);
    if (maxDepth !== undefined) {
      return depth >= minDepth && depth <= maxDepth;
    }
    return depth >= minDepth;
  });
}
