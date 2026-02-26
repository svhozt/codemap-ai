import { describe, expect, it } from "vitest";
import { parserRegistry } from "../src/parsers/index.js";
import type { FileAnalysis } from "../src/types.js";

function parse(file: string, source: string): FileAnalysis {
  const parser = parserRegistry.getForFile(file);
  if (!parser) throw new Error(`no parser for ${file}`);
  return parser.parse(file, source);
}

function names(analysis: FileAnalysis, type?: string): string[] {
  return analysis.nodes.filter((n) => !type || n.type === type).map((n) => n.name);
}

/** "scope -> callee" for every call edge, using node names for the scope. */
function calls(analysis: FileAnalysis): string[] {
  const byId = new Map(analysis.nodes.map((n) => [n.id, n.name]));
  return analysis.edges
    .filter((e) => e.type === "calls")
    .map((e) => `${byId.get(e.sourceId)} -> ${e.targetId.replace(/^ref:/, "")}`);
}

describe("parser registry", () => {
  it("maps every supported extension to a parser", () => {
    for (const ext of [".py", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      expect(parserRegistry.getByExtension(ext), ext).toBeDefined();
    }
    expect(parserRegistry.getForFile("README.md")).toBeUndefined();
    expect(parserRegistry.getForFile("Makefile")).toBeUndefined();
    expect(parserRegistry.getByExtension("TS")?.language).toBe("typescript");
  });
});

describe("TypeScript / JavaScript parser", () => {
  it("creates nodes for functions, arrow functions, classes and methods", () => {
    const a = parse(
      "/p/math.ts",
      `export function add(a: number, b: number) { return a + b; }
export const double = (x: number) => add(x, x);
const named = function inner() { return 1; };
export class Calculator {
  total = 0;
  handler = async () => { this.reset(); };
  addTo(x: number) { this.total = add(this.total, x); return this.total; }
  static create() { return new Calculator(); }
  reset() {}
}
`
    );
    expect(names(a, "function").sort()).toEqual(["add", "double", "named"]);
    expect(names(a, "class")).toEqual(["Calculator"]);
    expect(names(a, "method").sort()).toEqual(["addTo", "create", "handler", "reset"]);
    for (const method of a.nodes.filter((n) => n.type === "method")) {
      expect(method.metadata?.parentClass).toBe("Calculator");
    }
    expect(a.nodes.some((n) => n.name === "anonymous")).toBe(false);
  });

  it("attributes calls to the enclosing function, including calls in callbacks", () => {
    const a = parse(
      "/p/app.ts",
      `import { add } from "./math";
export function run(items: number[]) {
  return items.map((n) => add(n, 1)).filter(Boolean);
}
setup();
`
    );
    expect(calls(a)).toEqual(
      expect.arrayContaining(["run -> add", "run -> ?.filter", "run -> items.map", "app.ts -> setup"])
    );
    // the callback is not a node of its own
    expect(names(a, "function")).toEqual(["run"]);
  });

  it("records new expressions, JSX components and this/super calls", () => {
    const a = parse(
      "/p/view.tsx",
      `import { Button } from "./ui";
class Base { greet() {} }
export class Child extends Base {
  constructor() { super(); }
  greet() { super.greet(); this.render(); }
  render() { return <Button label="x"><span /></Button>; }
}
export const make = () => new Child();
`
    );
    const c = calls(a);
    expect(c).toContain("constructor -> super");
    expect(c).toContain("greet -> super.greet");
    expect(c).toContain("greet -> this.render");
    expect(c).toContain("render -> Button");
    expect(c).toContain("make -> Child");
    expect(c.some((x) => x.endsWith("-> span"))).toBe(false); // DOM elements are not components
    expect(a.edges.filter((e) => e.type === "extends").map((e) => e.targetId)).toEqual(["ref:Base"]);
  });

  it("records imports with aliases, default and namespace bindings", () => {
    const a = parse(
      "/p/x.ts",
      `import def, { a, b as c } from "./mod";
import * as ns from "./ns";
import type { T } from "./types";
export { q as r } from "./re";
export * from "./star";
`
    );
    const byLocal = new Map<string, { source: string; original?: string; reExport?: boolean }>();
    for (const imp of a.imports) {
      for (const spec of imp.specifiers) {
        byLocal.set(spec, { source: imp.source, original: imp.aliases?.[spec], reExport: imp.isReExport });
      }
    }
    expect(byLocal.get("def")).toEqual({ source: "./mod", original: "default", reExport: undefined });
    expect(byLocal.get("a")?.original).toBeUndefined();
    expect(byLocal.get("c")).toMatchObject({ source: "./mod", original: "b" });
    expect(byLocal.get("ns")).toMatchObject({ source: "./ns", original: "*" });
    expect(byLocal.get("T")?.source).toBe("./types");
    expect(byLocal.get("r")).toMatchObject({ source: "./re", original: "q", reExport: true });
    expect(byLocal.get("*")).toMatchObject({ source: "./star", reExport: true });
  });

  it("understands CommonJS require and module.exports", () => {
    const a = parse(
      "/p/util.js",
      `const { greet, x: y } = require("./greet");
const lib = require("./lib");
function formatName(user) { return user.first; }
exports.shout = function () { return greet(lib.name()); };
module.exports.formatName = formatName;
`
    );
    expect(names(a, "function").sort()).toEqual(["formatName", "shout"]);
    const req = a.imports.filter((i) => i.source === "./greet")[0];
    expect(req.specifiers).toEqual(["greet", "y"]);
    expect(req.aliases).toEqual({ y: "x" });
    expect(a.imports.find((i) => i.source === "./lib")?.aliases).toEqual({ lib: "*" });
    expect(a.exports.map((e) => e.name).sort()).toEqual(["formatName", "shout"]);
    expect(calls(a)).toEqual(expect.arrayContaining(["shout -> greet", "shout -> lib.name"]));
  });

  it("creates nodes for object-literal namespaces", () => {
    const a = parse(
      "/p/api.ts",
      `export const api = {
  async load(id: string) { return fetchJson(id); },
  save: (x: unknown) => post(x),
  version: 2,
};
`
    );
    expect(names(a, "variable")).toEqual(["api"]);
    const members = a.nodes.filter((n) => n.metadata?.memberOf === "api").map((n) => n.name);
    expect(members.sort()).toEqual(["load", "save"]);
    expect(calls(a)).toEqual(expect.arrayContaining(["load -> fetchJson", "save -> post"]));
  });

  it("treats wrapped components as functions", () => {
    const a = parse(
      "/p/c.tsx",
      `const Card = memo(forwardRef((props, ref) => <Inner ref={ref} />));
export default Card;
const doubled = [1, 2].map((n) => n * 2);
`
    );
    expect(names(a, "function")).toEqual(["Card"]);
    expect(calls(a)).toContain("Card -> Inner");
    expect(a.exports).toContainEqual(expect.objectContaining({ name: "Card", isDefault: true }));
  });

  it("parses large files (tree-sitter's 32 KB string limit)", () => {
    const body = Array.from({ length: 1500 }, (_, i) => `export function f${i}() { return g${i}(); }`).join("\n");
    expect(body.length).toBeGreaterThan(40_000);
    const a = parse("/p/big.ts", body);
    expect(names(a, "function")).toHaveLength(1500);
  });

  it("survives syntax errors and empty files", () => {
    expect(() => parse("/p/empty.ts", "")).not.toThrow();
    expect(names(parse("/p/empty.ts", ""))).toEqual(["empty.ts"]);
    const broken = parse("/p/broken.ts", "export function ok() { a(); }\nfunction (((( {");
    expect(names(broken, "function")).toContain("ok");
  });

  it("gives edges ids that are unique per file and stable between runs", () => {
    const source = "function a() { b(); c(); }\nfunction b() {}";
    const first = parse("/p/one.js", source).edges.map((e) => e.id);
    const again = parse("/p/one.js", source).edges.map((e) => e.id);
    const other = parse("/p/two.js", source).edges.map((e) => e.id);
    expect(new Set(first).size).toBe(first.length);
    expect(again).toEqual(first);
    expect(other.some((id) => first.includes(id))).toBe(false);
  });

  it("tracks variable types from new, annotations and constructor parameters", () => {
    const a = parse(
      "/p/svc.ts",
      `export class Service {
  private repo: Repo;
  constructor(private db: Database, logger: Logger) {
    this.repo = new Repo(db);
  }
  run(user: User | null) {
    const client = new HttpClient();
    const result = await fetchUser();
  }
}
`
    );
    const types = (a.variableTypes ?? []).map((v) => `${v.variableName}:${v.typeName}`);
    expect(types).toEqual(
      expect.arrayContaining([
        "this.repo:Repo",
        "this.db:Database",
        "db:Database",
        "logger:Logger",
        "user:User",
        "client:HttpClient",
        "result:@call:fetchUser",
      ])
    );
  });
});

describe("Python parser", () => {
  const source = `from fastapi import APIRouter, Depends
from typing import Annotated, Optional
from .auth import get_user as current_user, validate
import os.path

router = APIRouter()


class Base:
    def log(self, msg):
        print(msg)


class Service(Base):
    repo: "Repo"

    def __init__(self, db: Database, cache: Optional[Cache] = None):
        self.db = db
        self.client = HttpClient()

    @staticmethod
    def build():
        return Service(None)

    def run(self):
        super().log("x")
        self.helper()
        return self.db.query()


@router.post("/orders")
async def create_order(user=Depends(current_user), other: Annotated[str, Depends(validate)] = ""):
    svc = Service.build()
    return svc.run()


@router.get(PATH_CONSTANT)
def not_a_route():
    pass
`;
  const a = parse("/p/app.py", source);

  it("creates nodes for functions, classes and methods", () => {
    expect(names(a, "function").sort()).toEqual(["create_order", "not_a_route"]);
    expect(names(a, "class").sort()).toEqual(["Base", "Service"]);
    expect(names(a, "method").sort()).toEqual(["__init__", "build", "log", "run"]);
    const build = a.nodes.find((n) => n.name === "build")!;
    expect(build.metadata?.static).toBe(true);
  });

  it("records calls with their receiver", () => {
    const c = calls(a);
    expect(c).toEqual(
      expect.arrayContaining([
        "run -> super().log",
        "run -> self.helper",
        "run -> self.db.query",
        "create_order -> Service.build",
        "create_order -> svc.run",
        "app.py -> APIRouter",
      ])
    );
    expect(c).not.toContain("run -> super");
  });

  it("detects FastAPI routes only for literal paths", () => {
    const handler = a.nodes.find((n) => n.name === "create_order")!;
    expect(handler.metadata?.httpEndpoint).toEqual({ method: "POST", path: "/orders" });
    const other = a.nodes.find((n) => n.name === "not_a_route")!;
    expect(other.metadata?.httpEndpoint).toBeUndefined();
  });

  it("detects Depends() in defaults and in Annotated[...]", () => {
    const handler = a.nodes.find((n) => n.name === "create_order")!;
    const deps = (handler.metadata?.depends as Array<{ dependencyName: string }>).map((d) => d.dependencyName);
    expect(deps.sort()).toEqual(["current_user", "validate"]);
  });

  it("records imports with aliases", () => {
    const auth = a.imports.find((i) => i.source === ".auth")!;
    expect(auth.specifiers).toEqual(["current_user", "validate"]);
    expect(auth.aliases).toEqual({ current_user: "get_user" });
    const osPath = a.imports.find((i) => i.source === "os.path")!;
    expect(osPath.specifiers).toEqual(["os.path"]);
  });

  it("tracks parameter, attribute and assignment types", () => {
    const types = (a.variableTypes ?? []).map((v) => `${v.variableName}:${v.typeName}`);
    expect(types).toEqual(
      expect.arrayContaining([
        "db:Database",
        "cache:Cache",
        "self.db:Database",
        "self.client:HttpClient",
        "self.repo:Repo",
        "svc:Service",
      ])
    );
  });

  it("parses large files", () => {
    const big = Array.from({ length: 1500 }, (_, i) => `def f${i}():\n    return g${i}()\n`).join("\n");
    expect(names(parse("/p/big.py", big), "function")).toHaveLength(1500);
  });

  it("survives syntax errors", () => {
    const broken = parse("/p/b.py", "def ok():\n    a()\n\ndef (((:\n");
    expect(names(broken, "function")).toContain("ok");
  });
});
