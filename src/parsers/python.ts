/**
 * Python parser using Tree-sitter
 */

import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import { BaseParser, parseSource } from "./base.js";
import type { FileAnalysis, GraphNode } from "../types.js";

/** Largest source (in characters) we attempt to parse. */
const MAX_SOURCE_LENGTH = 500_000;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

/** typing wrappers whose single argument is the interesting type. */
const TYPE_WRAPPERS = /^(?:typing\.)?(?:Optional|List|Sequence|Iterable|Set|FrozenSet|Type|Annotated|Final|ClassVar|list|set|type)\[(.+)\]$/;

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

  parseTree(_filePath: string, content: string): Parser.Tree | null {
    const sourceCode = typeof content === "string" ? content : String(content);
    if (sourceCode.length > MAX_SOURCE_LENGTH) return null;
    try {
      return parseSource(this.parser, sourceCode);
    } catch {
      return null;
    }
  }

  parse(filePath: string, content: string): FileAnalysis {
    this.beginFile(filePath);
    const analysis = this.createEmptyAnalysis(filePath);

    // Ensure content is a string (not Buffer)
    const sourceCode = typeof content === "string" ? content : String(content);

    const fileNode = this.createFileNode(filePath, sourceCode);
    analysis.nodes.push(fileNode);

    // Very large or unparseable sources still get a file node, nothing more.
    const tree = this.parseTree(filePath, sourceCode);
    if (!tree) return analysis;
    this.rememberTree(filePath, tree);

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

      case "assignment":
        // Module-level singletons: handler = UserHandler()
        this.handleAssignment(node, filePath, analysis, parentId);
        break;
    }

    // Recurse into children
    for (const child of node.children) {
      this.walkTree(child, filePath, analysis, parentId);
    }
  }

  private handleImport(node: Parser.SyntaxNode, analysis: FileAnalysis): void {
    // import foo, bar.baz, qux as q
    for (const child of node.namedChildren) {
      if (child.type === "dotted_name") {
        // `import a.b.c` binds `a`, and the module is used as `a.b.c.func()`.
        analysis.imports.push({
          source: child.text,
          specifiers: [child.text],
          isDefault: false,
          isNamespace: true,
          line: node.startPosition.row + 1,
          aliases: { [child.text]: "*" },
        });
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        const aliasNode = child.childForFieldName("alias");
        if (nameNode) {
          const local = aliasNode?.text || nameNode.text;
          analysis.imports.push({
            source: nameNode.text,
            specifiers: [local],
            isDefault: false,
            isNamespace: true,
            line: node.startPosition.row + 1,
            aliases: { [local]: "*" },
          });
        }
      }
    }
  }

  private handleFromImport(node: Parser.SyntaxNode, analysis: FileAnalysis): void {
    // from foo import bar, baz as qux
    const moduleNode = node.childForFieldName("module_name");
    if (!moduleNode) return;

    const source = moduleNode.text;
    const specifiers: string[] = [];
    const aliases: Record<string, string> = {};

    for (const child of node.namedChildren) {
      if (child === moduleNode || child.id === moduleNode.id) continue;

      if (child.type === "dotted_name") {
        specifiers.push(child.text);
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        const aliasNode = child.childForFieldName("alias");
        if (nameNode) {
          const local = aliasNode?.text || nameNode.text;
          specifiers.push(local);
          if (local !== nameNode.text) aliases[local] = nameNode.text;
        }
      } else if (child.type === "wildcard_import") {
        specifiers.push("*");
      }
    }

    analysis.imports.push({
      source,
      specifiers,
      isDefault: false,
      isNamespace: specifiers.includes("*"),
      line: node.startPosition.row + 1,
      ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
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
    const decoratorDetails: Array<{
      name: string;
      args: string[];
      argKinds?: string[];
      kwargs?: Record<string, string>;
    }> = [];

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
              const argKinds: string[] = [];
              const kwargs: Record<string, string> = {};
              const argList = decoratorCall.children.find((c) => c.type === "argument_list");
              if (argList) {
                for (const arg of argList.children) {
                  if (arg.type === "string") {
                    // Positional string argument
                    const stringContent = arg.children.find((c) => c.type === "string_content");
                    const argText = stringContent ? stringContent.text : arg.text.replace(/^["']|["']$/g, "");
                    args.push(argText);
                    argKinds.push("string");
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
                    argKinds.push("identifier");
                  }
                }
              }

              decoratorDetails.push({ name: fullDecorator, args, argKinds, kwargs });
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
    this.detectFastAPIRoute(decoratorDetails, funcNode);

    // Parse function parameters for Depends() and type hints
    const parameters = node.childForFieldName("parameters");
    if (parameters) {
      this.detectDependsPattern(parameters, funcNode, analysis);
      this.extractParameterTypes(parameters, funcNode.id, analysis);
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
    decoratorDetails: Array<{
      name: string;
      args: string[];
      argKinds?: string[];
      kwargs?: Record<string, string>;
    }>,
    funcNode: GraphNode
  ): void {
    for (const dec of decoratorDetails) {
      // Match patterns: router.get, app.post, api_router.put, v1.router.delete, etc.
      const parts = dec.name.split(".");
      const verb = parts[parts.length - 1];
      const path = dec.args[0]; // First argument is the path
      if (
        parts.length >= 2 &&
        HTTP_METHODS.has(verb) &&
        dec.argKinds?.[0] === "string" &&
        typeof path === "string" &&
        (path === "" || path.startsWith("/"))
      ) {
        const method = verb.toUpperCase();

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
   * Detect FastAPI dependency injection in function parameters.
   * Examples:
   *   user: User = Depends(authenticate_user)
   *   user=Depends(get_user)
   *   user: Annotated[User, Depends(get_user)]
   */
  private detectDependsPattern(
    parameters: Parser.SyntaxNode,
    funcNode: GraphNode,
    analysis: FileAnalysis
  ): void {
    for (const param of parameters.namedChildren) {
      if (
        param.type !== "typed_parameter" &&
        param.type !== "default_parameter" &&
        param.type !== "typed_default_parameter"
      ) {
        continue;
      }

      const paramName = (
        param.childForFieldName("name") ?? param.namedChildren.find((c) => c.type === "identifier")
      )?.text;

      for (const call of findDescendants(param, "call")) {
        const funcCall = call.childForFieldName("function");
        const callee = funcCall?.text.split(".").pop();
        if (callee !== "Depends" && callee !== "Security") continue;

        const argList = call.childForFieldName("arguments");
        const arg = argList?.namedChildren.find(
          (c) => c.type === "identifier" || c.type === "attribute"
        );
        if (!arg) continue;

        const dependencyName = arg.text;
        const line = param.startPosition.row + 1;

        if (!funcNode.metadata) funcNode.metadata = {};
        if (!funcNode.metadata.depends) funcNode.metadata.depends = [];
        (funcNode.metadata.depends as unknown[]).push({
          parameterName: paramName,
          dependencyName,
          line,
        });

        // A "depends" edge, resolved later like any other reference.
        analysis.edges.push(
          this.createEdge("depends", funcNode.id, `ref:${dependencyName}`, {
            unresolvedName: dependencyName,
            parameterName: paramName,
            line,
          })
        );
      }
    }
  }

  /**
   * Extract parameter type hints and register as variable types
   * Example: def process(user: User, config: Optional[Config] = None)
   */
  private extractParameterTypes(
    parameters: Parser.SyntaxNode,
    scopeId: string,
    analysis: FileAnalysis
  ): void {
    for (const param of parameters.namedChildren) {
      if (param.type !== "typed_parameter" && param.type !== "typed_default_parameter") continue;

      const nameNode =
        param.childForFieldName("name") ?? param.namedChildren.find((c) => c.type === "identifier");
      const typeNode = param.childForFieldName("type");
      if (!nameNode || !typeNode) continue;

      const paramName = nameNode.text;
      if (paramName === "self" || paramName === "cls") continue;

      const typeName = simplifyTypeName(typeNode.text);
      if (!typeName) continue;

      if (!analysis.variableTypes) analysis.variableTypes = [];
      analysis.variableTypes.push({
        variableName: paramName,
        typeName,
        scopeId,
        line: param.startPosition.row + 1,
      });
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
        if (child.type === "expression_statement") {
          // Annotated class attributes (dataclasses, pydantic models): repo: Repo
          const assignment = child.namedChildren[0];
          const target = assignment?.childForFieldName("left");
          const annotation = assignment?.childForFieldName("type");
          if (assignment?.type === "assignment" && target?.type === "identifier" && annotation) {
            const typeName = simplifyTypeName(annotation.text);
            if (typeName) {
              if (!analysis.variableTypes) analysis.variableTypes = [];
              analysis.variableTypes.push({
                variableName: `self.${target.text}`,
                typeName,
                scopeId: classNode.id,
                line: child.startPosition.row + 1,
              });
            }
          }
        } else if (child.type === "function_definition") {
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

    const parameters = node.childForFieldName("parameters");
    if (parameters) {
      this.extractParameterTypes(parameters, methodNode.id, analysis);
    }

    // Parse method body for calls
    const body = node.childForFieldName("body");
    if (body) {
      this.parseBodyForCalls(body, filePath, analysis, methodNode.id, classId);
    }
  }

  private handleCall(
    node: Parser.SyntaxNode,
    _filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    const funcNode = node.childForFieldName("function");
    if (!funcNode) return;

    // "func", "self.method", "module.func", "super().method", "?.method"
    const calledName = pythonCalleeName(funcNode);

    // `super()` itself only looks up the parent class; the call that matters is `super().method()`.
    if (calledName && calledName !== "super") {
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
    parentId: string,
    classId?: string
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
        this.handleAssignment(node, filePath, analysis, parentId, classId);
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
   *   user = get_user(id)                  # user -> @call:get_user
   *   handler = UserHandler(db)            # handler -> UserHandler
   *   handler: UserHandler = make()        # handler -> UserHandler
   *   cfg = Config.load()                  # cfg -> Config
   *   self.repo = Repo(db)                 # self.repo -> Repo (on the class)
   *   self.db = db                         # self.db -> type of parameter `db`
   */
  private handleAssignment(
    node: Parser.SyntaxNode,
    _filePath: string,
    analysis: FileAnalysis,
    scopeId: string,
    classId?: string
  ): void {
    const leftNode = node.childForFieldName("left");
    if (!leftNode) return;

    let variableName: string;
    let typeScope = scopeId;

    if (leftNode.type === "identifier") {
      variableName = leftNode.text;
    } else if (
      classId &&
      leftNode.type === "attribute" &&
      leftNode.childForFieldName("object")?.text === "self" &&
      leftNode.childForFieldName("attribute")
    ) {
      // Instance attribute: stored against the class so every method can use it.
      variableName = `self.${leftNode.childForFieldName("attribute")!.text}`;
      typeScope = classId;
    } else {
      return;
    }

    let typeName: string | null = null;

    // Explicit annotation wins: handler: UserHandler = ...
    const annotation = node.childForFieldName("type");
    if (annotation) {
      typeName = simplifyTypeName(annotation.text);
    }

    const rightNode = node.childForFieldName("right");
    if (!typeName && rightNode) {
      let value = rightNode;
      if (value.type === "await") {
        value = value.namedChildren[0] ?? value;
      }

      if (value.type === "call") {
        const funcNode = value.childForFieldName("function");
        const funcName = funcNode ? pythonCalleeName(funcNode) : null;
        if (funcName && !funcName.startsWith("?")) {
          const parts = funcName.split(".");
          const head = parts[0];
          if (parts.length === 1) {
            // ClassName(...) is an instance; anything else is a plain call.
            typeName = isCapitalized(head) ? head : `@call:${funcName}`;
          } else if (isCapitalized(head) && parts.length === 2) {
            // ClassName.factory() conventionally returns an instance of the class.
            typeName = head;
          } else if (isCapitalized(parts[parts.length - 1])) {
            // module.ClassName(...)
            typeName = funcName;
          } else {
            typeName = `@call:${funcName}`;
          }
        }
      } else if (value.type === "identifier" && typeScope !== scopeId) {
        // self.db = db  -> reuse the type hint of the parameter
        const known = analysis.variableTypes?.find(
          (v) => v.scopeId === scopeId && v.variableName === value.text
        );
        if (known && !known.typeName.startsWith("@call:")) typeName = known.typeName;
      }
    }

    if (!typeName) return;
    // Call results are only useful for local variables.
    if (typeScope !== scopeId && typeName.startsWith("@call:")) return;

    if (!analysis.variableTypes) analysis.variableTypes = [];
    analysis.variableTypes.push({
      variableName,
      typeName,
      scopeId: typeScope,
      line: node.startPosition.row + 1,
    });
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function isCapitalized(name: string): boolean {
  const first = name[0];
  return !!first && first !== first.toLowerCase() && first === first.toUpperCase();
}

function findDescendants(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  const found: Parser.SyntaxNode[] = [];
  const walk = (n: Parser.SyntaxNode): void => {
    if (n.type === type) found.push(n);
    for (const child of n.namedChildren) walk(child);
  };
  walk(node);
  return found;
}

/**
 * Reduce a type hint to the class it names:
 *   "User" -> User, Optional[User] -> User, List[Item] -> Item,
 *   User | None -> User, Annotated[User, Depends(x)] -> User
 * Returns null for hints that do not name a single class (Dict[str, int], Union[A, B]...).
 */
export function simplifyTypeName(raw: string): string | null {
  let typeName = raw.replace(/["']/g, "").trim();

  for (let i = 0; i < 5; i++) {
    const wrapped = typeName.match(TYPE_WRAPPERS);
    if (!wrapped) break;
    // Annotated[User, ...] keeps only the first argument.
    typeName = splitTopLevel(wrapped[1])[0].trim();
  }

  // X | None  /  None | X
  const unionParts = typeName.split("|").map((p) => p.trim()).filter((p) => p && p !== "None");
  if (unionParts.length !== 1) return null;
  typeName = unionParts[0];

  return /^[A-Za-z_][\w.]*$/.test(typeName) ? typeName : null;
}

/** Split "A, B[C, D], E" on commas that are not inside brackets. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Dotted name of a callee expression.
 *   foo -> "foo", self.repo.save -> "self.repo.save", super().run -> "super().run",
 *   get_db().query -> "?.query" (receiver is not a plain name)
 */
export function pythonCalleeName(node: Parser.SyntaxNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") {
    const object = node.childForFieldName("object");
    const attribute = node.childForFieldName("attribute");
    if (!object || !attribute) return null;
    if (object.type === "call") {
      const fn = object.childForFieldName("function");
      const args = object.childForFieldName("arguments");
      if (fn?.text === "super" && (args?.namedChildren.length ?? 0) <= 2) {
        return `super().${attribute.text}`;
      }
      return `?.${attribute.text}`;
    }
    const receiver = pythonCalleeName(object);
    if (!receiver || receiver.startsWith("?")) return `?.${attribute.text}`;
    return `${receiver}.${attribute.text}`;
  }
  return null;
}
