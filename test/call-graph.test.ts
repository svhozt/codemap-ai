import { afterEach, describe, expect, it } from "vitest";
import { callPairs, createProject, unresolvedFrom, type TestProject } from "./helpers/project.js";

let project: TestProject;
afterEach(() => project?.cleanup());

describe("call graph: Python", () => {
  it("resolves imports, aliases, relative imports and packages", async () => {
    project = createProject({
      "app/__init__.py": "",
      "app/core/__init__.py": "from .security import hash_password\n",
      "app/core/security.py": "def hash_password(p):\n    return p\n\ndef check(p):\n    return hash_password(p)\n",
      "app/services/users.py": `from app.core import hash_password
from app.core.security import check as verify
from ..core import security
import app.core.security


def create(p):
    hash_password(p)
    verify(p)
    security.check(p)
    app.core.security.hash_password(p)
`,
    });
    await project.index();
    const storage = project.open();
    try {
      expect(callPairs(storage)).toEqual(["check -> hash_password", "create -> check", "create -> hash_password"]);
      expect(unresolvedFrom(storage, "create")).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it("resolves self, super, typed parameters and attributes through the class hierarchy", async () => {
    project = createProject({
      "repo.py": `class Repo:
    def save(self, x):
        return x
`,
      "service.py": `from repo import Repo


class Base:
    def audit(self):
        pass

    def log(self):
        pass


class Service(Base):
    def __init__(self, repo: Repo):
        self.repo = repo

    def log(self):
        super().log()

    def run(self, other: Repo):
        self.audit()
        self.log()
        self.repo.save(1)
        other.save(2)
        local = Repo()
        local.save(3)
`,
    });
    await project.index();
    const storage = project.open();
    try {
      const pairs = callPairs(storage);
      expect(pairs).toEqual(
        expect.arrayContaining(["run -> audit", "run -> log", "run -> save", "run -> Repo", "log -> log"])
      );
      // self.log() is Service.log, not Base.log
      const target = storage.db
        .prepare(
          `SELECT t.start_line AS line FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
           WHERE s.name = 'run' AND t.name = 'log'`
        )
        .get() as { line: number };
      expect(target.line).toBe(16);
      expect(unresolvedFrom(storage, "run")).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it("does not guess between functions with the same name", async () => {
    project = createProject({
      "a.py": "def helper():\n    pass\n",
      "b.py": "def helper():\n    pass\n",
      "c.py": "def main():\n    helper()\n    obj.get()\n",
      "d.py": "class X:\n    def get(self):\n        pass\n",
    });
    await project.index();
    const storage = project.open();
    try {
      expect(callPairs(storage)).toEqual([]);
      expect(unresolvedFrom(storage, "main")).toEqual(["helper", "obj.get"]);
    } finally {
      storage.close();
    }
  });

  it("never resolves Python calls to JavaScript functions or the other way round", async () => {
    project = createProject({
      "server.py": "def handle():\n    render_page()\n",
      "web/render.js": "export function render_page() { handle(); }\n",
    });
    await project.index();
    const storage = project.open();
    try {
      expect(callPairs(storage)).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it("resolves FastAPI Depends to a call edge and records the endpoint", async () => {
    project = createProject({
      "deps.py": "def get_user():\n    return 1\n",
      "routes.py": `from fastapi import APIRouter, Depends
from deps import get_user

router = APIRouter()


@router.get("/me")
def me(user=Depends(get_user)):
    return user
`,
    });
    await project.index();
    const storage = project.open();
    try {
      expect(callPairs(storage)).toContain("me -> get_user");
      const stats = storage.getStats();
      expect(stats.httpEndpoints).toBe(1);
      expect(stats.resolvedDependencies).toBe(1);
    } finally {
      storage.close();
    }
  });
});

describe("call graph: TypeScript / JavaScript", () => {
  it("resolves ESM imports, aliases, default exports, barrels and namespaces", async () => {
    project = createProject({
      "src/lib/math.ts": "export function add(a: number, b: number) { return a + b; }\nexport default function mul() { return 1; }\n",
      "src/lib/index.ts": 'export * from "./math";\nexport { default as multiply } from "./math";\n',
      "src/app.ts": `import mulDefault, { add as plus } from "./lib/math.js";
import { add, multiply } from "./lib";
import * as M from "./lib/math";

export function run() {
  plus(1, 2);
  add(1, 2);
  multiply();
  mulDefault();
  M.add(3, 4);
}
`,
    });
    await project.index();
    const storage = project.open();
    try {
      expect(callPairs(storage)).toEqual(["run -> add", "run -> mul"]);
      expect(unresolvedFrom(storage, "run")).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it("resolves tsconfig path aliases", async () => {
    project = createProject({
      "tsconfig.json": `{
  // comments are allowed
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } },
}`,
      "src/utils/format.ts": "export const format = (s: string) => s.trim();\n",
      "src/main.ts": 'import { format } from "@/utils/format";\nexport function main() { return format(" x "); }\n',
    });
    await project.index();
    const storage = project.open();
    try {
      expect(callPairs(storage)).toEqual(["main -> format"]);
    } finally {
      storage.close();
    }
  });

  it("resolves this, super, typed variables, class fields and new expressions", async () => {
    project = createProject({
      "db.ts": "export class Db { query() { return 1; } }\n",
      "svc.ts": `import { Db } from "./db";

class Base {
  constructor() {}
  greet() {}
}

export class Service extends Base {
  private cache = new Map();
  constructor(private db: Db) { super(); }
  greet() { super.greet(); this.helper(); }
  helper() { return this.db.query(); }
  run(other: Db) { other.query(); const d = new Db(); d.query(); }
}
`,
    });
    await project.index();
    const storage = project.open();
    try {
      expect(callPairs(storage)).toEqual(
        expect.arrayContaining([
          "constructor -> constructor",
          "greet -> greet",
          "greet -> helper",
          "helper -> query",
          "run -> query",
          "run -> Db",
        ])
      );
      expect(unresolvedFrom(storage, "helper")).toEqual([]);
      expect(unresolvedFrom(storage, "run")).toEqual([]);
    } finally {
      storage.close();
    }
  });

  it("resolves CommonJS require and module.exports", async () => {
    project = createProject({
      "lib/greet.js": "function greet(n) { return 'hi ' + n; }\nmodule.exports = { greet };\n",
      "lib/default.js": "module.exports = function main() { return 1; };\n",
      "index.js": `const { greet } = require("./lib/greet");
const g = require("./lib/greet");
const main = require("./lib/default");
function start() { greet("a"); g.greet("b"); main(); }
start();
`,
    });
    await project.index();
    const storage = project.open();
    try {
      expect(callPairs(storage)).toEqual(["index.js -> start", "start -> greet", "start -> main"]);
    } finally {
      storage.close();
    }
  });

  it("leaves calls into packages unresolved", async () => {
    project = createProject({
      "a.ts": 'import express from "express";\nimport { readFileSync } from "fs";\nexport function f() { express(); readFileSync("x"); }\n',
      "b.ts": "export function readFileSync() {}\nexport default function express() {}\n",
    });
    await project.index();
    const storage = project.open();
    try {
      expect(callPairs(storage)).toEqual([]);
    } finally {
      storage.close();
    }
  });
});

describe("incremental indexing", () => {
  it("re-parses only changed files and keeps cross-file edges correct", async () => {
    project = createProject({
      "lib.py": "def helper():\n    pass\n",
      "main.py": "from lib import helper\n\ndef main():\n    helper()\n",
    });
    const first = await project.index();
    expect(first.indexed).toBe(2);

    const second = await project.index();
    expect(second).toMatchObject({ indexed: 0, skipped: 2 });

    // Move helper down: its node id changes; main's edge must follow it.
    project.write("lib.py", "\n\n\ndef helper():\n    pass\n");
    const third = await project.index();
    expect(third).toMatchObject({ indexed: 1, skipped: 1 });

    const storage = project.open();
    try {
      expect(callPairs(storage)).toEqual(["main -> helper"]);
      const dangling = storage.db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e LEFT JOIN nodes n ON n.id = e.target_id
           WHERE e.target_id NOT LIKE 'ref:%' AND n.id IS NULL`
        )
        .get() as { c: number };
      expect(dangling.c).toBe(0);
    } finally {
      storage.close();
    }
  });

  it("removes deleted files and does not accumulate rows", async () => {
    project = createProject({
      "a.ts": "export function a() { return b(); }\nfunction b() { return { id: 1 }; }\n",
      "gone.ts": "export function g() {}\n",
    });
    await project.index();
    const count = (storage: ReturnType<TestProject["open"]>) =>
      Object.fromEntries(
        ["nodes", "edges", "files", "return_shapes", "property_accesses", "imports", "exports"].map((t) => [
          t,
          (storage.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c,
        ])
      );

    project.remove("gone.ts");
    const result = await project.index();
    expect(result.removed).toBe(1);

    let storage = project.open();
    const before = count(storage);
    storage.close();
    expect(before.files).toBe(1);

    for (let i = 0; i < 3; i++) await project.index({ force: true });
    storage = project.open();
    try {
      expect(count(storage)).toEqual(before);
      expect(storage.getIndexedFiles()).toEqual([project.path("a.ts")]);
    } finally {
      storage.close();
    }
  });

  it("indexes a mixed-language project without edge id collisions", async () => {
    project = createProject({
      "a.py": "def one():\n    two()\n\ndef two():\n    pass\n",
      "b.ts": "export function one() { two(); }\nfunction two() {}\n",
      "c.js": "function one() { two(); }\nfunction two() {}\n",
    });
    await project.index();
    const storage = project.open();
    try {
      const calls = storage.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE type = 'calls'").get() as { c: number };
      expect(calls.c).toBe(3);
      expect(callPairs(storage)).toEqual(["one -> two"]);
      const resolved = storage.getStats().resolvedCalls;
      expect(resolved).toBe(3);
    } finally {
      storage.close();
    }
  });

  it("rebuilds indexes written by older versions", async () => {
    project = createProject({ "a.py": "def f():\n    g()\n\ndef g():\n    pass\n" });
    await project.index();
    let storage = project.open();
    storage.db.prepare("DELETE FROM meta WHERE key = 'index_format_version'").run();
    expect(storage.isIndexOutdated()).toBe(true);
    storage.close();

    const result = await project.index();
    expect(result.rebuilt).toBe(true);
    expect(result.indexed).toBe(1);
    storage = project.open();
    try {
      expect(storage.isIndexOutdated()).toBe(false);
    } finally {
      storage.close();
    }
  });
});
