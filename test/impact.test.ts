import { afterEach, describe, expect, it } from "vitest";
import { analyzeImpact } from "../src/commands/impact.js";
import { analyzeImports } from "../src/analysis/imports.js";
import { isSecuritySensitiveName } from "../src/analysis/removed-call-impact.js";
import { parseDockerCompose, matchesEntryPoint } from "../src/analysis/docker.js";
import { commitAll, createProject, type TestProject } from "./helpers/project.js";

let project: TestProject;
afterEach(() => project?.cleanup());

const AUTH = `def validate_token(token):
    return token == "ok"


def get_user(token):
    validate_token(token)
    return {"id": 1, "email": "a@b.c", "name": "A"}
`;

const API = `from fastapi import APIRouter
from auth import get_user

router = APIRouter()


@router.get("/profile")
def profile(token):
    user = get_user(token)
    return user["email"]


@router.get("/name")
def name(token):
    return get_user(token)["name"]


def report(token):
    return profile(token)
`;

async function setup(): Promise<void> {
  project = createProject({ "auth.py": AUTH, "api.py": API });
  commitAll(project);
  await project.index();
}

describe("impact analysis (git)", () => {
  it("reports nothing when the work tree is clean", async () => {
    await setup();
    const result = await analyzeImpact({ path: project.root });
    expect(result.changedFiles).toEqual([]);
    expect(result.riskLevel).toBe("LOW");
    expect(result.mode).toBe("git");
  });

  it("finds changed functions, their callers and affected endpoints", async () => {
    await setup();
    project.write("auth.py", AUTH.replace('"name": "A"', '"name": "B"'));

    const result = await analyzeImpact({ path: project.root });
    expect(result.changedFiles).toEqual(["auth.py"]);
    expect(result.changedFunctions.map((f) => `${f.functionName}:${f.changeType}`)).toEqual(["get_user:modified"]);
    expect(result.directCallers.get("get_user")?.map((c) => c.name).sort()).toEqual(["name", "profile"]);
    expect(result.affectedEndpoints).toEqual(["GET /name", "GET /profile"]);
    expect(result.removedCallImpacts).toEqual([]);
  });

  it("flags removed security calls as CRITICAL", async () => {
    await setup();
    project.write("auth.py", AUTH.replace("    validate_token(token)\n", ""));

    const result = await analyzeImpact({ path: project.root });
    expect(result.removedCallImpacts).toHaveLength(1);
    const [impact] = result.removedCallImpacts;
    expect(impact.removedCall.callee).toBe("validate_token");
    expect(impact.removedCall.removedFrom).toBe("get_user");
    expect(impact.stillCalledBy).toEqual([]);
    expect(impact.impactedFunctions.map((f) => f.name).sort()).toEqual(["name", "profile", "report"]);
    expect(impact.severity).toBe("CRITICAL");
    expect(result.riskLevel).toBe("CRITICAL");
  });

  it("does not report a call as removed when only its receiver was renamed", async () => {
    project = createProject({
      "svc.py": `class UserService:
    def authenticate(self, token):
        return token


def login(token):
    svc = UserService()
    return svc.authenticate(token)
`,
    });
    commitAll(project);
    await project.index();
    project.write(
      "svc.py",
      `class UserService:
    def authenticate(self, token):
        return token


def login(token):
    service = UserService()
    return service.authenticate(token)
`
    );
    const result = await analyzeImpact({ path: project.root });
    expect(result.changedFunctions.map((f) => f.functionName)).toEqual(["login"]);
    expect(result.removedCallImpacts).toEqual([]);
    expect(result.riskLevel).toBe("LOW");
  });

  it("ignores removed calls to ordinary library functions", async () => {
    project = createProject({
      "q.py": `def active(items, db):
    rows = db.query("x")
    return [i for i in filter(None, items)], hash(rows)
`,
    });
    commitAll(project);
    await project.index();
    project.write("q.py", `def active(items, db):
    return items
`);
    const result = await analyzeImpact({ path: project.root });
    expect(result.removedCallImpacts).toEqual([]);
  });

  it("detects returned properties that callers still read", async () => {
    await setup();
    project.write("auth.py", AUTH.replace(', "email": "a@b.c"', ""));

    const result = await analyzeImpact({ path: project.root });
    expect(result.dataFlowChanges).toHaveLength(1);
    const [change] = result.dataFlowChanges;
    expect(change.propertyPath).toBe("email");
    expect(change.functionName).toBe("get_user");
    expect(change.accessLocations.map((l) => l.functionName)).toEqual(["profile"]);
    expect(change.severity).toBe("CRITICAL");
  });

  it("reports removed imports that are still used", async () => {
    await setup();
    project.write("api.py", API.replace("from auth import get_user\n", ""));

    const result = await analyzeImpact({ path: project.root });
    const issues = result.importIssues.get("api.py");
    expect(issues?.missing.map((m) => m.identifier)).toEqual(["get_user"]);
    expect(result.riskLevel).toBe("HIGH");
  });

  it("handles deleted, added and untracked files and odd file names", async () => {
    await setup();
    project.remove("api.py");
    project.write("new module.py", "def fresh():\n    pass\n");
    project.write('weird"$(name).py', "def odd():\n    pass\n");

    const result = await analyzeImpact({ path: project.root });
    expect(result.changedFiles.sort()).toEqual(["api.py", "new module.py", 'weird"$(name).py'].sort());
    expect(result.changedFunctions.filter((f) => f.changeType === "deleted").map((f) => f.functionName).sort()).toEqual([
      "name",
      "profile",
      "report",
    ]);

    // the index follows the work tree
    const storage = project.open();
    try {
      const files = storage.getIndexedFiles();
      expect(files).toContain(project.path("new module.py"));
      expect(files).not.toContain(project.path("api.py"));
    } finally {
      storage.close();
    }
  });

  it("works from a subdirectory of the repository", async () => {
    project = createProject({ "backend/auth.py": AUTH, "backend/api.py": API, "README.md": "x\n" });
    commitAll(project);
    const sub = createProject();
    sub.cleanup();
    // index only the backend directory
    const { FlowBuilder, FlowStorage } = await import("../src/flow/index.js");
    const { mkdirSync } = await import("fs");
    mkdirSync(project.path("backend/.codemap"), { recursive: true });
    const storage = new FlowStorage(project.path("backend/.codemap/graph.db"));
    await new FlowBuilder(storage, {
      rootPath: project.path("backend"),
      include: ["**/*.py"],
      exclude: [],
      forceReindex: false,
    }).build();
    storage.close();

    project.write("backend/auth.py", AUTH.replace('"A"', '"Z"'));
    project.write("README.md", "changed\n");
    const result = await analyzeImpact({ path: project.path("backend") });
    expect(result.changedFiles).toEqual(["auth.py"]);
    expect(result.directCallers.get("get_user")?.length).toBe(2);
  });

  it("falls back to hash comparison in a repository without commits", async () => {
    project = createProject({ "a.py": "def f():\n    pass\n" });
    project.git("init", "-q");
    await project.index();
    project.write("a.py", "def f():\n    return 1\n");
    const result = await analyzeImpact({ path: project.root });
    expect(result.mode).toBe("hash");
    expect(result.changedFiles).toEqual(["a.py"]);
    expect(result.notes.join(" ")).toMatch(/no commits/);
  });

  it("falls back to hash comparison outside git", async () => {
    project = createProject({ "a.ts": "export function f() {}\n", "b.ts": "export function g() {}\n" });
    await project.index();
    project.write("a.ts", "export function f() { return 1; }\n");
    project.remove("b.ts");
    const result = await analyzeImpact({ path: project.root });
    expect(result.mode).toBe("hash");
    expect(result.changedFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("throws a clear error when the project is not initialized", async () => {
    project = createProject({ "a.py": "x = 1\n" });
    await expect(analyzeImpact({ path: project.root })).rejects.toThrow(/Not initialized/);
  });
});

describe("import analysis", () => {
  it("finds unused imports without false positives from types, JSX or strings", () => {
    project = createProject({
      "a.tsx": `import React from "react";
import { useState, useMemo } from "react";
import type { Props } from "./types";
import { Button } from "./ui";
import {
  formatDate,
  unusedHelper,
} from "./utils";

// useMemo is mentioned in a comment only
export function View(p: Props) {
  const [s] = useState("useMemo");
  return <Button>{formatDate(s)}</Button>;
}
`,
      "b.py": `import os
import sys
from typing import TYPE_CHECKING, Optional
from .models import User


def f(u: "User") -> Optional[int]:
    return os.getpid()
`,
    });
    const ts = analyzeImports(project.path("a.tsx"));
    expect(ts.unused.map((u) => u.identifier).sort()).toEqual(["unusedHelper", "useMemo"]);
    const py = analyzeImports(project.path("b.py"));
    expect(py.unused.map((u) => u.identifier).sort()).toEqual(["TYPE_CHECKING", "sys"]);
  });

  it("reports nothing for files that do not exist", () => {
    expect(analyzeImports("/definitely/missing/file.py")).toEqual({ missing: [], unused: [] });
  });
});

describe("helpers", () => {
  it("matches security-sensitive names on whole words", () => {
    for (const name of ["validate_token", "checkPermission", "authenticate", "verifyJwt", "sanitizeHtml"]) {
      expect(isSecuritySensitiveName(name), name).toBe(true);
    }
    for (const name of ["author_name", "format_date", "render", "sqrt", "rolex"]) {
      expect(isSecuritySensitiveName(name), name).toBe(false);
    }
  });

  it("parses docker-compose entry points and tolerates broken files", () => {
    project = createProject({
      "docker-compose.yml": `services:
  api:
    build: ./backend
    command: uvicorn app.main:app --host 0.0.0.0
  worker:
    build:
      context: ./backend
    depends_on: [api]
  web:
    image: nginx
    depends_on:
      api:
        condition: service_healthy
`,
      "backend/Dockerfile": `FROM python:3.12
HEALTHCHECK --interval=30s \\
  CMD curl -f http://localhost/ || exit 1
CMD ["python", "-m", "app.worker"]
`,
    });
    const graph = parseDockerCompose(project.root);
    expect(graph.entryPoints.get("api")).toBe("backend/app/main.py");
    expect(graph.entryPoints.get("worker")).toBe("backend/app/worker.py");
    expect(graph.services.get("web")?.dependsOn).toEqual(["api"]);
    expect(matchesEntryPoint("backend/app/main.py", "backend/app/main.py")).toBe(true);
    expect(matchesEntryPoint("src/server.js", "server.js")).toBe(true);
    expect(matchesEntryPoint("src/myserver.js", "server.js")).toBe(false);

    project.write("docker-compose.yml", "services: [this is: not valid");
    expect(parseDockerCompose(project.root).services.size).toBe(0);
  });
});
