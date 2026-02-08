/**
 * Git utilities for detecting changes
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export interface GitChangedFile {
  path: string;
  status: "modified" | "added" | "deleted";
}

export interface GitChangedFunction {
  file: string;
  functionName: string;
  lineNumber: number;
  changeType: "added" | "modified" | "deleted";
}

/**
 * Check if directory is a git repository
 */
export function isGitRepository(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * Get list of changed files from git diff
 */
export function getGitChangedFiles(rootPath: string): GitChangedFile[] {
  try {
    // Get changed files (both staged and unstaged)
    const output = execSync("git diff HEAD --name-status", {
      cwd: rootPath,
      encoding: "utf-8",
    }).trim();

    if (!output) {
      return [];
    }

    const files: GitChangedFile[] = [];
    for (const line of output.split("\n")) {
      const [status, path] = line.split("\t");
      if (path) {
        files.push({
          path,
          status: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
        });
      }
    }

    return files;
  } catch (error) {
    return [];
  }
}

/**
 * Parse git diff to find changed functions
 */
export function parseGitDiffForFunctions(rootPath: string, files: GitChangedFile[]): GitChangedFunction[] {
  const changedFunctions: GitChangedFunction[] = [];

  for (const file of files) {
    if (file.status === "deleted") {
      continue;
    }

    try {
      // Get detailed diff for this file
      const diff = execSync(`git diff HEAD -- "${file.path}"`, {
        cwd: rootPath,
        encoding: "utf-8",
      });

      // Parse diff to find function definitions
      const lines = diff.split("\n");
      let currentFunction: string | null = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Look for hunk headers with function context
        // @@ -47,6 +48,8 @@ def handle_checkout():
        // @@ -120,1 +121,1 @@ async def authenticate_user(token: str):
        if (line.startsWith("@@")) {
          const contextMatch = line.match(/@@.*@@\s*(.*)/);
          if (contextMatch) {
            const context = contextMatch[1];

            // Python: def/async def
            const pythonMatch = context.match(/(?:async\s+)?def\s+(\w+)/);
            if (pythonMatch) {
              currentFunction = pythonMatch[1];
            }

            // TypeScript/JavaScript: function/const/class
            const jsMatch = context.match(/(?:function|const|class)\s+(\w+)/);
            if (jsMatch) {
              currentFunction = jsMatch[1];
            }

            // Extract line number
            const lineMatch = line.match(/\+(\d+)/);
            const lineNumber = lineMatch ? parseInt(lineMatch[1]) : 0;

            if (currentFunction) {
              changedFunctions.push({
                file: file.path,
                functionName: currentFunction,
                lineNumber,
                changeType: file.status === "added" ? "added" : "modified",
              });
            }
          }
        }
      }
    } catch (error) {
      // Skip files with diff errors
      continue;
    }
  }

  return changedFunctions;
}

/**
 * Get uncommitted changes summary
 */
export function getGitStatus(rootPath: string): {
  hasChanges: boolean;
  modifiedFiles: number;
  stagedFiles: number;
} {
  try {
    const statusOutput = execSync("git status --porcelain", {
      cwd: rootPath,
      encoding: "utf-8",
    }).trim();

    const lines = statusOutput.split("\n").filter((l) => l.trim());
    const staged = lines.filter((l) => l[0] !== " " && l[0] !== "?").length;
    const modified = lines.length;

    return {
      hasChanges: modified > 0,
      modifiedFiles: modified,
      stagedFiles: staged,
    };
  } catch (error) {
    return {
      hasChanges: false,
      modifiedFiles: 0,
      stagedFiles: 0,
    };
  }
}
