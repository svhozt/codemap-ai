export type SeverityLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface ImpactNode {
  id: string;
  name: string;
  filePath: string;
  line: number;
  type: "function" | "method" | "external";
  severity: SeverityLevel;
  isChanged: boolean;
  calleeCount: number;
  callerCount: number;
  propertiesAccessed?: string[];
  hasBreakingChanges?: boolean;
}

export interface ImpactEdge {
  id: string;
  source: string;
  target: string;
  type: "direct" | "indirect";
  isOnCriticalPath: boolean;
}

export interface ImpactData {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  changedFiles: string[];
  statistics: {
    totalAffected: number;
    bySeverity: Record<SeverityLevel, number>;
    byDepth: Record<number, number>;
    filesAffected: number;
  };
  timestamp: string;
  analysisPath: string;
}

export interface PropertyAccess {
  property: string;
  line: number;
  mayBreak: boolean;
}
