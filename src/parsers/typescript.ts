/**
 * TypeScript/JavaScript parser using Tree-sitter
 *
 * What becomes a node:
 *   - the file itself
 *   - module-level functions (declarations, and `const f = () => {}` /
 *     `const f = function () {}` / `const C = memo(() => ...)` bindings)
 *   - classes and their methods (including arrow-function class fields)
 *   - module-level "namespace objects" (`const api = { load() {}, save: () => {} }`)
 *     and their function members
 *   - CommonJS exports assigned as functions (`exports.foo = () => {}`)
 *
 * Functions nested inside another function (callbacks, closures, inner
 * helpers) do not get their own node: the calls they make are attributed to
 * the enclosing module-level function or method. That keeps call chains
 * connected for impact analysis and matches what the Python parser does.
 */

import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import { BaseParser, parseSource } from "./base.js";
import type { FileAnalysis, GraphNode } from "../types.js";

type SyntaxNode = Parser.SyntaxNode;

interface WalkContext {
  filePath: string;
  analysis: FileAnalysis;
  /** Id of the file node. */
  fileId: string;
  /** Node that calls found here are attributed to. */
  scopeId: string;
  /** Enclosing class node id, when inside a class body. */
  classId?: string;
  /** True once we are inside a function body (nothing below creates nodes). */
  inFunction: boolean;
}

const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function_expression",
  "function", // older tree-sitter-javascript name for function expressions
  "generator_function",
]);

const CLASS_TYPES = new Set(["class_declaration", "abstract_class_declaration", "class"]);

/** Array/promise helpers whose callback argument does not make the binding a function. */
const NON_WRAPPER_CALLEES = new Set([
  "map", "filter", "forEach", "reduce", "reduceRight", "find", "findIndex", "some",
  "every", "sort", "flatMap", "then", "catch", "finally", "from",
]);

/** Largest source (in characters) we attempt to parse. */
const MAX_SOURCE_LENGTH = 500_000;

export class TypeScriptParser extends BaseParser {
  language = "typescript";
  extensions = [".ts", ".tsx", ".mts", ".cts"];

  protected parser: Parser;
  public treeSitterParser: Parser; // Exposed for data-flow analysis

  /** Default-export candidates that need all nodes to be known first. */
  private pendingDefaultNames: Array<{ names: string[]; line: number }> = [];

  constructor() {
    super();
    this.parser = new Parser();
    this.parser.setLanguage(TypeScript.typescript);
    this.treeSitterParser = this.parser;
  }

  /** Select the grammar that matches the file extension. */
  protected selectGrammar(filePath: string): void {
    if (filePath.toLowerCase().endsWith(".tsx")) {
      this.parser.setLanguage(TypeScript.tsx);
    } else {
      this.parser.setLanguage(TypeScript.typescript);
    }
  }

  parseTree(filePath: string, content: string): Parser.Tree | null {
    const sourceCode = typeof content === "string" ? content : String(content);
    if (sourceCode.length > MAX_SOURCE_LENGTH) return null;
    this.selectGrammar(filePath);
    try {
      return parseSource(this.parser, sourceCode);
    } catch {
      return null;
    }
  }

  parse(filePath: string, content: string): FileAnalysis {
    this.beginFile(filePath);
    this.pendingDefaultNames = [];

    const analysis = this.createEmptyAnalysis(filePath);

    // Ensure content is a string (not Buffer)
    const sourceCode = typeof content === "string" ? content : String(content);

    const fileNode = this.createFileNode(filePath, sourceCode);
    analysis.nodes.push(fileNode);

    // Very large or unparseable sources still get a file node, nothing more.
    const tree = this.parseTree(filePath, sourceCode);
    if (!tree) return analysis;
    this.rememberTree(filePath, tree);

    const ctx: WalkContext = {
      filePath,
      analysis,
      fileId: fileNode.id,
      scopeId: fileNode.id,
      inFunction: false,
    };

    for (const child of tree.rootNode.namedChildren) {
      this.visit(child, ctx);
    }

    this.resolvePendingDefaults(analysis);
    return analysis;
  }

  // ---------------------------------------------------------------------
  // Tree walk
  // ---------------------------------------------------------------------

  private visit(node: SyntaxNode, ctx: WalkContext): void {
    switch (node.type) {
      case "import_statement":
        this.handleImport(node, ctx);
        return;

      case "export_statement":
        this.handleExport(node, ctx);
        return;

      case "function_declaration":
      case "generator_function_declaration":
        this.handleFunctionDeclaration(node, ctx);
        return;

      case "lexical_declaration":
      case "variable_declaration":
        for (const child of node.namedChildren) {
          if (child.type === "variable_declarator") {
            this.handleDeclarator(child, node, ctx);
          }
        }
        return;

      case "class_declaration":
      case "abstract_class_declaration":
        this.handleClass(node, ctx);
        return;

      case "expression_statement": {
        const expr = node.namedChildren[0];
        if (expr && expr.type === "assignment_expression" && this.handleAssignment(expr, ctx)) {
          return;
        }
        break;
      }

      case "call_expression":
        this.handleCall(node, ctx);
        break;

      case "new_expression":
        this.handleNew(node, ctx);
        break;

      case "jsx_opening_element":
      case "jsx_self_closing_element":
        this.handleJsx(node, ctx);
        break;

      // Signatures and type-only constructs never contain calls.
      case "function_signature":
      case "method_signature":
      case "abstract_method_signature":
      case "interface_declaration":
      case "type_alias_declaration":
        return;
    }

    for (const child of node.namedChildren) {
      this.visit(child, ctx);
    }
  }

  // ---------------------------------------------------------------------
  // Imports / exports
  // ---------------------------------------------------------------------

  private handleImport(node: SyntaxNode, ctx: WalkContext): void {
    const sourceNode = node.childForFieldName("source");
    if (!sourceNode) return;

    const source = stripQuotes(sourceNode.text);
    const specifiers: string[] = [];
    const aliases: Record<string, string> = {};
    let isDefault = false;
    let isNamespace = false;

    for (const child of node.namedChildren) {
      if (child.type !== "import_clause") continue;
      for (const clauseChild of child.namedChildren) {
        if (clauseChild.type === "identifier") {
          specifiers.push(clauseChild.text);
          aliases[clauseChild.text] = "default";
          isDefault = true;
        } else if (clauseChild.type === "namespace_import") {
          const nameNode =
            clauseChild.childForFieldName("name") ||
            clauseChild.namedChildren.find((c) => c.type === "identifier");
          if (nameNode) {
            specifiers.push(nameNode.text);
            aliases[nameNode.text] = "*";
            isNamespace = true;
          }
        } else if (clauseChild.type === "named_imports") {
          for (const importSpec of clauseChild.namedChildren) {
            if (importSpec.type !== "import_specifier") continue;
            const name = importSpec.childForFieldName("name");
            const alias = importSpec.childForFieldName("alias");
            if (!name) continue;
            const local = alias ? alias.text : name.text;
            specifiers.push(local);
            if (alias) aliases[local] = name.text;
          }
        }
      }
    }

    ctx.analysis.imports.push({
      source,
      specifiers,
      isDefault,
      isNamespace,
      line: node.startPosition.row + 1,
      ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    });
  }

  private handleExport(node: SyntaxNode, ctx: WalkContext): void {
    const analysis = ctx.analysis;
    const line = node.startPosition.row + 1;
    const isDefault = node.children.some((c) => c.type === "default");
    const sourceNode = node.childForFieldName("source");
    const exportClause = node.namedChildren.find((c) => c.type === "export_clause");

    // export { a, b as c } from "./x"   /   export * from "./x"   /   export * as ns from "./x"
    if (sourceNode) {
      const source = stripQuotes(sourceNode.text);
      const specifiers: string[] = [];
      const aliases: Record<string, string> = {};
      if (exportClause) {
        for (const spec of exportClause.namedChildren) {
          if (spec.type !== "export_specifier") continue;
          const name = spec.childForFieldName("name");
          const alias = spec.childForFieldName("alias");
          if (!name) continue;
          const exported = alias ? alias.text : name.text;
          specifiers.push(exported);
          if (exported !== name.text) aliases[exported] = name.text;
          analysis.exports.push({ name: exported, isDefault: exported === "default", line });
        }
      } else {
        const nsExport = node.namedChildren.find((c) => c.type === "namespace_export");
        const nsName = nsExport?.namedChildren.find((c) => c.type === "identifier");
        if (nsName) {
          specifiers.push(nsName.text);
          aliases[nsName.text] = "*";
        } else {
          specifiers.push("*");
        }
      }
      analysis.imports.push({
        source,
        specifiers,
        isDefault: false,
        isNamespace: specifiers.includes("*"),
        line,
        isReExport: true,
        ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
      });
      return;
    }

    // export { a, b as c }
    if (exportClause) {
      for (const spec of exportClause.namedChildren) {
        if (spec.type !== "export_specifier") continue;
        const name = spec.childForFieldName("name");
        const alias = spec.childForFieldName("alias");
        if (!name) continue;
        const exported = alias ? alias.text : name.text;
        if (exported === "default") {
          analysis.exports.push({ name: name.text, isDefault: true, line });
        } else {
          analysis.exports.push({
            name: exported,
            isDefault: false,
            line,
            ...(exported !== name.text ? { localName: name.text } : {}),
          });
        }
      }
      return;
    }

    const declaration = node.childForFieldName("declaration");
    if (declaration) {
      if (
        declaration.type === "function_declaration" ||
        declaration.type === "generator_function_declaration"
      ) {
        const created = this.handleFunctionDeclaration(declaration, ctx, node, isDefault);
        if (created) analysis.exports.push({ name: created.name, isDefault, line });
      } else if (CLASS_TYPES.has(declaration.type)) {
        const created = this.handleClass(declaration, ctx, node, isDefault);
        if (created) analysis.exports.push({ name: created.name, isDefault, line });
      } else if (
        declaration.type === "lexical_declaration" ||
        declaration.type === "variable_declaration"
      ) {
        for (const child of declaration.namedChildren) {
          if (child.type !== "variable_declarator") continue;
          const nameNode = child.childForFieldName("name");
          if (nameNode?.type === "identifier") {
            analysis.exports.push({ name: nameNode.text, isDefault: false, line });
          }
          this.handleDeclarator(child, node, ctx);
        }
      } else {
        // interfaces, type aliases, enums, namespaces...
        this.visit(declaration, ctx);
      }
      return;
    }

    // export default <expression>
    const value = node.childForFieldName("value");
    if (value) {
      if (FUNCTION_VALUE_TYPES.has(value.type)) {
        const ownName = value.childForFieldName("name")?.text;
        const created = this.createFunctionNode(ownName || "default", node, value, ctx, {
          exported: true,
        });
        analysis.exports.push({ name: created.name, isDefault: true, line });
      } else if (CLASS_TYPES.has(value.type)) {
        const created = this.handleClass(value, ctx, node, true);
        if (created) analysis.exports.push({ name: created.name, isDefault: true, line });
      } else if (value.type === "identifier") {
        analysis.exports.push({ name: value.text, isDefault: true, line });
      } else if (value.type === "object" && this.isNamespaceObject(value)) {
        this.handleNamespaceObject("default", node, value, ctx);
        analysis.exports.push({ name: "default", isDefault: true, line });
      } else {
        // export default memo(Component) / connect(mapState)(Component) ...
        const names = collectIdentifiers(value);
        if (names.length > 0) this.pendingDefaultNames.push({ names, line });
        this.visit(value, ctx);
      }
    }
  }

  /** Point `export default wrap(Thing)` at `Thing` when `Thing` is defined in this file. */
  private resolvePendingDefaults(analysis: FileAnalysis): void {
    if (this.pendingDefaultNames.length === 0) return;
    const known = new Set(
      analysis.nodes.filter((n) => n.type === "function" || n.type === "class").map((n) => n.name)
    );
    for (const pending of this.pendingDefaultNames) {
      const match = pending.names.find((name) => known.has(name));
      if (match) analysis.exports.push({ name: match, isDefault: true, line: pending.line });
    }
    this.pendingDefaultNames = [];
  }

  // ---------------------------------------------------------------------
  // Functions
  // ---------------------------------------------------------------------

  private handleFunctionDeclaration(
    node: SyntaxNode,
    ctx: WalkContext,
    rangeNode: SyntaxNode = node,
    isDefault = false
  ): GraphNode | null {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text || (isDefault ? "default" : "");

    if (ctx.inFunction || !name) {
      // Nested function: roll its calls up into the enclosing scope.
      this.walkFunctionBody(node, ctx);
      return null;
    }

    return this.createFunctionNode(name, rangeNode, node, ctx);
  }

  /**
   * Create a function node spanning `rangeNode` and walk `fnNode`'s body with
   * the new node as the scope.
   */
  private createFunctionNode(
    name: string,
    rangeNode: SyntaxNode,
    fnNode: SyntaxNode,
    ctx: WalkContext,
    extraMetadata: Record<string, unknown> = {},
    type: "function" | "method" = "function",
    parentId: string = ctx.scopeId
  ): GraphNode {
    const funcNode = this.createNode(
      type,
      name,
      ctx.filePath,
      rangeNode.startPosition.row + 1,
      rangeNode.endPosition.row + 1,
      {
        async: fnNode.children.some((c) => c.type === "async"),
        generator:
          fnNode.type.startsWith("generator_function") ||
          fnNode.children.some((c) => c.type === "*"),
        ...extraMetadata,
      }
    );

    ctx.analysis.nodes.push(funcNode);
    ctx.analysis.edges.push(this.createEdge("contains", parentId, funcNode.id));

    this.walkFunctionBody(fnNode, { ...ctx, scopeId: funcNode.id, inFunction: true });
    return funcNode;
  }

  /** Walk parameters (for types and default values) and the body of a function. */
  private walkFunctionBody(fnNode: SyntaxNode, ctx: WalkContext): void {
    const inner: WalkContext = { ...ctx, inFunction: true };
    for (const child of fnNode.namedChildren) {
      if (child.type === "formal_parameters") {
        this.handleParameters(child, inner);
      }
      // `name` is an identifier and has nothing to visit; everything else may hold calls.
      this.visit(child, inner);
    }
  }

  private handleParameters(params: SyntaxNode, ctx: WalkContext): void {
    for (const param of params.namedChildren) {
      if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
      const pattern = param.childForFieldName("pattern");
      if (!pattern || pattern.type !== "identifier") continue;
      const typeName = typeNameFromAnnotation(param.childForFieldName("type"));
      if (!typeName) continue;

      this.addVariableType(ctx, pattern.text, typeName, ctx.scopeId, param);

      // `constructor(private db: Database)` also declares `this.db`.
      const isProperty = param.children.some(
        (c) => c.type === "accessibility_modifier" || c.type === "readonly"
      );
      if (isProperty && ctx.classId) {
        this.addVariableType(ctx, `this.${pattern.text}`, typeName, ctx.classId, param);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Variable declarations
  // ---------------------------------------------------------------------

  private handleDeclarator(declarator: SyntaxNode, statement: SyntaxNode, ctx: WalkContext): void {
    const nameNode = declarator.childForFieldName("name");
    const valueNode = declarator.childForFieldName("value");

    // CommonJS: const x = require("./y") / const { a, b: c } = require("./y")
    if (nameNode && valueNode && this.handleRequire(nameNode, valueNode, statement, ctx)) {
      return;
    }

    if (nameNode?.type === "identifier" && valueNode) {
      const name = nameNode.text;
      const siblings = statement.namedChildren.filter((c) => c.type === "variable_declarator");
      const rangeNode = siblings.length > 1 ? declarator : statement;

      if (!ctx.inFunction) {
        const kind = statement.children[0]?.text || "const";

        if (FUNCTION_VALUE_TYPES.has(valueNode.type)) {
          this.createFunctionNode(name, rangeNode, valueNode, ctx, { kind });
          return;
        }

        if (CLASS_TYPES.has(valueNode.type)) {
          this.handleClass(valueNode, ctx, rangeNode, false, name);
          return;
        }

        if (valueNode.type === "object" && this.isNamespaceObject(valueNode)) {
          this.handleNamespaceObject(name, rangeNode, valueNode, ctx);
          return;
        }

        // const Button = memo(() => ...), const handler = withAuth(async () => ...)
        const wrapped = this.wrappedFunction(valueNode);
        if (wrapped) {
          const funcNode = this.createNode(
            "function",
            name,
            ctx.filePath,
            rangeNode.startPosition.row + 1,
            rangeNode.endPosition.row + 1,
            {
              async: wrapped.children.some((c) => c.type === "async"),
              generator: false,
              kind,
              wrapped: true,
            }
          );
          ctx.analysis.nodes.push(funcNode);
          ctx.analysis.edges.push(this.createEdge("contains", ctx.scopeId, funcNode.id));
          this.visit(valueNode, { ...ctx, scopeId: funcNode.id, inFunction: true });
          return;
        }
      }

      // Plain variable: remember its type when we can tell.
      const typeAnnotation = declarator.childForFieldName("type");
      const typeName = typeNameFromAnnotation(typeAnnotation) || this.inferTypeFromValue(valueNode);
      if (typeName) this.addVariableType(ctx, name, typeName, ctx.scopeId, declarator);
    }

    if (valueNode) this.visit(valueNode, ctx);
  }

  /** `new Foo()` -> "Foo"; `foo()` / `await foo()` -> "@call:foo". */
  private inferTypeFromValue(valueNode: SyntaxNode): string | null {
    let value = valueNode;
    while (
      value.type === "await_expression" ||
      value.type === "parenthesized_expression" ||
      value.type === "as_expression" ||
      value.type === "non_null_expression" ||
      value.type === "satisfies_expression"
    ) {
      const inner = value.namedChildren[0];
      if (!inner) break;
      value = inner;
    }

    if (value.type === "new_expression") {
      const ctor = value.childForFieldName("constructor");
      const name = ctor ? calleeName(ctor) : null;
      return name && !name.startsWith("?") ? name : null;
    }

    if (value.type === "call_expression") {
      const fn = value.childForFieldName("function");
      const name = fn ? calleeName(fn) : null;
      return name && !name.startsWith("?") ? `@call:${name}` : null;
    }

    return null;
  }

  /** The function passed as first argument to a wrapper call, if any. */
  private wrappedFunction(valueNode: SyntaxNode): SyntaxNode | null {
    if (valueNode.type !== "call_expression") return null;
    const fn = valueNode.childForFieldName("function");
    const args = valueNode.childForFieldName("arguments");
    if (!fn || !args) return null;

    const name = calleeName(fn);
    if (!name) return null;
    const last = name.split(".").pop() || "";
    if (NON_WRAPPER_CALLEES.has(last) || last === "require") return null;

    const first = args.namedChildren[0];
    if (!first) return null;
    if (FUNCTION_VALUE_TYPES.has(first.type)) return first;
    // memo(forwardRef((props, ref) => ...))
    if (first.type === "call_expression") return this.wrappedFunction(first);
    return null;
  }

  private handleRequire(
    nameNode: SyntaxNode,
    valueNode: SyntaxNode,
    statement: SyntaxNode,
    ctx: WalkContext
  ): boolean {
    let call = valueNode;
    // const x = require("./y").z  -> treat as named import of z
    let member: string | null = null;
    if (call.type === "member_expression") {
      const object = call.childForFieldName("object");
      const property = call.childForFieldName("property");
      if (!object || !property) return false;
      member = property.text;
      call = object;
    }
    if (call.type !== "call_expression") return false;
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "identifier" || fn.text !== "require") return false;
    const arg = call.childForFieldName("arguments")?.namedChildren[0];
    if (!arg || arg.type !== "string") return false;

    const source = stripQuotes(arg.text);
    const specifiers: string[] = [];
    const aliases: Record<string, string> = {};

    if (nameNode.type === "identifier") {
      specifiers.push(nameNode.text);
      aliases[nameNode.text] = member || "*";
    } else if (nameNode.type === "object_pattern" && !member) {
      for (const prop of nameNode.namedChildren) {
        if (prop.type === "shorthand_property_identifier_pattern") {
          specifiers.push(prop.text);
        } else if (prop.type === "pair_pattern") {
          const key = prop.childForFieldName("key");
          const value = prop.childForFieldName("value");
          if (key && value?.type === "identifier") {
            specifiers.push(value.text);
            if (value.text !== key.text) aliases[value.text] = key.text;
          }
        }
      }
    } else {
      return false;
    }

    ctx.analysis.imports.push({
      source,
      specifiers,
      isDefault: false,
      isNamespace: nameNode.type === "identifier" && !member,
      line: statement.startPosition.row + 1,
      ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    });
    return true;
  }

  // ---------------------------------------------------------------------
  // Namespace objects and CommonJS assignments
  // ---------------------------------------------------------------------

  /** An object literal with at least one function-valued member. */
  private isNamespaceObject(objectNode: SyntaxNode): boolean {
    return objectNode.namedChildren.some((member) => {
      if (member.type === "method_definition") return true;
      if (member.type === "pair") {
        const value = member.childForFieldName("value");
        return !!value && FUNCTION_VALUE_TYPES.has(value.type);
      }
      return false;
    });
  }

  private handleNamespaceObject(
    name: string,
    rangeNode: SyntaxNode,
    objectNode: SyntaxNode,
    ctx: WalkContext
  ): GraphNode {
    const objNode = this.createNode(
      "variable",
      name,
      ctx.filePath,
      rangeNode.startPosition.row + 1,
      rangeNode.endPosition.row + 1,
      { namespaceObject: true }
    );
    ctx.analysis.nodes.push(objNode);
    ctx.analysis.edges.push(this.createEdge("contains", ctx.scopeId, objNode.id));

    const memberCtx: WalkContext = { ...ctx, scopeId: objNode.id };
    for (const member of objectNode.namedChildren) {
      if (member.type === "method_definition") {
        const key = member.childForFieldName("name");
        if (key) {
          this.createFunctionNode(propertyName(key), member, member, memberCtx, {
            memberOf: name,
          });
          continue;
        }
      } else if (member.type === "pair") {
        const key = member.childForFieldName("key");
        const value = member.childForFieldName("value");
        if (key && value && FUNCTION_VALUE_TYPES.has(value.type)) {
          this.createFunctionNode(propertyName(key), member, value, memberCtx, {
            memberOf: name,
          });
          continue;
        }
      }
      // Anything else (plain values, spreads, nested objects): calls belong to the object.
      this.visit(member, { ...memberCtx, inFunction: true });
    }
    return objNode;
  }

  /**
   * Module-level assignments that define functions:
   *   module.exports = function () {} / { ... } / Name
   *   module.exports.foo = () => {}     exports.foo = function () {}
   *   Foo.prototype.bar = function () {}
   * Returns true when the assignment was fully handled.
   */
  private handleAssignment(expr: SyntaxNode, ctx: WalkContext): boolean {
    const left = expr.childForFieldName("left");
    const right = expr.childForFieldName("right");
    if (!left || !right) return false;

    // this.x = new Foo() / this.x = typedParam  (inside methods)
    if (ctx.classId && left.type === "member_expression") {
      const object = left.childForFieldName("object");
      const property = left.childForFieldName("property");
      if (object?.type === "this" && property) {
        const typeName = this.inferTypeFromValue(right);
        if (typeName && !typeName.startsWith("@call:")) {
          this.addVariableType(ctx, `this.${property.text}`, typeName, ctx.classId, expr);
        } else if (right.type === "identifier") {
          const known = ctx.analysis.variableTypes?.find(
            (v) => v.scopeId === ctx.scopeId && v.variableName === right.text
          );
          if (known) {
            this.addVariableType(ctx, `this.${property.text}`, known.typeName, ctx.classId, expr);
          }
        }
      }
      return false; // still walk the right-hand side for calls
    }

    if (ctx.inFunction || left.type !== "member_expression") return false;

    const target = calleeName(left);
    if (!target) return false;
    const line = expr.startPosition.row + 1;
    const statement = expr.parent ?? expr;

    if (target === "module.exports" || target === "exports") {
      if (FUNCTION_VALUE_TYPES.has(right.type)) {
        const ownName = right.childForFieldName("name")?.text;
        const created = this.createFunctionNode(ownName || "default", statement, right, ctx, {
          exported: true,
        });
        ctx.analysis.exports.push({ name: created.name, isDefault: true, line });
        return true;
      }
      if (CLASS_TYPES.has(right.type)) {
        const created = this.handleClass(right, ctx, statement, true);
        if (created) ctx.analysis.exports.push({ name: created.name, isDefault: true, line });
        return true;
      }
      if (right.type === "identifier") {
        ctx.analysis.exports.push({ name: right.text, isDefault: true, line });
        return true;
      }
      if (right.type === "object") {
        for (const member of right.namedChildren) {
          if (member.type === "shorthand_property_identifier") {
            ctx.analysis.exports.push({ name: member.text, isDefault: false, line });
          } else if (member.type === "pair") {
            const key = member.childForFieldName("key");
            const value = member.childForFieldName("value");
            if (key && value?.type === "identifier") {
              const exported = propertyName(key);
              ctx.analysis.exports.push({
                name: exported,
                isDefault: false,
                line,
                ...(exported !== value.text ? { localName: value.text } : {}),
              });
            }
          }
        }
        if (this.isNamespaceObject(right)) {
          const objNode = this.handleNamespaceObject("default", statement, right, ctx);
          ctx.analysis.exports.push({ name: objNode.name, isDefault: true, line });
          // Function members of module.exports are named exports too.
          for (const node of ctx.analysis.nodes) {
            if (node.type === "function" && node.metadata?.memberOf === "default") {
              ctx.analysis.exports.push({ name: node.name, isDefault: false, line: node.startLine });
            }
          }
          return true;
        }
        return false;
      }
      return false;
    }

    // <object>.<name> = function
    const parts = target.split(".");
    if (parts.length < 2 || parts[0] === "?" || parts[0] === "this") return false;
    const memberName = parts[parts.length - 1];
    const owner = parts.slice(0, -1).join(".");

    if (FUNCTION_VALUE_TYPES.has(right.type)) {
      const isCommonJsExport = owner === "module.exports" || owner === "exports";
      const ownerName = owner.endsWith(".prototype") ? owner.slice(0, -".prototype".length) : owner;
      this.createFunctionNode(memberName, statement, right, ctx, {
        ...(isCommonJsExport ? { exported: true } : { memberOf: ownerName }),
      });
      if (isCommonJsExport) {
        ctx.analysis.exports.push({ name: memberName, isDefault: false, line });
      }
      return true;
    }

    if ((owner === "module.exports" || owner === "exports") && right.type === "identifier") {
      ctx.analysis.exports.push({
        name: memberName,
        isDefault: false,
        line,
        ...(memberName !== right.text ? { localName: right.text } : {}),
      });
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------
  // Classes
  // ---------------------------------------------------------------------

  private handleClass(
    node: SyntaxNode,
    ctx: WalkContext,
    rangeNode: SyntaxNode = node,
    isDefault = false,
    assignedName?: string
  ): GraphNode | null {
    const nameNode = node.childForFieldName("name");
    const name = assignedName || nameNode?.text || (isDefault ? "default" : "");

    if (ctx.inFunction || !name) {
      // Class defined inside a function: no nodes, but keep its calls.
      for (const child of node.namedChildren) {
        this.visit(child, { ...ctx, inFunction: true });
      }
      return null;
    }

    // Base classes
    const extends_: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type !== "class_heritage") continue;
      const extendsClause = child.namedChildren.find((c) => c.type === "extends_clause");
      // TypeScript wraps the expression in an extends_clause; JavaScript does not.
      const candidates = extendsClause
        ? [extendsClause.childForFieldName("value") ?? extendsClause.namedChildren[0]]
        : child.namedChildren;
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (candidate.type === "identifier" || candidate.type === "member_expression") {
          const baseName = calleeName(candidate);
          if (baseName && !baseName.startsWith("?")) extends_.push(baseName);
          break;
        }
      }
    }

    const classNode = this.createNode(
      "class",
      name,
      ctx.filePath,
      rangeNode.startPosition.row + 1,
      rangeNode.endPosition.row + 1,
      { extends: extends_ }
    );

    ctx.analysis.nodes.push(classNode);
    ctx.analysis.edges.push(this.createEdge("contains", ctx.scopeId, classNode.id));

    for (const baseClass of extends_) {
      ctx.analysis.edges.push(
        this.createEdge("extends", classNode.id, `ref:${baseClass}`, {
          unresolvedName: baseClass,
        })
      );
    }

    const classCtx: WalkContext = { ...ctx, scopeId: classNode.id, classId: classNode.id };

    for (const child of node.namedChildren) {
      if (child.type === "class_body") {
        for (const member of child.namedChildren) {
          this.handleClassMember(member, classNode, classCtx);
        }
      } else if (child.type === "decorator") {
        this.visit(child, { ...classCtx, inFunction: true });
      }
    }

    return classNode;
  }

  private handleClassMember(member: SyntaxNode, classNode: GraphNode, classCtx: WalkContext): void {
    if (member.type === "method_definition") {
      const nameNode = member.childForFieldName("name");
      if (!nameNode) return;
      this.createFunctionNode(
        propertyName(nameNode),
        member,
        member,
        classCtx,
        {
          static: member.children.some((c) => c.type === "static"),
          parentClass: classNode.name,
        },
        "method",
        classNode.id
      );
      return;
    }

    if (member.type === "public_field_definition" || member.type === "field_definition") {
      const nameNode = member.childForFieldName("name") ?? member.childForFieldName("property");
      const valueNode = member.childForFieldName("value");
      if (!nameNode) return;
      const fieldName = propertyName(nameNode);

      // handler = async () => { ... }
      if (valueNode && FUNCTION_VALUE_TYPES.has(valueNode.type)) {
        this.createFunctionNode(
          fieldName,
          member,
          valueNode,
          classCtx,
          {
            static: member.children.some((c) => c.type === "static"),
            parentClass: classNode.name,
            field: true,
          },
          "method",
          classNode.id
        );
        return;
      }

      const typeName =
        typeNameFromAnnotation(member.childForFieldName("type")) ||
        (valueNode ? this.inferTypeFromValue(valueNode) : null);
      if (typeName && !typeName.startsWith("@call:")) {
        this.addVariableType(classCtx, `this.${fieldName}`, typeName, classNode.id, member);
      }
      if (valueNode) this.visit(valueNode, { ...classCtx, inFunction: true });
      return;
    }

    // Static blocks, decorators, index signatures...
    this.visit(member, { ...classCtx, inFunction: true });
  }

  // ---------------------------------------------------------------------
  // Calls
  // ---------------------------------------------------------------------

  private handleCall(node: SyntaxNode, ctx: WalkContext): void {
    const funcNode = node.childForFieldName("function");
    if (!funcNode) return;

    // Dynamic import() and require() are module loading, not calls.
    if (funcNode.type === "import") return;

    const calledName = calleeName(funcNode);
    if (!calledName || calledName === "require") return;

    this.addCallEdge(ctx, calledName, node);
  }

  private handleNew(node: SyntaxNode, ctx: WalkContext): void {
    const ctor = node.childForFieldName("constructor");
    if (!ctor) return;
    const name = calleeName(ctor);
    if (!name) return;
    this.addCallEdge(ctx, name, node, { kind: "new" });
  }

  /** `<Component />` uses Component: treat it as a call for impact purposes. */
  private handleJsx(node: SyntaxNode, ctx: WalkContext): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const name = calleeName(nameNode);
    if (!name || name.startsWith("?")) return;
    // Lower-case tags are DOM elements (<div>), not components.
    const first = name[0];
    if (first === first.toLowerCase() && !name.includes(".")) return;
    this.addCallEdge(ctx, name, node, { kind: "jsx" });
  }

  private addCallEdge(
    ctx: WalkContext,
    calledName: string,
    node: SyntaxNode,
    extra: Record<string, unknown> = {}
  ): void {
    ctx.analysis.edges.push(
      this.createEdge("calls", ctx.scopeId, `ref:${calledName}`, {
        unresolvedName: calledName,
        line: node.startPosition.row + 1,
        ...extra,
      })
    );
  }

  private addVariableType(
    ctx: WalkContext,
    variableName: string,
    typeName: string,
    scopeId: string,
    node: SyntaxNode
  ): void {
    if (!ctx.analysis.variableTypes) ctx.analysis.variableTypes = [];
    ctx.analysis.variableTypes.push({
      variableName,
      typeName,
      scopeId,
      line: node.startPosition.row + 1,
    });
  }
}

export class JavaScriptParser extends TypeScriptParser {
  language = "javascript";
  extensions = [".js", ".jsx", ".mjs", ".cjs"];

  constructor() {
    super();
    this.parser = new Parser();
    this.parser.setLanguage(JavaScript);
    this.treeSitterParser = this.parser;
  }

  /** The JavaScript grammar handles JSX natively, so one grammar covers every extension. */
  protected selectGrammar(): void {
    this.parser.setLanguage(JavaScript);
  }

  parse(filePath: string, content: string): FileAnalysis {
    const analysis = super.parse(filePath, content);
    analysis.language = "javascript";
    for (const node of analysis.nodes) {
      node.language = "javascript";
    }
    return analysis;
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

/** Name of an object key / class member (`foo`, `"foo"`, `#foo`, `[computed]`). */
function propertyName(node: SyntaxNode): string {
  if (node.type === "string") return stripQuotes(node.text);
  if (node.type === "computed_property_name") {
    const inner = node.namedChildren[0];
    if (inner?.type === "string") return stripQuotes(inner.text);
    return node.text;
  }
  return node.text;
}

/**
 * Dotted name of a callee expression.
 *
 *   foo            -> "foo"
 *   a.b.c          -> "a.b.c"         (optional chaining and `!` are ignored)
 *   this.x.run     -> "this.x.run"
 *   super          -> "super"
 *   getX().run     -> "?.run"         (receiver is not a plain name)
 *
 * Returns null for expressions that have no usable name at all.
 */
export function calleeName(node: SyntaxNode): string | null {
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "property_identifier":
    case "private_property_identifier":
      return node.text;
    case "this":
      return "this";
    case "super":
      return "super";
    case "non_null_expression":
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner ? calleeName(inner) : null;
    }
    case "member_expression":
    case "nested_identifier": {
      const object = node.childForFieldName("object") ?? node.namedChildren[0];
      const property =
        node.childForFieldName("property") ?? node.namedChildren[node.namedChildren.length - 1];
      if (!object || !property || object === property) return null;
      const prop = property.text;
      const receiver = calleeName(object);
      if (!receiver || receiver.startsWith("?")) return `?.${prop}`;
      return `${receiver}.${prop}`;
    }
    default:
      return null;
  }
}

/** Simple type name from a `: Type` annotation (`Foo`, `ns.Foo`, `Foo<T>`, `Foo | null`). */
function typeNameFromAnnotation(annotation: SyntaxNode | null): string | null {
  if (!annotation) return null;
  let node: SyntaxNode | undefined = annotation.namedChildren[0];
  while (node) {
    if (node.type === "type_identifier") return node.text;
    if (node.type === "nested_type_identifier") return node.text;
    if (node.type === "generic_type") {
      const name = node.childForFieldName("name") ?? node.namedChildren[0];
      if (!name) return null;
      // Promise<Foo> / Array<Foo> / Readonly<Foo> wrap the interesting type.
      if (["Promise", "Array", "Readonly", "Partial", "Required"].includes(name.text)) {
        const args: SyntaxNode | null = node.childForFieldName("type_arguments") ?? node.namedChildren[1] ?? null;
        node = args?.namedChildren[0];
        continue;
      }
      return name.text;
    }
    if (node.type === "union_type") {
      // Foo | null | undefined -> Foo
      const members: SyntaxNode[] = node.namedChildren.filter(
        (c) => c.type !== "literal_type" && c.type !== "predefined_type"
      );
      if (members.length !== 1) return null;
      node = members[0];
      continue;
    }
    if (node.type === "parenthesized_type" || node.type === "array_type") {
      node = node.namedChildren[0];
      continue;
    }
    return null;
  }
  return null;
}

/** All identifiers referenced in an expression, outermost first. */
function collectIdentifiers(node: SyntaxNode): string[] {
  const names: string[] = [];
  const walk = (n: SyntaxNode): void => {
    if (n.type === "identifier") names.push(n.text);
    for (const child of n.namedChildren) walk(child);
  };
  walk(node);
  // Innermost arguments are the wrapped thing: memo(forwardRef(Component)).
  return names.reverse();
}
