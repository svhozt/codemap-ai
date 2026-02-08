/**
 * Parser registry and exports
 */

export { BaseParser, ParserRegistry, parserRegistry } from "./base.js";
export { TypeScriptParser, JavaScriptParser } from "./typescript.js";
export { PythonParser } from "./python.js";

import { parserRegistry } from "./base.js";
import { TypeScriptParser, JavaScriptParser } from "./typescript.js";
import { PythonParser } from "./python.js";

// Register all parsers
export function registerAllParsers(): void {
  parserRegistry.register(new TypeScriptParser());
  parserRegistry.register(new JavaScriptParser());
  parserRegistry.register(new PythonParser());
}

// Auto-register on import
registerAllParsers();
