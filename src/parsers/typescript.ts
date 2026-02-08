/**
 * TypeScript/JavaScript parser using Tree-sitter
 */

import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import { BaseParser } from "./base.js";
import type { FileAnalysis, GraphNode, GraphEdge, ImportInfo, ExportInfo } from "../types.js";

export class TypeScriptParser extends BaseParser {
  language = "typescript";
  extensions = [".ts", ".tsx"];

  private parser: Parser;
  public treeSitterParser: Parser; // Expose for Phase 3

  constructor() {
    super();
    this.parser = new Parser();
    this.parser.setLanguage(TypeScript.typescript);
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

    // Use TSX parser for .tsx files
    if (filePath.endsWith(".tsx")) {
      this.parser.setLanguage(TypeScript.tsx);
    } else {
      this.parser.setLanguage(TypeScript.typescript);
    }

    let tree;
    try {
      tree = this.parser.parse(sourceCode);
    } catch {
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

      case "export_statement":
        this.handleExport(node, filePath, analysis, parentId);
        break;

      case "function_declaration":
      case "arrow_function":
      case "function_expression":
        this.handleFunction(node, filePath, analysis, parentId);
        break;

      case "class_declaration":
        this.handleClass(node, filePath, analysis, parentId);
        break;

      case "method_definition":
        this.handleMethod(node, filePath, analysis, parentId);
        break;

      case "call_expression":
        this.handleCall(node, filePath, analysis, parentId);
        break;

      case "variable_declaration":
        this.handleVariable(node, filePath, analysis, parentId);
        break;
    }

    // Recurse into children
    for (const child of node.children) {
      this.walkTree(child, filePath, analysis, parentId);
    }
  }

  private handleImport(node: Parser.SyntaxNode, analysis: FileAnalysis): void {
    const sourceNode = node.childForFieldName("source");
    if (!sourceNode) return;

    const source = sourceNode.text.replace(/['"]/g, "");
    const specifiers: string[] = [];
    let isDefault = false;
    let isNamespace = false;

    // Find import clause
    for (const child of node.children) {
      if (child.type === "import_clause") {
        for (const clauseChild of child.children) {
          if (clauseChild.type === "identifier") {
            specifiers.push(clauseChild.text);
            isDefault = true;
          } else if (clauseChild.type === "namespace_import") {
            isNamespace = true;
            const nameNode = clauseChild.childForFieldName("name");
            if (nameNode) specifiers.push(nameNode.text);
          } else if (clauseChild.type === "named_imports") {
            for (const importSpec of clauseChild.children) {
              if (importSpec.type === "import_specifier") {
                const name = importSpec.childForFieldName("name");
                if (name) specifiers.push(name.text);
              }
            }
          }
        }
      }
    }

    analysis.imports.push({
      source,
      specifiers,
      isDefault,
      isNamespace,
      line: node.startPosition.row + 1,
    });
  }

  private handleExport(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    const isDefault = node.children.some((c) => c.type === "default");

    // Find what's being exported
    for (const child of node.children) {
      if (child.type === "function_declaration") {
        const nameNode = child.childForFieldName("name");
        if (nameNode) {
          analysis.exports.push({
            name: nameNode.text,
            isDefault,
            line: node.startPosition.row + 1,
          });
        }
        this.handleFunction(child, filePath, analysis, parentId);
      } else if (child.type === "class_declaration") {
        const nameNode = child.childForFieldName("name");
        if (nameNode) {
          analysis.exports.push({
            name: nameNode.text,
            isDefault,
            line: node.startPosition.row + 1,
          });
        }
        this.handleClass(child, filePath, analysis, parentId);
      } else if (child.type === "identifier") {
        analysis.exports.push({
          name: child.text,
          isDefault,
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  private handleFunction(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    let name = "anonymous";
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      name = nameNode.text;
    }

    const funcNode = this.createNode(
      "function",
      name,
      filePath,
      node.startPosition.row + 1,
      node.endPosition.row + 1,
      {
        async: node.children.some((c) => c.type === "async"),
        generator: node.children.some((c) => c.text === "*"),
      }
    );

    analysis.nodes.push(funcNode);

    // Add contains edge from parent
    analysis.edges.push(
      this.createEdge("contains", parentId, funcNode.id)
    );
  }

  private handleClass(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    // Extract extends information
    const extends_: string[] = [];
    for (const child of node.children) {
      if (child.type === "class_heritage") {
        const extendsClause = child.children.find((c) => c.type === "extends_clause");
        if (extendsClause) {
          const baseClass = extendsClause.children.find((c) => c.type === "identifier");
          if (baseClass) {
            extends_.push(baseClass.text);
          }
        }
      }
    }

    const classNode = this.createNode(
      "class",
      nameNode.text,
      filePath,
      node.startPosition.row + 1,
      node.endPosition.row + 1,
      {
        extends: extends_,
      }
    );

    analysis.nodes.push(classNode);

    // Add contains edge
    analysis.edges.push(
      this.createEdge("contains", parentId, classNode.id)
    );

    // Create extends edges for each base class
    for (const baseClass of extends_) {
      analysis.edges.push(
        this.createEdge("extends", classNode.id, `ref:${baseClass}`, {
          unresolvedName: baseClass,
        })
      );
    }

    // Process class body for methods
    const body = node.childForFieldName("body");
    if (body) {
      for (const member of body.children) {
        if (member.type === "method_definition") {
          this.handleMethod(member, filePath, analysis, classNode.id);
        }
      }
    }
  }

  private handleMethod(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    // Find parent class name
    const parentNode = analysis.nodes.find((n) => n.id === parentId);
    const parentClass = parentNode?.type === "class" ? parentNode.name : undefined;

    const methodNode = this.createNode(
      "method",
      nameNode.text,
      filePath,
      node.startPosition.row + 1,
      node.endPosition.row + 1,
      {
        static: node.children.some((c) => c.type === "static"),
        async: node.children.some((c) => c.type === "async"),
        parentClass,
      }
    );

    analysis.nodes.push(methodNode);

    // Add contains edge
    analysis.edges.push(
      this.createEdge("contains", parentId, methodNode.id)
    );
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
    } else if (funcNode.type === "member_expression") {
      // Get the full member expression (e.g., "console.log")
      calledName = funcNode.text;
    }

    if (calledName) {
      analysis.edges.push(
        this.createEdge("calls", parentId, `ref:${calledName}`, {
          unresolvedName: calledName,
          line: node.startPosition.row + 1,
        })
      );
    }
  }

  private handleVariable(
    node: Parser.SyntaxNode,
    filePath: string,
    analysis: FileAnalysis,
    parentId: string
  ): void {
    for (const child of node.children) {
      if (child.type === "variable_declarator") {
        const nameNode = child.childForFieldName("name");
        const valueNode = child.childForFieldName("value");

        if (nameNode && nameNode.type === "identifier") {
          // Check if it's a function expression or arrow function
          if (
            valueNode &&
            (valueNode.type === "arrow_function" ||
              valueNode.type === "function_expression")
          ) {
            const funcNode = this.createNode(
              "function",
              nameNode.text,
              filePath,
              node.startPosition.row + 1,
              node.endPosition.row + 1,
              {
                kind: node.children[0]?.text || "const",
              }
            );
            analysis.nodes.push(funcNode);
            analysis.edges.push(
              this.createEdge("contains", parentId, funcNode.id)
            );
          }
        }
      }
    }
  }
}

export class JavaScriptParser extends TypeScriptParser {
  language = "javascript";
  extensions = [".js", ".jsx", ".mjs", ".cjs"];

  constructor() {
    super();
    // Override to use JavaScript grammar
    (this as any).parser = new Parser();
    (this as any).parser.setLanguage(JavaScript);
    // Update exposed parser reference
    this.treeSitterParser = (this as any).parser;
  }

  parse(filePath: string, content: string): FileAnalysis {
    // Ensure content is a string
    const sourceCode = typeof content === "string" ? content : String(content);

    // Use JSX parser for .jsx files
    if (filePath.endsWith(".jsx")) {
      // JSX needs TSX parser
      (this as any).parser.setLanguage(TypeScript.tsx);
    } else {
      (this as any).parser.setLanguage(JavaScript);
    }

    // Use base implementation but mark as javascript
    const analysis = super.parse(filePath, sourceCode);
    analysis.language = "javascript";
    for (const node of analysis.nodes) {
      node.language = "javascript";
    }
    return analysis;
  }
}
