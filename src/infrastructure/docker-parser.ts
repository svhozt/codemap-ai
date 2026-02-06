/**
 * Docker Compose Parser
 * Parses docker-compose.yaml to extract services, dependencies, and connections
 */

import { readFileSync } from "fs";
import { load as yamlLoad } from "js-yaml";
import { resolve } from "path";

export interface DockerService {
  name: string;
  image?: string;
  build?: {
    context: string;
    dockerfile?: string;
  };
  ports: Array<{ host: number | string; container: number | string }>;
  environment: Record<string, string>;
  depends_on: string[];
  networks: string[];
  volumes: string[];
}

export interface ServiceConnection {
  from: string;
  to: string;
  type: "dependency" | "network" | "environment";
  detail?: string;
}

export class DockerComposeParser {
  private services: Map<string, DockerService> = new Map();

  parse(yamlPath: string): DockerService[] {
    const fullPath = resolve(yamlPath);
    const content = readFileSync(fullPath, "utf-8");
    const doc = yamlLoad(content) as any;

    if (!doc.services) {
      throw new Error("No services found in docker-compose file");
    }

    // Parse each service
    for (const [serviceName, serviceConfig] of Object.entries(doc.services)) {
      const config = serviceConfig as any;

      const service: DockerService = {
        name: serviceName,
        image: config.image,
        build: config.build ? {
          context: config.build.context || config.build,
          dockerfile: config.build.dockerfile,
        } : undefined,
        ports: this.parsePorts(config.ports || []),
        environment: this.parseEnvironment(config.environment || {}),
        depends_on: this.parseDependsOn(config.depends_on || []),
        networks: this.parseNetworks(config.networks || []),
        volumes: config.volumes || [],
      };

      this.services.set(serviceName, service);
    }

    return Array.from(this.services.values());
  }

  private parsePorts(ports: any[]): Array<{ host: number | string; container: number | string }> {
    const result: Array<{ host: number | string; container: number | string }> = [];

    for (const port of ports) {
      if (typeof port === "string") {
        const parts = port.split(":");
        if (parts.length === 2) {
          result.push({
            host: this.parsePortNumber(parts[0]),
            container: this.parsePortNumber(parts[1]),
          });
        } else if (parts.length === 1) {
          const p = this.parsePortNumber(parts[0]);
          result.push({ host: p, container: p });
        }
      } else if (typeof port === "number") {
        result.push({ host: port, container: port });
      }
    }

    return result;
  }

  private parsePortNumber(port: string): number | string {
    const num = parseInt(port, 10);
    return isNaN(num) ? port : num;
  }

  private parseEnvironment(env: any): Record<string, string> {
    if (Array.isArray(env)) {
      // Format: ["KEY=value", "KEY2=value2"]
      const result: Record<string, string> = {};
      for (const item of env) {
        const [key, ...valueParts] = item.split("=");
        result[key] = valueParts.join("=");
      }
      return result;
    } else if (typeof env === "object") {
      // Format: { KEY: "value", KEY2: "value2" }
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        result[key] = String(value);
      }
      return result;
    }
    return {};
  }

  private parseDependsOn(deps: any): string[] {
    if (Array.isArray(deps)) {
      return deps;
    } else if (typeof deps === "object") {
      // Format: { service1: { condition: "service_started" } }
      return Object.keys(deps);
    }
    return [];
  }

  private parseNetworks(networks: any): string[] {
    if (Array.isArray(networks)) {
      return networks;
    } else if (typeof networks === "object") {
      return Object.keys(networks);
    }
    return ["default"];
  }

  /**
   * Analyze connections between services based on:
   * - depends_on relationships
   * - Environment variables pointing to other services
   * - Shared networks
   */
  extractServiceConnections(): ServiceConnection[] {
    const connections: ServiceConnection[] = [];

    for (const [serviceName, service] of this.services) {
      // 1. depends_on relationships
      for (const dep of service.depends_on) {
        connections.push({
          from: serviceName,
          to: dep,
          type: "dependency",
          detail: "depends_on",
        });
      }

      // 2. Environment variables that reference other services
      for (const [envKey, envValue] of Object.entries(service.environment)) {
        // Look for service names in env values (e.g., "mongodb://mongodb:27017")
        for (const otherServiceName of this.services.keys()) {
          if (serviceName !== otherServiceName && envValue.includes(otherServiceName)) {
            connections.push({
              from: serviceName,
              to: otherServiceName,
              type: "environment",
              detail: `${envKey}=${envValue}`,
            });
          }
        }
      }

      // 3. Network connections (services on same network can communicate)
      for (const [otherServiceName, otherService] of this.services) {
        if (serviceName !== otherServiceName) {
          const sharedNetworks = service.networks.filter(n => otherService.networks.includes(n));
          if (sharedNetworks.length > 0) {
            connections.push({
              from: serviceName,
              to: otherServiceName,
              type: "network",
              detail: sharedNetworks.join(", "),
            });
          }
        }
      }
    }

    // Deduplicate connections
    const unique = new Map<string, ServiceConnection>();
    for (const conn of connections) {
      const key = `${conn.from}->${conn.to}:${conn.type}`;
      if (!unique.has(key)) {
        unique.set(key, conn);
      }
    }

    return Array.from(unique.values());
  }

  /**
   * Get service by name
   */
  getService(name: string): DockerService | undefined {
    return this.services.get(name);
  }

  /**
   * Get all services
   */
  getAllServices(): DockerService[] {
    return Array.from(this.services.values());
  }
}
