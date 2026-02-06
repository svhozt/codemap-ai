/**
 * Skill Generator - Creates Claude Code skills based on codebase analysis
 */

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { GraphStorage } from "../graph/storage.js";
import type { GeneratedSkill, SkillConfig } from "../types.js";

export class SkillGenerator {
  private storage: GraphStorage;
  private config: SkillConfig;

  constructor(storage: GraphStorage, config: SkillConfig) {
    this.storage = storage;
    this.config = config;
  }

  /**
   * Generate all skills and write to .claude/skills/
   */
  generateAll(): GeneratedSkill[] {
    const skills: GeneratedSkill[] = [];

    // 1. Architecture overview skill
    if (this.config.includeArchitecture) {
      skills.push(this.generateArchitectureSkill());
    }

    // 2. Codebase patterns skill
    if (this.config.includePatterns) {
      skills.push(this.generatePatternsSkill());
    }

    // 3. Dependency explorer skill
    if (this.config.includeDependencies) {
      skills.push(this.generateDependencySkill());
    }

    // 4. Impact analysis skill (always generate)
    skills.push(this.generateImpactAnalysisSkill());

    // 5. Code navigation skill (always generate)
    skills.push(this.generateNavigationSkill());

    // Write all skills to disk
    this.writeSkills(skills);

    return skills;
  }

  private generateArchitectureSkill(): GeneratedSkill {
    const stats = this.storage.getStats();
    const rootPath = this.storage.getMeta("rootPath") || "";

    // Get file structure by analyzing paths
    const allNodes = this.storage.getNodesByType("file");
    const directories = new Map<string, number>();

    for (const node of allNodes) {
      const relativePath = node.filePath.replace(rootPath, "").replace(/^\//, "");
      const parts = relativePath.split("/");
      if (parts.length > 1) {
        const topDir = parts[0];
        directories.set(topDir, (directories.get(topDir) || 0) + 1);
      }
    }

    // Sort directories by file count
    const sortedDirs = [...directories.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const dirList = sortedDirs
      .map(([dir, count]) => `- \`${dir}/\` (${count} files)`)
      .join("\n");

    const langList = Object.entries(stats.languages)
      .map(([lang, count]) => `- ${lang}: ${count} files`)
      .join("\n");

    const content = `---
name: architecture
description: Overview of ${this.config.projectName} architecture and structure
user-invocable: true
---

# ${this.config.projectName} Architecture

## Project Statistics
- **Total files**: ${stats.totalFiles}
- **Functions/Methods**: ${stats.nodesByType.function || 0} functions, ${stats.nodesByType.method || 0} methods
- **Classes**: ${stats.nodesByType.class || 0}
- **Import relationships**: ${stats.edgesByType.imports || 0}
- **Call relationships**: ${stats.edgesByType.calls || 0}

## Languages
${langList}

## Directory Structure
${dirList}

## Key Patterns
When working with this codebase:
1. Check the main directories above for feature organization
2. Use the \`/impact\` skill to understand changes
3. Use the \`/navigate\` skill to find specific code

## Getting Started
To understand a specific area, ask questions like:
- "What does the ${sortedDirs[0]?.[0] || "src"} directory contain?"
- "How is authentication handled?"
- "What are the main entry points?"
`;

    return {
      name: "architecture",
      description: `Overview of ${this.config.projectName} architecture`,
      content,
      filePath: join(this.config.outputDir, "architecture", "SKILL.md"),
    };
  }

  private generatePatternsSkill(): GeneratedSkill {
    const stats = this.storage.getStats();

    // Analyze common patterns from the graph
    const classes = this.storage.getNodesByType("class");
    const functions = this.storage.getNodesByType("function");

    // Find classes with many methods (likely important)
    const classDetails = classes.map((cls) => {
      const methods = this.storage.getEdgesFrom(cls.id).filter((e) => e.type === "contains");
      return { ...cls, methodCount: methods.length };
    }).sort((a, b) => b.methodCount - a.methodCount);

    const topClasses = classDetails.slice(0, 5);
    const classList = topClasses
      .map((c) => `- \`${c.name}\` (${c.methodCount} methods) - [${basename(c.filePath)}](${c.filePath}#L${c.startLine})`)
      .join("\n");

    // Find most-called functions
    const callEdges = this.storage.getEdgesByType("calls");
    const callCounts = new Map<string, number>();
    for (const edge of callEdges) {
      const target = edge.targetId.replace("ref:", "");
      callCounts.set(target, (callCounts.get(target) || 0) + 1);
    }

    const mostCalled = [...callCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const calledList = mostCalled
      .map(([name, count]) => `- \`${name}\` (called ${count} times)`)
      .join("\n");

    const content = `---
name: patterns
description: Common patterns and conventions in ${this.config.projectName}
---

# Codebase Patterns

## Key Classes
These are the most substantial classes in the codebase:
${classList || "No classes found"}

## Most Used Functions
These functions are called most frequently:
${calledList || "No call data available"}

## Conventions Detected

### File Organization
${stats.nodesByType.file ? `- ${stats.totalFiles} files organized across the project` : ""}
${stats.languages.typescript ? "- TypeScript is used for type safety" : ""}
${stats.languages.python ? "- Python follows standard module patterns" : ""}

### Code Structure
- Functions: ${stats.nodesByType.function || 0}
- Classes: ${stats.nodesByType.class || 0}
- Methods: ${stats.nodesByType.method || 0}

## When Making Changes
1. Follow existing naming conventions
2. Check similar files for patterns
3. Use \`/impact\` to verify affected areas
`;

    return {
      name: "patterns",
      description: `Common patterns in ${this.config.projectName}`,
      content,
      filePath: join(this.config.outputDir, "patterns", "SKILL.md"),
    };
  }

  private generateDependencySkill(): GeneratedSkill {
    const content = `---
name: dependencies
description: Explore dependencies and imports in ${this.config.projectName}
context: fork
agent: Explore
---

# Dependency Explorer

When analyzing dependencies for $ARGUMENTS:

## Steps
1. **Find the target file/module**
   - Search for files matching the query
   - Identify the main module or component

2. **Analyze imports**
   - What does this file import?
   - Are there circular dependencies?

3. **Analyze dependents**
   - What files import this module?
   - How deep is the dependency chain?

4. **Provide summary**
   - List direct dependencies
   - List files that depend on this
   - Highlight any concerns (circular deps, too many dependents)

## Query the CodeMap database
If the codemap MCP server is available, use these queries:
- Get imports: Query the imports table for the file
- Get dependents: Find files that import this module
- Get call graph: Find functions that call into this module

## Output Format
\`\`\`
Dependencies for [target]:

IMPORTS (what this uses):
- module1 (from ./path)
- module2 (from package)

IMPORTED BY (what uses this):
- file1.ts (lines X-Y)
- file2.ts (lines X-Y)

DEPENDENCY DEPTH: N levels
\`\`\`
`;

    return {
      name: "dependencies",
      description: `Explore dependencies in ${this.config.projectName}`,
      content,
      filePath: join(this.config.outputDir, "dependencies", "SKILL.md"),
    };
  }

  private generateImpactAnalysisSkill(): GeneratedSkill {
    const content = `---
name: impact
description: Analyze the impact of changes to a file or function
disable-model-invocation: true
---

# Impact Analysis

Analyze what would be affected by changes to $ARGUMENTS.

## Analysis Steps

1. **Identify the target**
   - Find the file, function, or class being modified
   - Note its current state and purpose

2. **Find direct dependents**
   - What files import this module?
   - What functions call this function?
   - What classes extend this class?

3. **Find indirect dependents**
   - Follow the chain: if A depends on B, and B is our target, A is affected
   - Go up to 3 levels deep

4. **Categorize impact**
   - **Breaking changes**: Signature changes, removed exports
   - **Behavioral changes**: Logic changes that may affect callers
   - **Safe changes**: Internal refactors, added functionality

5. **Generate checklist**

## Output Format

\`\`\`markdown
# Impact Analysis: [target]

## Direct Impact
- [ ] file1.ts - uses [specific function/import]
- [ ] file2.ts - extends [class]

## Indirect Impact
- [ ] file3.ts - imports file1.ts which uses [target]

## Recommended Actions
1. Update tests in [test files]
2. Check [specific callers] for compatibility
3. Update documentation in [docs]

## Risk Level: [LOW/MEDIUM/HIGH]
[Explanation of risk assessment]
\`\`\`
`;

    return {
      name: "impact",
      description: "Analyze impact of code changes",
      content,
      filePath: join(this.config.outputDir, "impact", "SKILL.md"),
    };
  }

  private generateNavigationSkill(): GeneratedSkill {
    const stats = this.storage.getStats();

    const content = `---
name: navigate
description: Navigate to specific code in ${this.config.projectName}
---

# Code Navigation

Find and navigate to code matching $ARGUMENTS.

## Available Queries

### By Type
- "find class [name]" - Locate a class definition
- "find function [name]" - Locate a function
- "find file [pattern]" - Find files matching pattern
- "find imports of [module]" - Find all imports of a module

### By Relationship
- "callers of [function]" - Who calls this function?
- "callees of [function]" - What does this function call?
- "subclasses of [class]" - Classes that extend this
- "implementers of [interface]" - Classes implementing interface

### By Location
- "in [directory]" - Filter to specific directory
- "in [file]" - Show contents of file

## Codebase Stats
- ${stats.totalFiles} files to search
- ${stats.nodesByType.function || 0} functions
- ${stats.nodesByType.class || 0} classes
- ${stats.nodesByType.method || 0} methods

## Output Format
For each match, provide:
- File path with line number link
- Brief description of what it does
- Related code (callers/callees if relevant)
`;

    return {
      name: "navigate",
      description: `Navigate ${this.config.projectName} codebase`,
      content,
      filePath: join(this.config.outputDir, "navigate", "SKILL.md"),
    };
  }

  private writeSkills(skills: GeneratedSkill[]): void {
    for (const skill of skills) {
      const dir = dirname(skill.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(skill.filePath, skill.content, "utf-8");
    }
  }
}
