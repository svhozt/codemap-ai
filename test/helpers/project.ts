/**
 * Helpers that build throwaway projects on disk for tests.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
import { FlowBuilder, FlowStorage } from "../../src/flow/index.js";
import { DEFAULT_CONFIG } from "../../src/types.js";
import "../../src/parsers/index.js";

export interface TestProject {
  root: string;
  /** Absolute, forward-slash path of a project file. */
  path(relativePath: string): string;
  write(relativePath: string, content: string): void;
  remove(relativePath: string): void;
  git(...args: string[]): string;
  /** Build (or update) the index and return the build result. */
  index(options?: { force?: boolean; include?: string[]; exclude?: string[] }): ReturnType<FlowBuilder["build"]>;
  /** Open the index (caller closes it). */
  open(): FlowStorage;
  cleanup(): void;
}

export function createProject(files: Record<string, string> = {}): TestProject {
  // realpath: on macOS the temp dir is a symlink (/var -> /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codemap-test-"))).replace(/\\/g, "/");

  const project: TestProject = {
    root,
    path: (relativePath) => `${root}/${relativePath}`,
    write(relativePath, content) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    remove(relativePath) {
      rmSync(join(root, relativePath), { force: true, recursive: true });
    },
    git(...args) {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          GIT_CONFIG_NOSYSTEM: "1",
          HOME: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    async index(options = {}) {
      mkdirSync(join(root, ".codemap"), { recursive: true });
      const storage = project.open();
      try {
        const builder = new FlowBuilder(storage, {
          rootPath: root,
          include: options.include ?? DEFAULT_CONFIG.include!,
          exclude: options.exclude ?? DEFAULT_CONFIG.exclude!,
          forceReindex: options.force ?? false,
        });
        return await builder.build();
      } finally {
        storage.close();
      }
    },
    open() {
      mkdirSync(join(root, ".codemap"), { recursive: true });
      return new FlowStorage(join(root, ".codemap", "graph.db"));
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };

  for (const [file, content] of Object.entries(files)) project.write(file, content);
  return project;
}

/** Initialise a git repository with everything committed. */
export function commitAll(project: TestProject, message = "initial"): void {
  try {
    project.git("rev-parse", "--git-dir");
  } catch {
    project.git("init", "-q", "-b", "main");
  }
  project.write(".gitignore", ".codemap/\n");
  project.git("add", "-A");
  project.git("commit", "-q", "-m", message);
}

/** Resolved call edges as "caller -> callee" using node names, sorted. */
export function callPairs(storage: FlowStorage): string[] {
  const rows = storage.db
    .prepare(
      `SELECT s.name AS source, t.name AS target
       FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
       WHERE e.type = 'calls'`
    )
    .all() as Array<{ source: string; target: string }>;
  return [...new Set(rows.map((r) => `${r.source} -> ${r.target}`))].sort();
}

/** Unresolved call references of a node name. */
export function unresolvedFrom(storage: FlowStorage, sourceName: string): string[] {
  const rows = storage.db
    .prepare(
      `SELECT e.target_id AS target FROM edges e JOIN nodes s ON s.id = e.source_id
       WHERE e.type = 'calls' AND e.target_id LIKE 'ref:%' AND s.name = ?`
    )
    .all(sourceName) as Array<{ target: string }>;
  return rows.map((r) => r.target.slice(4)).sort();
}
