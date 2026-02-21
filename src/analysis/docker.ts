/**
 * Docker Compose dependency analyzer
 * Parses docker-compose files and Dockerfiles to build service dependency graph
 */

import { readFileSync, existsSync } from "fs";
import { load as parseYaml } from "js-yaml";
import { join, posix } from "path";

/**
 * Parse Dockerfile to extract CMD or ENTRYPOINT
 */
function parseDockerfile(dockerfilePath: string): string | null {
  if (!existsSync(dockerfilePath)) {
    return null;
  }

  let content: string;
  try {
    content = readFileSync(dockerfilePath, "utf-8");
  } catch {
    return null;
  }
  // Join line continuations so multi-line instructions are seen as one line.
  const lines = content.replace(/\\\r?\n/g, " ").split("\n");

  // The last CMD / ENTRYPOINT wins, as in Docker. `HEALTHCHECK ... CMD ...`
  // lines (also when continued over several lines) are not entry points.
  let entryPoint: string | null = null;
  let inHealthCheck = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^HEALTHCHECK\b/i.test(trimmed)) {
      inHealthCheck = true;
      continue;
    }
    // An indented CMD right after HEALTHCHECK is its command (older, continuation-less style).
    if (inHealthCheck && /^\s/.test(line)) continue;
    inHealthCheck = false;

    const instruction = trimmed.match(/^(CMD|ENTRYPOINT)\s+(.+)$/i);
    if (!instruction) continue;

    const args = instruction[2].trim();
    const exec = args.match(/^\[(.*)\]$/);
    const commandStr = exec
      ? exec[1]
          .split(",")
          .map((p) => p.trim().replace(/^["']|["']$/g, ""))
          .join(" ")
      : args;
    const found = extractEntryPointFromCommand(commandStr);
    if (found) entryPoint = found;
  }

  return entryPoint;
}

/**
 * Extract entry point file from a command string
 */
function extractEntryPointFromCommand(command: string | string[]): string | null {
  const commandStr = Array.isArray(command) ? command.join(" ") : command;

  if (typeof commandStr !== "string") return null;

  // node server.js / tsx src/index.ts / bun run app.ts
  const scriptMatch = commandStr.match(
    /\b(?:node|nodemon|ts-node|tsx|bun(?:\s+run)?|deno\s+run)\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+([^\s"']+\.(?:[cm]?js|[cm]?ts))/
  );
  if (scriptMatch) return scriptMatch[1].replace(/^\.\//, "");

  // python -m backend.api -> backend/api.py
  const moduleMatch = commandStr.match(/\bpython[\d.]*\s+(?:-\w+\s+)*-m\s+([\w.]+)/);
  if (moduleMatch && !["uvicorn", "gunicorn", "hypercorn"].includes(moduleMatch[1])) {
    return `${moduleMatch[1].replace(/\./g, "/")}.py`;
  }

  // python app.py
  const pythonMatch = commandStr.match(/\bpython[\d.]*\s+(?:-\w+\s+)*([^\s"']+\.py)/);
  if (pythonMatch) return pythonMatch[1].replace(/^\.\//, "");

  // uvicorn main:app / gunicorn pkg.main:app -> main.py / pkg/main.py
  const asgiMatch = commandStr.match(/\b(?:uvicorn|gunicorn|hypercorn)\b.*?\s([\w.]+):\w+/);
  if (asgiMatch) return `${asgiMatch[1].replace(/\./g, "/")}.py`;

  return null;
}

export interface DockerService {
  name: string;
  dependsOn: string[];
  volumes: string[];
  entryPoint?: string;
  command?: string;
}

export interface DockerDependencyGraph {
  services: Map<string, DockerService>;
  entryPoints: Map<string, string>; // service name -> entry point file path
}

/**
 * Parse docker-compose.yaml and build service dependency graph
 */
export function parseDockerCompose(projectRoot: string): DockerDependencyGraph {
  const graph: DockerDependencyGraph = {
    services: new Map(),
    entryPoints: new Map(),
  };

  // Find docker-compose files
  const composeFiles = [
    join(projectRoot, "docker-compose.yaml"),
    join(projectRoot, "docker-compose.yml"),
    join(projectRoot, "compose.yaml"),
    join(projectRoot, "compose.yml"),
  ];

  let composeData: any = null;

  for (const file of composeFiles) {
    if (existsSync(file)) {
      try {
        composeData = parseYaml(readFileSync(file, "utf-8")) as any;
      } catch {
        // An unreadable or invalid compose file means "no Docker information".
        return graph;
      }
      break;
    }
  }

  if (
    !composeData ||
    typeof composeData !== "object" ||
    !composeData.services ||
    typeof composeData.services !== "object"
  ) {
    return graph;
  }

  // Parse each service
  for (const [serviceName, serviceConfig] of Object.entries(composeData.services)) {
    const config = (serviceConfig ?? {}) as any;
    if (typeof config !== "object") continue;

    const asText = (value: unknown): string | undefined =>
      value === undefined || value === null
        ? undefined
        : Array.isArray(value)
          ? value.join(" ")
          : String(value);

    const service: DockerService = {
      name: serviceName,
      dependsOn: [],
      volumes: [],
      entryPoint: asText(config.entrypoint),
      command: asText(config.command),
    };

    // Extract depends_on
    if (config.depends_on) {
      if (Array.isArray(config.depends_on)) {
        service.dependsOn = config.depends_on;
      } else if (typeof config.depends_on === "object") {
        service.dependsOn = Object.keys(config.depends_on);
      }
    }

    // Extract volumes
    if (config.volumes && Array.isArray(config.volumes)) {
      service.volumes = config.volumes
        .filter((v: string) => typeof v === "string")
        .map((v: string) => v.split(":")[0]);
    }

    // Entry point paths are relative to the build context: make them relative to the project.
    const buildContext =
      typeof config.build === "string" ? config.build : config.build?.context ?? (config.build ? "." : null);
    const inContext = (entryFile: string): string =>
      typeof buildContext === "string" && !entryFile.startsWith("/")
        ? posix.normalize(posix.join(buildContext.replace(/\\/g, "/"), entryFile))
        : entryFile;

    // Try to detect entry point file from docker-compose command / entrypoint
    for (const command of [config.command, config.entrypoint]) {
      if (!command || graph.entryPoints.has(serviceName)) continue;
      const entryFile = extractEntryPointFromCommand(
        Array.isArray(command) ? command.map(String) : String(command)
      );
      if (entryFile) {
        graph.entryPoints.set(serviceName, inContext(entryFile));
      }
    }

    // If no command in docker-compose, check Dockerfile
    if (!graph.entryPoints.has(serviceName) && typeof buildContext === "string") {
      const dockerfileName =
        typeof config.build === "object" && typeof config.build.dockerfile === "string"
          ? config.build.dockerfile
          : "Dockerfile";
      const entryFile = parseDockerfile(join(projectRoot, buildContext, dockerfileName));
      if (entryFile) {
        graph.entryPoints.set(serviceName, inContext(entryFile));
      }
    }

    graph.services.set(serviceName, service);
  }

  return graph;
}

/**
 * Find which services depend on a given service
 */
export function findDependentServices(
  graph: DockerDependencyGraph,
  serviceName: string
): string[] {
  const dependents: string[] = [];

  for (const [name, service] of graph.services) {
    if (service.dependsOn.includes(serviceName)) {
      dependents.push(name);
    }
  }

  return dependents;
}

/**
 * Calculate blast radius for a service failure
 */
export function calculateServiceBlastRadius(
  graph: DockerDependencyGraph,
  serviceName: string
): string[] {
  const affected = new Set<string>();
  const queue = [serviceName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (affected.has(current)) continue;

    affected.add(current);

    // Find services that depend on this one
    const dependents = findDependentServices(graph, current);
    queue.push(...dependents);
  }

  return Array.from(affected);
}

/**
 * True when `changedFile` (relative to the project root) is the file an entry
 * point refers to. Entry points may be written relative to a container
 * working directory, so a path-segment suffix match in either direction counts.
 */
export function matchesEntryPoint(changedFile: string, entryPoint: string): boolean {
  const changed = changedFile.replace(/\\/g, "/").replace(/^\.\//, "");
  const entry = entryPoint.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!changed || !entry) return false;
  return changed === entry || changed.endsWith(`/${entry}`) || entry.endsWith(`/${changed}`);
}
