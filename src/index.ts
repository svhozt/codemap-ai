/**
 * CodeMap Flow Edition - Call graph analyzer
 *
 * Main entry point for programmatic usage
 */

// Re-export flow module
export * from "./flow/index.js";
export * from "./types.js";

// Register parsers
import "./parsers/index.js";
