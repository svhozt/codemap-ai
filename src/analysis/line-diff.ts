/**
 * Line-Level Diff Parser
 * Parses git diff to extract exact removed/added lines with function context
 */

import { execSync } from "child_process";

export interface RemovedLine {
  file: string;
  lineNumber: number;
  content: string;
  inFunction?: string;  // Which function this line was in
}

export interface AddedLine {
  file: string;
  lineNumber: number;
  content: string;
  inFunction?: string;
}

export interface ModifiedLine {
  before: RemovedLine;
  after: AddedLine;
}

export interface LineLevelDiff {
  removedLines: RemovedLine[];
  addedLines: AddedLine[];
  modifiedLines: ModifiedLine[];
}

/**
 * Parse git diff to extract exact line changes
 */
export function parseLineLevelDiff(projectRoot: string): LineLevelDiff {
  try {
    // Get unified diff from git
    const diffOutput = execSync('git diff HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,  // 10MB buffer
    });

    if (!diffOutput.trim()) {
      // No changes
      return {
        removedLines: [],
        addedLines: [],
        modifiedLines: [],
      };
    }

    return parseDiffOutput(diffOutput);
  } catch (error) {
    // Git not available or no changes
    return {
      removedLines: [],
      addedLines: [],
      modifiedLines: [],
    };
  }
}

/**
 * Parse diff output into structured format
 */
function parseDiffOutput(diffOutput: string): LineLevelDiff {
  const removedLines: RemovedLine[] = [];
  const addedLines: AddedLine[] = [];

  let currentFile = '';
  let currentFunction = '';
  let removedLineNumber = 0;
  let addedLineNumber = 0;

  const lines = diffOutput.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track current file: diff --git a/file.js b/file.js
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.*?)$/);
      if (match) {
        currentFile = match[1].trim();
      }
      continue;
    }

    // Track line numbers and function context: @@ -42,7 +42,6 @@ function authenticate(user)
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@(.*)/);
      if (match) {
        removedLineNumber = parseInt(match[1]);
        addedLineNumber = parseInt(match[2]);

        // Extract function name from context (if available)
        const context = match[3].trim();
        if (context) {
          currentFunction = extractFunctionName(context);
        }
      }
      continue;
    }

    // Skip file headers
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) {
      continue;
    }

    // Extract removed lines (-)
    if (line.startsWith('-') && !line.startsWith('---')) {
      const content = line.substring(1);  // Remove '-' prefix

      // Skip empty lines and lines that are just whitespace
      if (content.trim()) {
        removedLines.push({
          file: currentFile,
          lineNumber: removedLineNumber,
          content,
          inFunction: currentFunction || undefined,
        });
      }

      removedLineNumber++;
      continue;
    }

    // Extract added lines (+)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.substring(1);  // Remove '+' prefix

      // Skip empty lines and lines that are just whitespace
      if (content.trim()) {
        addedLines.push({
          file: currentFile,
          lineNumber: addedLineNumber,
          content,
          inFunction: currentFunction || undefined,
        });
      }

      addedLineNumber++;
      continue;
    }

    // Context line (no change)
    if (line.startsWith(' ') || !line.startsWith('-') && !line.startsWith('+')) {
      removedLineNumber++;
      addedLineNumber++;
    }
  }

  // Match modified lines (line changed, not just removed/added)
  const modifiedLines = matchModifiedLines(removedLines, addedLines);

  return {
    removedLines,
    addedLines,
    modifiedLines,
  };
}

/**
 * Extract function name from git diff context header
 */
function extractFunctionName(context: string): string {
  // Remove common prefixes
  context = context.replace(/^(function|def|class|const|let|var|async|export)\s+/, '');

  // Match patterns:
  // - "function authenticate(user)" → "authenticate"
  // - "def validate_token(token):" → "validate_token"
  // - "class UserHandler {" → "UserHandler"
  // - "const handleRequest = " → "handleRequest"
  // - "authenticate(user) {" → "authenticate"

  const patterns = [
    /^(\w+)\s*\(/,              // functionName(
    /^(\w+)\s*=/,               // functionName =
    /^(\w+)\s*{/,               // ClassName {
    /^(\w+)\s*:/,               // functionName:
  ];

  for (const pattern of patterns) {
    const match = context.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // Fallback: return first word
  const firstWord = context.split(/\s+/)[0];
  return firstWord || '';
}

/**
 * Match removed and added lines that are modifications of the same line
 */
function matchModifiedLines(
  removedLines: RemovedLine[],
  addedLines: AddedLine[]
): ModifiedLine[] {
  const modifiedLines: ModifiedLine[] = [];

  // Group by file and function
  const removedByLocation = new Map<string, RemovedLine[]>();
  const addedByLocation = new Map<string, AddedLine[]>();

  for (const removed of removedLines) {
    const key = `${removed.file}:${removed.inFunction || 'global'}`;
    if (!removedByLocation.has(key)) {
      removedByLocation.set(key, []);
    }
    removedByLocation.get(key)!.push(removed);
  }

  for (const added of addedLines) {
    const key = `${added.file}:${added.inFunction || 'global'}`;
    if (!addedByLocation.has(key)) {
      addedByLocation.set(key, []);
    }
    addedByLocation.get(key)!.push(added);
  }

  // Match lines in the same location (same file, same function, similar line numbers)
  for (const [location, removedLinesInLocation] of removedByLocation) {
    const addedLinesInLocation = addedByLocation.get(location) || [];

    for (const removed of removedLinesInLocation) {
      // Find added line within ±2 lines
      const matchingAdded = addedLinesInLocation.find(
        added => Math.abs(added.lineNumber - removed.lineNumber) <= 2
      );

      if (matchingAdded) {
        modifiedLines.push({
          before: removed,
          after: matchingAdded,
        });
      }
    }
  }

  return modifiedLines;
}
