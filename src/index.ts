/**
 * CodeMap - Call graph analyzer
 *
 * Main entry point for programmatic usage
 */

// Re-export flow module
export * from "./flow/index.js";
export * from "./types.js";
export { parserRegistry, type Parser, type LanguageParser } from "./parsers/base.js";
export { analyzeImpact, type ImpactResult, type ImpactOptions, type RiskLevel } from "./commands/impact.js";
export { VERSION } from "./version.js";

// Register parsers
import "./parsers/index.js";
