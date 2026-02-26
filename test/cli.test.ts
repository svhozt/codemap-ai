/**
 * End-to-end tests of the built CLI (dist/cli.js) and MCP server (dist/mcp-server.js).
 * `npm test` builds first (see the "pretest" script).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { promisify } from "util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { commitAll, createProject, type TestProject } from "./helpers/project.js";

const run = promisify(execFile);
const repoRoot = resolve(__dirname, "..");
const CLI = join(repoRoot, "dist", "cli.js");
const MCP = join(repoRoot, "dist", "mcp-server.js");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { version: string };

let project: TestProject;
afterEach(() => project?.cleanup());

beforeAll(() => {
  if (!existsSync(CLI) || !existsSync(MCP)) {
    throw new Error("dist/ is missing. Run `npm run build` (or `npm test`, which builds first).");
  }
});

async function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd,
      // A private HOME: nothing may touch the real user's configuration.
      env: { ...process.env, HOME: cwd, USERPROFILE: cwd, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const FILES = {
  "auth.py": `def validate_token(token):
    return token == "ok"


def get_user(token):
    validate_token(token)
    return {"id": 1}
`,
  "api.py": `from auth import get_user


def profile(token):
    return get_user(token)
`,
  "web/app.ts": `export function render() { return format(); }
function format() { return "x"; }
`,
};

describe("CLI", () => {
  it("prints the package version", async () => {
    project = createProject();
    const result = await cli(["--version"], project.root);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("init indexes the project and registers the MCP server in .mcp.json", async () => {
    project = createProject({
      ...FILES,
      ".mcp.json": JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    });
    const result = await cli(["init"], project.root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Indexed:\s+3 files/);
    expect(existsSync(project.path(".codemap/graph.db"))).toBe(true);

    const config = JSON.parse(readFileSync(project.path(".mcp.json"), "utf-8"));
    expect(Object.keys(config.mcpServers).sort()).toEqual(["codemap", "other"]);
    expect(config.mcpServers.codemap.args).toContain("mcp-server");
    // never written outside the project
    expect(existsSync(join(project.root, ".claude", "config.json"))).toBe(false);

    const again = await cli(["init"], project.root);
    expect(again.stdout).toMatch(/Already initialized/);
  });

  it("init --skip-mcp leaves .mcp.json alone", async () => {
    project = createProject(FILES);
    const result = await cli(["init", "--skip-mcp"], project.root);
    expect(result.code).toBe(0);
    expect(existsSync(project.path(".mcp.json"))).toBe(false);
  });

  it("index is incremental, reindex rebuilds everything", async () => {
    project = createProject(FILES);
    await cli(["index"], project.root);
    const second = await cli(["index"], project.root);
    expect(second.stdout).toMatch(/Indexed:\s+0 files/);
    expect(second.stdout).toMatch(/Skipped:\s+3 files/);

    const re = await cli(["reindex"], project.root);
    expect(re.code).toBe(0);
    expect(re.stdout).toMatch(/Indexed:\s+3 files/);
  });

  it("index honours --include / --exclude and remembers them", async () => {
    project = createProject(FILES);
    const result = await cli(["index", ".", "--include", "**/*.py"], project.root);
    expect(result.stdout).toMatch(/Indexed:\s+2 files/);
    // a plain `index` keeps using the stored patterns
    const again = await cli(["index"], project.root);
    expect(again.stdout).toMatch(/Total:\s+2 files/);
  });

  it("impact reports changed functions, callers and risk; --json is machine readable", async () => {
    project = createProject(FILES);
    commitAll(project);
    await cli(["init", "--skip-mcp"], project.root);

    project.write("auth.py", FILES["auth.py"].replace("    validate_token(token)\n", ""));

    const text = await cli(["impact", "--verbose"], project.root);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("get_user (auth.py:5)");
    expect(text.stdout).toContain("profile (api.py:4)");
    expect(text.stdout).toMatch(/CRITICAL: validate_token\(\)/);

    const json = await cli(["impact", "--json"], project.root);
    const data = JSON.parse(json.stdout);
    expect(data.changedFiles).toEqual(["auth.py"]);
    expect(data.riskLevel).toBe("CRITICAL");
    expect(Object.keys(data.directCallers)).toEqual(["get_user"]);

    const gate = await cli(["impact", "--fail-on", "high"], project.root);
    expect(gate.code).toBe(2);
  });

  it("gives clear errors for missing projects and missing indexes", async () => {
    project = createProject(FILES);
    const notInit = await cli(["impact"], project.root);
    expect(notInit.code).toBe(1);
    expect(notInit.stderr + notInit.stdout).toMatch(/Not initialized/);

    const missing = await cli(["index", "does-not-exist"], project.root);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/Directory not found/);

    const viz = await cli(["visualize", "--no-open"], project.root);
    expect(viz.code).toBe(1);
    expect(viz.stderr).toMatch(/Not initialized/);
  });

  it("visualize exits cleanly when there is nothing to show", async () => {
    project = createProject(FILES);
    commitAll(project);
    await cli(["init", "--skip-mcp"], project.root);
    const result = await cli(["visualize", "--no-open"], project.root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No changes detected/);
  });
});

describe("MCP server", () => {
  async function connect(root: string): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp-server", "--path", root],
      env: { ...process.env, HOME: root } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "codemap-test", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  function textOf(result: unknown): string {
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    return content.map((c) => c.text).join("\n");
  }

  it("lists the three tools and answers queries", async () => {
    project = createProject({
      ...FILES,
      "other.py": "def get_user():\n    pass\n",
    });
    await cli(["index"], project.root);
    const client = await connect(project.root);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "codemap_callers",
        "codemap_impact",
        "codemap_trace_flow",
      ]);

      const callers = textOf(
        await client.callTool({ name: "codemap_callers", arguments: { function: "validate_token" } })
      );
      expect(callers).toContain("get_user");
      expect(callers).toContain("auth.py:5");

      // two functions named get_user: the answer says so, and `file` picks one
      const ambiguous = textOf(
        await client.callTool({ name: "codemap_impact", arguments: { target: "get_user" } })
      );
      expect(ambiguous).toMatch(/2 symbols are named "get_user"/);
      const picked = textOf(
        await client.callTool({ name: "codemap_impact", arguments: { target: "get_user", file: "auth.py" } })
      );
      expect(picked).toContain("profile in api.py:4");

      const flow = textOf(
        await client.callTool({ name: "codemap_trace_flow", arguments: { from: "profile", to: "validate_token" } })
      );
      expect(flow).toMatch(/1\. \*\*profile\*\*[\s\S]*3\. \*\*validate_token\*\*/);

      const unknown = textOf(await client.callTool({ name: "codemap_callers", arguments: { function: "nope_x" } }));
      expect(unknown).toMatch(/No function, method or class named "nope_x"/);

      const badArgs = textOf(await client.callTool({ name: "codemap_impact", arguments: {} }));
      expect(badArgs).toMatch(/Missing argument: target/);
    } finally {
      await client.close();
    }
  });

  it("asks for a reindex instead of answering from an outdated index", async () => {
    project = createProject(FILES);
    await cli(["index"], project.root);
    const { FlowStorage } = await import("../src/flow/index.js");
    const storage = new FlowStorage(project.path(".codemap/graph.db"));
    storage.db.prepare("DELETE FROM meta WHERE key = 'index_format_version'").run();
    storage.close();

    const client = await connect(project.root);
    try {
      const result = await client.callTool({ name: "codemap_callers", arguments: { function: "get_user" } });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toMatch(/codemap-ai reindex/);
    } finally {
      await client.close();
    }
  });

  it("reports a missing index as a tool error instead of crashing", async () => {
    project = createProject(FILES);
    mkdirSync(project.path("empty"), { recursive: true });
    writeFileSync(project.path("empty/x.py"), "x = 1\n");
    const client = await connect(project.path("empty"));
    try {
      const result = await client.callTool({ name: "codemap_callers", arguments: { function: "x" } });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toMatch(/database not found/i);
    } finally {
      await client.close();
    }
  });
});
