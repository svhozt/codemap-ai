/**
 * Python parser using Tree-sitter
 */

import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import { BaseParser } from "./base.js";
import type { FileAnalysis, GraphNode, GraphEdge, ImportInfo, ExportInfo } from "../types.js";

export class PythonParser extends BaseParser {
  language = "python";
  extensions = [".py"];

  private parser: Parser;
  public treeSitterParser: Parser; // Expose for Phase 3

  constructor() {
    super();
    this.parser = new Parser();
    this.parser.setLanguage(Python);
    this.treeSitterParser = this.parser; // Expose parser
  }

  parse(filePath: string, content: string): FileAnalysis {
    const analysis = this.createEmptyAnalysis(filePath);

    // Ensure content is a string (not Buffer)
    const sourceCode = typeof content === "string" ? content : String(content);

    // Skip extremely large files (>500KB) to prevent memory issues
    if (sourceCode.length > 500000) {
      const lines = sourceCode.split("\n");
      const fileNode = this.createNode(
        "file",
        filePath.split("/").pop() || filePath,
        filePath,
        1,
        lines.length
      );
      analysis.nodes.push(fileNode);
      return analysis;
    }

    let tree;
    try {
      // Use callback-based parsing to avoid "Invalid argument" errors with large files
      // This is more robust than passing the string directly
      tree = this.parser.parse((index, position) => {
        if (index >= sourceCode.length) {
          return null;
        }
        const endIndex = Math.min(index + 1024, sourceCode.length);
        return sourceCode.substring(index, endIndex);
      });
    } catch (error) {
      // If parsing fails, just return the file node
      const lines = sourceCode.split("\n");
      const fileNode = this.createNode(
        "file",
        filePath.split("/").pop() || filePath,
        filePath,
        1,
        lines.length
      );
      analysis.nodes.push(fileNode);
      return analysis;
    }

    const lines = sourceCode.split("\n");

    // Create file node
    const fileNode = this.createNode(
      "file",
      filePath.split("/").pop() || filePath,
      filePath,
      1,
      lines.length
    );
    analysis.nodes.push(fileNode);

    // Walk the tree
    this.walkTree(tree.rootNode, filePath, analysis, fileNode.id);

    return analysis;
  }

  private walkTree(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    switch (node.type) {
      case "import_statement":
        this.handleImport(node, analysis);
        break;

      case "import_from_statement":
        this.handleFromImport(node, analysis);
        break;

      case "function_definition":
        this.handleFunction(node, filePath, analysis, parentId);
        return; // Don't recurse into function body for top-level analysis

      case "class_definition":
        this.handleClass(node, filePath, analysis, parentId);
        return; // Don't recurse, class handler will process methods

      case "call":
        this.handleCall(node, filePath, analysis, parentId);
        break;
    }

    // Recurse into children
    for (const child of node.children) {
      this.walkTree(child, filePath, analysis, parentId);
    }
  }

  private handleImport(node: Parser.SyntaxNode, analysis: FileAnalysis): void {
    // import foo, bar, baz
    for (const child of node.children) {
      if (child.type === "dotted_name") {
        analysis.imports.push({
          source: child.text,
          specifiers: [child.text.split(".").pop() || child.text],
          isDefault: false,
          isNamespace: true,
          line: node.startPosition.row + 1,
        });
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        const aliasNode = child.childForFieldName("alias");
        if (nameNode) {
          analysis.imports.push({
            source: nameNode.text,
            specifiers: [aliasNode?.text || nameNode.text],
            isDefault: false,
            isNamespace: true,
            line: node.startPosition.row + 1,
          });
        }
      }
    }
  }

  private handleFromImport(node: Parser.SyntaxNode, analysis: FileAnalysis): void {
    // from foo import bar, baz
    const moduleNode = node.childForFieldName("module_name");
    if (!moduleNode) return;

    const source = moduleNode.text;
    const specifiers: string[] = [];

    for (const child of node.children) {
      if (child.type === "import_prefix") {
        // Handle relative imports (from . import x, from .. import y)
        continue;
      }

      if (child.type === "dotted_name" && child !== moduleNode) {
        specifiers.push(child.text);
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        if (nameNode) {
          specifiers.push(nameNode.text);
        }
      } else if (child.type === "wildcard_import") {
        specifiers.push("*");
      }
    }

    if (specifiers.length === 0) {
      // Check for named imports in different structure
      for (const child of node.children) {
        if (child.type === "import_list" || child.type === "import_from_specifier") {
          for (const spec of child.children) {
            if (spec.type === "dotted_name" || spec.type === "identifier") {
              specifiers.push(spec.text);
            }
          }
        }
      }
    }

    analysis.imports.push({
      source,
      specifiers,
      isDefault: false,
      isNamespace: specifiers.includes("*"),
      line: node.startPosition.row + 1,
    });
  }

  private handleFunction(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text;

    // Check for decorators - they are siblings within parent decorated_definition
    const decorators: string[] = [];
    const decoratorDetails: Array<{ name: string; args: string[]; kwargs?: Record<string, string> }> = [];

    // Check if parent is decorated_definition
    if (node.parent?.type === "decorated_definition") {
      // Decorators are children of decorated_definition, before the function_definition
      for (const sibling of node.parent.children) {
        if (sibling.type === "decorator") {
          // Find the decorator call or attribute
          const decoratorCall = sibling.children.find((c) => c.type === "call");
          const decoratorAttr = sibling.children.find((c) => c.type === "attribute" || c.type === "identifier");

          if (decoratorCall) {
            // Decorator with arguments: @router.post("/orders")
            const funcName = decoratorCall.children.find((c) => c.type === "attribute" || c.type === "identifier");
            if (funcName) {
              const fullDecorator = funcName.text;
              decorators.push(fullDecorator);

              // Extract arguments (both positional and keyword)
              const args: string[] = [];
              const kwargs: Record<string, string> = {};
              const argList = decoratorCall.children.find((c) => c.type === "argument_list");
              if (argList) {
                for (const arg of argList.children) {
                  if (arg.type === "string") {
                    // Positional string argument
                    const stringContent = arg.children.find((c) => c.type === "string_content");
                    const argText = stringContent ? stringContent.text : arg.text.replace(/^["']|["']$/g, "");
                    args.push(argText);
                  } else if (arg.type === "keyword_argument") {
                    // Keyword argument: tags=["orders"]
                    const keyNode = arg.childForFieldName("name");
                    const valueNode = arg.childForFieldName("value");
                    if (keyNode && valueNode) {
                      const key = keyNode.text;
                      let value = valueNode.text;
                      // Simplify list values
                      if (valueNode.type === "list") {
                        const items: string[] = [];
                        for (const child of valueNode.children) {
                          if (child.type === "string") {
                            const stringContent = child.children.find((c) => c.type === "string_content");
                            items.push(stringContent ? stringContent.text : child.text.replace(/^["']|["']$/g, ""));
                          }
                        }
                        value = items.length > 0 ? items.join(",") : value;
                      }
                      kwargs[key] = value;
                    }
                  } else if (arg.type === "identifier") {
                    // Positional identifier argument
                    args.push(arg.text);
                  }
                }
              }

              decoratorDetails.push({ name: fullDecorator, args, kwargs });
            }
          } else if (decoratorAttr) {
            // Simple decorator without arguments: @property
            const fullDecorator = decoratorAttr.text;
            decorators.push(fullDecorator);
            decoratorDetails.push({ name: fullDecorator, args: [] });
          }
        }
      }
    }

    // Check if async
    const isAsync = node.children.some((c) => c.type === "async");

    // Extract return type hint from -> annotation
    let returnType: string | undefined;
    const returnTypeNode = node.childForFieldName("return_type");
    if (returnTypeNode) {
      returnType = returnTypeNode.text;
      // Clean up the type (remove quotes, generic parameters for simple matching)
      returnType = returnType.replace(/["']/g, "").split("[")[0].trim();
    }

    const funcNode = this.createNode(
      "function",
      name,
      filePath,
      node.startPosition.row + 1,
      node.endPosition.row + 1,
      {
        async: isAsync,
        decorators,
        decoratorDetails: JSON.stringify(decoratorDetails),
        isPrivate: name.startsWith("_"),
        isDunder: name.startsWith("__") && name.endsWith("__"),
        returnType,
      }
    );

    analysis.nodes.push(funcNode);
    analysis.edges.push(this.createEdge("contains", parentId, funcNode.id));

    // Check for FastAPI route decorators (@router.get, @router.post, etc.)
    this.detectFastAPIRoute(decoratorDetails, funcNode, analysis);

    // Parse function parameters for Depends() and type hints
    const parameters = node.childForFieldName("parameters");
    if (parameters) {
      this.detectDependsPattern(parameters, funcNode, analysis);
      this.extractParameterTypes(parameters, funcNode.id, filePath, analysis);
    }

    // Parse function body for calls
    const body = node.childForFieldName("body");
    if (body) {
      this.parseBodyForCalls(body, filePath, analysis, funcNode.id);
    }

    // If not private, consider it exported
    if (!name.startsWith("_")) {
      analysis.exports.push({
        name,
        isDefault: false,
        line: node.startPosition.row + 1,
      });
    }
  }

  /**
   * Detect FastAPI route decorators like @router.post("/orders")
   */
  private detectFastAPIRoute(
    decoratorDetails: Array<{ name: string; args: string[]; kwargs?: Record<string, string> }>,
    funcNode: GraphNode,
    analysis: FileAnalysis
  ): void {
    for (const dec of decoratorDetails) {
      // Match patterns: router.get, router.post, app.get, etc.
      const routeMatch = dec.name.match(/^(router|app)\.(get|post|put|patch|delete|options|head)$/);
      if (routeMatch && dec.args.length > 0) {
        const method = routeMatch[2].toUpperCase();
        const path = dec.args[0]; // First argument is the path

        // Store as metadata in the function node
        if (!funcNode.metadata) funcNode.metadata = {};
        funcNode.metadata.httpEndpoint = {
          method,
          path,
        };
      }
    }
  }

  /**
   * Detect Depends() pattern in function parameters
   * Example: user: User = Depends(authenticate_user)
   */
  private detectDependsPattern(
    parameters: Parser.SyntaxNode,
    funcNode: GraphNode,
    analysis: FileAnalysis
  ): void {
    for (const param of parameters.children) {
      if (param.type === "typed_parameter" || param.type === "default_parameter") {
        // Look for default value
        const defaultValue = param.children.find((c) => c.type === "call");
        if (defaultValue) {
          // Check if it's a Depends() call
          const funcCall = defaultValue.childForFieldName("function");
          if (funcCall && funcCall.text === "Depends") {
            // Extract the argument to Depends()
            const argList = defaultValue.childForFieldName("arguments");
            if (argList) {
              for (const arg of argList.children) {
                if (arg.type === "identifier") {
                  const dependencyName = arg.text;

                  // Get parameter name
                  const paramName = param.children.find(
                    (c) => c.type === "identifier"
                  )?.text;

                  // Store in metadata
                  if (!funcNode.metadata) funcNode.metadata = {};
                  if (!funcNode.metadata.depends) funcNode.metadata.depends = [];
                  (funcNode.metadata.depends as any[]).push({
                    parameterName: paramName,
                    dependencyName,
                    line: param.startPosition.row + 1,
                  });

                  // Create an edge to represent this dependency
                  // We'll use a special edge type that will be resolved later
                  analysis.edges.push(
                    this.createEdge("depends", funcNode.id, `ref:${dependencyName}`, {
                      unresolvedName: dependencyName,
                      parameterName: paramName,
                      line: param.startPosition.row + 1,
                    })
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  /**
   * Extract parameter type hints and register as variable types
   * Example: def process(user: User, config: Config)
   */
  private extractParameterTypes(
    parameters: Parser.SyntaxNode,
    scopeId: string,
    filePath: string,
    analysis: FileAnalysis
  ): void {
    for (const param of parameters.children) {
      if (param.type === "typed_parameter") {
        // Get parameter name
        const nameNode = param.children.find((c) => c.type === "identifier");
        if (!nameNode) continue;

        const paramName = nameNode.text;

        // Skip self and cls
        if (paramName === "self" || paramName === "cls") continue;

        // Get type annotation
        const typeNode = param.children.find((c) => c.type === "type");
        if (!typeNode) continue;

        let typeName = typeNode.text;

        // Clean up type (remove quotes, Optional[], List[], etc.)
        typeName = typeName.replace(/["']/g, "").trim();

        // Extract base type from generics: Optional[User] -> User, List[Item] -> Item
        const genericMatch = typeName.match(/(?:Optional|List|Dict|Set)\[([^\]]+)\]/);
        if (genericMatch) {
          typeName = genericMatch[1].trim();
        }

        // Store as variable type in function scope
        if (!analysis.variableTypes) {
          analysis.variableTypes = [];
        }

        analysis.variableTypes.push({
          variableName: paramName,
          typeName,
          scopeId,
          line: param.startPosition.row + 1,
        });
      }
    }
  }

  private handleClass(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text;

    // Check for base classes
    const bases: string[] = [];
    const argumentList = node.children.find((c) => c.type === "argument_list");
    if (argumentList) {
      for (const arg of argumentList.children) {
        if (arg.type === "identifier" || arg.type === "attribute") {
          bases.push(arg.text);
        }
      }
    }

    const classNode = this.createNode(
      "class",
      name,
      filePath,
      node.startPosition.row + 1,
      node.endPosition.row + 1,
      {
        bases,
        extends: bases,  // Add extends for consistency with TypeScript
        isPrivate: name.startsWith("_"),
      }
    );

    analysis.nodes.push(classNode);
    analysis.edges.push(this.createEdge("contains", parentId, classNode.id));

    // Add extends edges
    for (const base of bases) {
      analysis.edges.push(
        this.createEdge("extends", classNode.id, `ref:${base}`, {
          unresolvedName: base,
        })
      );
    }

    // Parse class body for methods
    const body = node.childForFieldName("body");
    if (body) {
      for (const child of body.children) {
        if (child.type === "function_definition") {
          this.handleMethod(child, filePath, analysis, classNode.id);
        } else if (child.type === "decorated_definition") {
          // Handle decorated methods (@classmethod, @staticmethod, @property, etc.)
          const funcNode = child.children.find((c) => c.type === "function_definition");
          if (funcNode) {
            this.handleMethod(funcNode, filePath, analysis, classNode.id);
          }
        }
      }
    }

    // Consider non-private classes as exports
    if (!name.startsWith("_")) {
      analysis.exports.push({
        name,
        isDefault: false,
        line: node.startPosition.row + 1,
      });
    }
  }

  private handleMethod(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    classId: string
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text;

    // Find parent class name
    const parentNode = analysis.nodes.find((n) => n.id === classId);
    const parentClass = parentNode?.type === "class" ? parentNode.name : undefined;

    // Check for decorators - they are siblings within parent decorated_definition
    const decorators: string[] = [];

    // Check if parent is decorated_definition (same as for top-level functions)
    if (node.parent?.type === "decorated_definition") {
      for (const sibling of node.parent.children) {
        if (sibling.type === "decorator") {
          const decoratorAttr = sibling.children.find((c) => c.type === "attribute" || c.type === "identifier");
          if (decoratorAttr) {
            decorators.push(decoratorAttr.text);
          }
        }
      }
    }

    const isStatic = decorators.includes("staticmethod");
    const isClassMethod = decorators.includes("classmethod");
    const isProperty = decorators.includes("property");
    const isAsync = node.children.some((c) => c.type === "async");

    const methodNode = this.createNode(
      "method",
      name,
      filePath,
      node.startPosition.row + 1,
      node.endPosition.row + 1,
      {
        async: isAsync,
        decorators,
        static: isStatic,
        classmethod: isClassMethod,
        property: isProperty,
        isPrivate: name.startsWith("_"),
        isDunder: name.startsWith("__") && name.endsWith("__"),
        parentClass,
      }
    );

    analysis.nodes.push(methodNode);
    analysis.edges.push(this.createEdge("contains", classId, methodNode.id));

    // Parse method body for calls
    const body = node.childForFieldName("body");
    if (body) {
      this.parseBodyForCalls(body, filePath, analysis, methodNode.id);
    }
  }

  private handleCall(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    const funcNode = node.childForFieldName("function");
    if (!funcNode) return;

    let calledName = "";
    if (funcNode.type === "identifier") {
      calledName = funcNode.text;
    } else if (funcNode.type === "attribute") {
      // Get the full attribute access (e.g., "self.method", "module.func")
      calledName = funcNode.text;
    }

    if (calledName) {
      // Track all calls including self.method for proper resolution
      analysis.edges.push(
        this.createEdge("calls", parentId, `ref:${calledName}`, {
          unresolvedName: calledName,
          line: node.startPosition.row + 1,
        })
      );

      // Detect database operations (MongoDB patterns)
      this.detectDatabaseOperation(calledName, node, parentId, analysis);
    }
  }

  /**
   * Detect database operations (MongoDB, SQL, etc.)
   * Examples: collection.find_one(), db.users.insert_one(), collection.update_many()
   */
  private detectDatabaseOperation(
    calledName: string,
    node: Parser.SyntaxNode,
    parentId: string,
    analysis: FileAnalysis
  ): void {
    // MongoDB operation patterns
    const mongoOps = [
      "find_one",
      "find",
      "insert_one",
      "insert_many",
      "update_one",
      "update_many",
      "delete_one",
      "delete_many",
      "aggregate",
      "count_documents",
      "replace_one",
    ];

    // Check if the called method is a MongoDB operation
    const parts = calledName.split(".");
    const operation = parts[parts.length - 1];

    if (mongoOps.includes(operation)) {
      // Try to extract collection name
      let collection = "unknown";
      if (parts.length >= 2) {
        collection = parts[parts.length - 2];
      }

      // Store database operation metadata
      if (!analysis.databaseOperations) {
        analysis.databaseOperations = [];
      }

      analysis.databaseOperations.push({
        nodeId: parentId,
        operation,
        collection,
        databaseType: "mongodb",
        line: node.startPosition.row + 1,
      });
    }
  }

  private parseBodyForCalls(
    body: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    const walkForCalls = (node: Parser.SyntaxNode): void => {
      if (node.type === "call") {
        this.handleCall(node, filePath, analysis, parentId);
      } else if (node.type === "import_statement") {
        // Handle local imports inside functions
        this.handleImport(node, analysis);
      } else if (node.type === "import_from_statement") {
        // Handle local from imports inside functions
        this.handleFromImport(node, analysis);
      } else if (node.type === "assignment") {
        // Track variable assignments for type inference
        this.handleAssignment(node, filePath, analysis, parentId);
      }
      for (const child of node.children) {
        walkForCalls(child);
      }
    };
    walkForCalls(body);
  }

  /**
   * Handle variable assignments to track types
   * Examples:
   *   user = get_user(id)           # Track if get_user has type hint
   *   handler = UserHandler(db)     # Track: handler -> UserHandler
   *   cfg = Config.load()  # Track: cfg -> Config
   */
  private handleAssignment(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    scopeId: string
  ): void {
    // Get left side (variable name)
    const leftNode = node.childForFieldName("left");
    if (!leftNode || leftNode.type !== "identifier") return;

    const variableName = leftNode.text;

    // Get right side (value being assigned)
    const rightNode = node.childForFieldName("right");
    if (!rightNode) return;

    let typeName: string | null = null;

    // Pattern 1: Direct class instantiation - handler = UserHandler(...)
    if (rightNode.type === "call") {
      const funcNode = rightNode.childForFieldName("function");
      if (funcNode) {
        if (funcNode.type === "identifier") {
          // Simple: ClassName(...) or function_call()
          const funcName = funcNode.text;

          // Check if it's a known class (starts with capital) - instant assign
          if (funcName[0] === funcName[0].toUpperCase()) {
            typeName = funcName;
          } else {
            // It's a function call - we'll need to look up return type later
            // Store as a pending type resolution
            typeName = `@call:${funcName}`;
          }
        } else if (funcNode.type === "attribute") {
          // Class method: ClassName.method()
          const parts = funcNode.text.split(".");
          if (parts.length >= 2) {
            const className = parts[0];
            const methodName = parts[1];

            // If className is capitalized, assume the method returns that class type
            if (className[0] === className[0].toUpperCase()) {
              typeName = className;
            } else {
              // Store for later resolution
              typeName = `@call:${funcNode.text}`;
            }
          }
        }
      }
    }

    if (typeName && !analysis.variableTypes) {
      analysis.variableTypes = [];
    }

    if (typeName) {
      analysis.variableTypes!.push({
        variableName,
        typeName,
        scopeId,
        line: node.startPosition.row + 1,
      });
    }
  }
}
