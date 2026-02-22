/**
 * Package version, read from package.json at runtime.
 *
 * Both the sources (src/version.ts) and the bundles (dist/*.js) sit one level
 * below the package root, so `../package.json` is the right file in both.
 */

import { readFileSync } from "fs";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
