/**
 * Git utilities for detecting changes
 *
 * Every git invocation passes its arguments as an array (no shell), so file
 * names can never be interpreted as shell syntax.
 */

import { execFileSync } from "child_process";

export interface GitChangedFile {
  /** Path relative to the directory the command was run in. */
  path: string;
  status: "modified" | "added" | "deleted";
}

export interface GitChangedFunction {
  file: string;
  /** Display name: `name` for functions, `Class.name` for methods. */
  functionName: string;
  lineNumber: number;
  changeType: "added" | "modified" | "deleted";
  /** Id of the function's node in the index, when it has one. */
  nodeId?: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;

/** Run git in `cwd`; returns stdout, or null when the command fails. */
export function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Check if directory is inside a git work tree (the repository root or any
 * directory below it).
 */
export function isGitRepository(path: string): boolean {
  return runGit(path, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/** True when the repository has at least one commit to compare against. */
export function hasGitHead(path: string): boolean {
  return runGit(path, ["rev-parse", "--verify", "--quiet", "HEAD"]) !== null;
}

/**
 * Files that differ from HEAD (staged or not) plus untracked files that are
 * not ignored. Paths are relative to `rootPath`; files outside it are not
 * reported. A rename shows up as a deletion plus an addition.
 */
export function getGitChangedFiles(rootPath: string): GitChangedFile[] {
  const files = new Map<string, GitChangedFile>();

  const diff = runGit(rootPath, [
    "diff",
    "HEAD",
    "--name-status",
    "--no-renames",
    "--relative",
    "-z",
  ]);
  if (diff) {
    // -z output: STATUS \0 PATH \0 STATUS \0 PATH \0 ...
    const fields = diff.split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i];
      const path = fields[i + 1];
      if (!path) continue;
      files.set(path, {
        path,
        status: status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified",
      });
    }
  }

  const untracked = runGit(rootPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked) {
    for (const path of untracked.split("\0")) {
      if (path && !files.has(path)) files.set(path, { path, status: "added" });
    }
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Content of `relativePath` (relative to `rootPath`) as committed in HEAD, or
 * null when the file does not exist there.
 */
export function getGitHeadContent(rootPath: string, relativePath: string): string | null {
  return runGit(rootPath, ["show", `HEAD:./${relativePath.replace(/\\/g, "/")}`]);
}
