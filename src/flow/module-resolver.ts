/**
 * Module resolution: turn an import specifier into the indexed file it refers to.
 *
 * Works purely on the set of indexed file paths (plus tsconfig/jsconfig path
 * aliases read from disk), so it never touches files outside the index.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve as resolvePath } from "path";

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** `import "./x.js"` in TypeScript usually means `./x.ts`. */
const JS_RUNTIME_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/;

interface PathAliasConfig {
  /** Directory non-relative imports are resolved against (absolute), if any. */
  baseUrl: string | null;
  /** [pattern prefix, pattern suffix, target templates (absolute)] */
  paths: Array<{ prefix: string; suffix: string; exact: boolean; targets: string[] }>;
}

export type LanguageFamily = "python" | "javascript";

export function languageFamily(language: string): LanguageFamily {
  return language === "python" ? "python" : "javascript";
}

export class ModuleResolver {
  private files: Set<string>;
  private rootPath: string;
  private aliasCache = new Map<string, PathAliasConfig | null>();
  private configByDir = new Map<string, PathAliasConfig | null>();
  private pythonCache = new Map<string, string | null>();
  private pythonSuffixIndex: Map<string, string[]> | null = null;

  constructor(files: Iterable<string>, rootPath: string) {
    this.files = new Set(files);
    this.rootPath = normalize(rootPath);
  }

  has(filePath: string): boolean {
    return this.files.has(filePath);
  }

  /** Resolve `specifier` as imported from `fromFile`. Returns an indexed file path or null. */
  resolve(fromFile: string, specifier: string, family: LanguageFamily): string | null {
    return family === "python"
      ? this.resolvePython(fromFile, specifier)
      : this.resolveJavaScript(fromFile, specifier);
  }

  // ---------------------------------------------------------------- JS / TS

  private resolveJavaScript(fromFile: string, specifier: string): string | null {
    if (specifier.startsWith(".")) {
      return this.probeJavaScript(normalize(resolvePath(dirname(fromFile), specifier)));
    }
    if (specifier.startsWith("/")) {
      return this.probeJavaScript(normalize(specifier));
    }

    // tsconfig / jsconfig "paths" and "baseUrl"
    const config = this.aliasConfigFor(dirname(fromFile));
    if (config) {
      for (const mapping of config.paths) {
        let captured: string | null = null;
        if (mapping.exact) {
          if (specifier === mapping.prefix) captured = "";
        } else if (
          specifier.startsWith(mapping.prefix) &&
          specifier.endsWith(mapping.suffix) &&
          specifier.length >= mapping.prefix.length + mapping.suffix.length
        ) {
          captured = specifier.slice(mapping.prefix.length, specifier.length - mapping.suffix.length);
        }
        if (captured === null) continue;
        for (const target of mapping.targets) {
          const found = this.probeJavaScript(target.replace("*", captured));
          if (found) return found;
        }
      }
      if (config.baseUrl) {
        const found = this.probeJavaScript(`${config.baseUrl}/${specifier}`);
        if (found) return found;
      }
    }

    return null; // a package from node_modules, or a Node built-in
  }

  /** Try a path as a file (with and without extension) and as a directory index. */
  private probeJavaScript(base: string): string | null {
    if (this.files.has(base)) return base;

    const candidates = [base];
    if (JS_RUNTIME_EXTENSION.test(base)) {
      candidates.push(base.replace(JS_RUNTIME_EXTENSION, ""));
    }
    for (const candidate of candidates) {
      for (const ext of JS_EXTENSIONS) {
        if (this.files.has(candidate + ext)) return candidate + ext;
      }
      for (const ext of JS_EXTENSIONS) {
        const index = `${candidate}/index${ext}`;
        if (this.files.has(index)) return index;
      }
    }
    return null;
  }

  /** Nearest tsconfig.json / jsconfig.json at or above `dir` (within the project). */
  private aliasConfigFor(dir: string): PathAliasConfig | null {
    const cached = this.configByDir.get(dir);
    if (cached !== undefined) return cached;

    let result: PathAliasConfig | null = null;
    let current = normalize(dir);
    const visited: string[] = [];
    while (true) {
      visited.push(current);
      const known = this.configByDir.get(current);
      if (known !== undefined && current !== dir) {
        result = known;
        break;
      }
      const config = this.readAliasConfig(current);
      if (config) {
        result = config;
        break;
      }
      if (current === this.rootPath || !current.startsWith(this.rootPath)) break;
      const parent = normalize(dirname(current));
      if (parent === current) break;
      current = parent;
    }

    for (const v of visited) this.configByDir.set(v, result);
    return result;
  }

  private readAliasConfig(dir: string): PathAliasConfig | null {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const file = join(dir, name);
      const cached = this.aliasCache.get(file);
      if (cached !== undefined) {
        if (cached) return cached;
        continue;
      }
      const config = existsSync(file) ? this.loadAliasConfig(file, 0) : null;
      this.aliasCache.set(file, config);
      if (config) return config;
    }
    return null;
  }

  private loadAliasConfig(file: string, depth: number): PathAliasConfig | null {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(stripJsonComments(readFileSync(file, "utf-8")));
    } catch {
      return null;
    }
    if (!json || typeof json !== "object") return null;

    const configDir = normalize(dirname(file));
    const options = (json.compilerOptions ?? {}) as Record<string, unknown>;

    let inherited: PathAliasConfig | null = null;
    const parent = typeof json.extends === "string" ? json.extends : null;
    if (parent && parent.startsWith(".") && depth < 5) {
      let parentFile = resolvePath(configDir, parent);
      if (!parentFile.endsWith(".json")) parentFile += ".json";
      if (existsSync(parentFile)) inherited = this.loadAliasConfig(parentFile, depth + 1);
    }

    const baseUrl =
      typeof options.baseUrl === "string"
        ? normalize(resolvePath(configDir, options.baseUrl))
        : inherited?.baseUrl ?? null;

    let paths = inherited?.paths ?? [];
    if (options.paths && typeof options.paths === "object") {
      // "paths" entries are relative to baseUrl, or to the config file when there is none.
      const pathsBase = baseUrl ?? configDir;
      paths = [];
      for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
        if (!Array.isArray(targets)) continue;
        const star = pattern.indexOf("*");
        paths.push({
          prefix: star >= 0 ? pattern.slice(0, star) : pattern,
          suffix: star >= 0 ? pattern.slice(star + 1) : "",
          exact: star < 0,
          targets: targets
            .filter((t): t is string => typeof t === "string")
            .map((t) => normalize(resolvePath(pathsBase, t))),
        });
      }
      // Longest prefix first, as TypeScript does.
      paths.sort((a, b) => b.prefix.length - a.prefix.length);
    }

    if (!baseUrl && paths.length === 0) return null;
    return { baseUrl, paths };
  }

  // ----------------------------------------------------------------- Python

  private resolvePython(fromFile: string, specifier: string): string | null {
    const key = `${specifier.startsWith(".") ? dirname(fromFile) : nearestKey(fromFile)}\0${specifier}`;
    const cached = this.pythonCache.get(key);
    if (cached !== undefined) return cached;
    const result = this.resolvePythonUncached(fromFile, specifier);
    this.pythonCache.set(key, result);
    return result;
  }

  private resolvePythonUncached(fromFile: string, specifier: string): string | null {
    const fromDir = normalize(dirname(fromFile));

    // Relative import: ".", "..pkg.mod"
    if (specifier.startsWith(".")) {
      const dots = specifier.match(/^\.+/)![0].length;
      const rest = specifier.slice(dots);
      let base = fromDir;
      for (let i = 1; i < dots; i++) base = normalize(dirname(base));
      return this.probePython(rest ? `${base}/${rest.replace(/\./g, "/")}` : base);
    }

    const relative = specifier.replace(/\./g, "/");

    // Absolute import: try every directory from the importing file up to the
    // project root as a possible source root (nearest first), then <root>/src.
    let current = fromDir;
    while (true) {
      const found = this.probePython(`${current}/${relative}`);
      if (found) return found;
      if (current === this.rootPath || !current.startsWith(this.rootPath)) break;
      const parent = normalize(dirname(current));
      if (parent === current) break;
      current = parent;
    }
    const inSrc = this.probePython(`${this.rootPath}/src/${relative}`);
    if (inSrc) return inSrc;

    // Last resort: a single indexed file whose path ends with the module path.
    const matches = this.pythonSuffixMatches(relative);
    return matches.length === 1 ? matches[0] : null;
  }

  private probePython(base: string): string | null {
    if (this.files.has(`${base}.py`)) return `${base}.py`;
    if (this.files.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
    return null;
  }

  private pythonSuffixMatches(relative: string): string[] {
    if (!this.pythonSuffixIndex) {
      this.pythonSuffixIndex = new Map();
      for (const file of this.files) {
        if (!file.endsWith(".py")) continue;
        const stem = file.endsWith("/__init__.py")
          ? file.slice(0, -"/__init__.py".length)
          : file.slice(0, -".py".length);
        const last = stem.slice(stem.lastIndexOf("/") + 1);
        const bucket = this.pythonSuffixIndex.get(last);
        if (bucket) bucket.push(file);
        else this.pythonSuffixIndex.set(last, [file]);
      }
    }
    const last = relative.slice(relative.lastIndexOf("/") + 1);
    const candidates = this.pythonSuffixIndex.get(last) ?? [];
    // A bare module name ("utils") is too ambiguous to match by suffix alone.
    if (!relative.includes("/")) return [];
    return candidates.filter((file) => {
      const stem = file.endsWith("/__init__.py")
        ? file.slice(0, -"/__init__.py".length)
        : file.slice(0, -".py".length);
      return stem.endsWith(`/${relative}`);
    });
  }
}

function nearestKey(fromFile: string): string {
  return normalize(dirname(fromFile));
}

function normalize(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** Remove // and /* *\/ comments and trailing commas, leaving string contents alone. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
