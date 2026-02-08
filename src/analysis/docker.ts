/**
 * Docker Compose dependency analyzer
 * Parses docker-compose files and Dockerfiles to build service dependency graph
 */

import { readFileSync, existsSync } from "fs";
import { load as parseYaml } from "js-yaml";
import { join } from "path";

/**
 * Parse Dockerfile to extract CMD or ENTRYPOINT
 */
function parseDockerfile(dockerfilePath: string): string | null {
  if (!existsSync(dockerfilePath)) {
    return null;
  }

  const content = readFileSync(dockerfilePath, "utf-8");
  const lines = content.split("\n");

  // Look for CMD or ENTRYPOINT (skip HEALTHCHECK lines)
  let inHealthCheck = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Track if we're in a HEALTHCHECK block
    if (line.includes("HEALTHCHECK")) {
      inHealthCheck = true;
      continue;
    }

    // If we were in a HEALTHCHECK and this line doesn't continue it, exit HEALTHCHECK mode
    if (inHealthCheck && !line.startsWith(" ") && !line.startsWith("\t")) {
      inHealthCheck = false;
    }

    // Skip CMD lines that are part of HEALTHCHECK
    if (inHealthCheck) {
      continue;
    }

    // CMD ["node", "server.js"]
    if (trimmed.startsWith("CMD")) {
      const match = trimmed.match(/CMD\s+\[([^\]]+)\]/);
      if (match) {
        const parts = match[1].split(",").map((p) => p.trim().replace(/"/g, ""));
        const commandStr = parts.join(" ");
        return extractEntryPointFromCommand(commandStr);
      }

      // CMD node server.js
      const shellMatch = trimmed.match(/CMD\s+(.+)/);
      if (shellMatch) {
        return extractEntryPointFromCommand(shellMatch[1]);
      }
    }

    // ENTRYPOINT ["node", "server.js"]
    if (trimmed.startsWith("ENTRYPOINT")) {
      const match = trimmed.match(/ENTRYPOINT\s+\[([^\]]+)\]/);
      if (match) {
        const parts = match[1].split(",").map((p) => p.trim().replace(/"/g, ""));
        const commandStr = parts.join(" ");
        return extractEntryPointFromCommand(commandStr);
      }
    }
  }

  return null;
}

/**
 * Extract entry point file from a command string
 */
function extractEntryPointFromCommand(command: string | string[]): string | null {
  const commandStr = Array.isArray(command) ? command.join(" ") : command;

  // Match patterns like: node server.js, python -m backend.api, uvicorn main:app
  const patterns = [
    /node\s+([^\s]+\.js)/,
    /python\s+-m\s+([\w.]+)/,
    /python\s+([^\s]+\.py)/,
    /uvicorn\s+([\w:]+)/,
    /npm\s+start/,
  ];

  for (const pattern of patterns) {
    const match = commandStr.match(pattern);
    if (match) {
      const entryFile = match[1];

      // Convert to file path
      if (entryFile.endsWith(".js") || entryFile.endsWith(".py")) {
        return entryFile;
      } else if (entryFile.includes(":")) {
        // uvicorn main:app -> main.py
        const file = entryFile.split(":")[0];
        return `${file}.py`;
      } else {
        // python -m backend.api -> backend/api.py
        const file = entryFile.replace(/\./g, "/");
        return `${file}.py`;
      }
    }
  }

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
      const content = readFileSync(file, "utf-8");
      composeData = parseYaml(content) as any;
      break;
    }
  }

  if (!composeData || !composeData.services) {
    return graph;
  }

  // Parse each service
  for (const [serviceName, serviceConfig] of Object.entries(composeData.services)) {
    const config = serviceConfig as any;

    const service: DockerService = {
      name: serviceName,
      dependsOn: [],
      volumes: [],
      entryPoint: config.entrypoint,
      command: config.command,
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

    // Try to detect entry point file from docker-compose command
    if (config.command) {
      const entryFile = extractEntryPointFromCommand(config.command);
      if (entryFile) {
        graph.entryPoints.set(serviceName, entryFile);
      }
    }

    // If no command in docker-compose, check Dockerfile
    if (!graph.entryPoints.has(serviceName) && config.build) {
      const buildContext = typeof config.build === "string" ? config.build : config.build.context;
      if (buildContext) {
        const dockerfilePath = join(projectRoot, buildContext, "Dockerfile");
        const entryFile = parseDockerfile(dockerfilePath);
        if (entryFile) {
          graph.entryPoints.set(serviceName, entryFile);
        }
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
