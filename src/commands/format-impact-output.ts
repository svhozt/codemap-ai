/**
 * Format Impact Analysis Output
 * CLI output formatting for impact analysis
 */

import { ImpactResult } from "./impact.js";
import { FlowStorage } from "../flow/storage.js";
import { analyzeDataFlowImpact } from "./impact-phase3.js";

/**
 * Format complete impact analysis output
 */
export async function formatImpactOutput(
  result: ImpactResult,
  storage: FlowStorage
): Promise<string> {
  let output = "\nCodeMap Impact Analysis\n\n";

  // Section 1: Modified Files
  if (result.changedFiles.length > 0) {
    output += `Modified Files:\n`;
    for (const file of result.changedFiles.slice(0, 10)) {
      output += `  • ${file}\n`;
    }
    if (result.changedFiles.length > 10) {
      output += `  ... and ${result.changedFiles.length - 10} more\n`;
    }
    output += "\n";
  }

  // Section 2: Removed Calls (Phase 1)
  if (result.removedCallImpacts.length > 0) {
    output += formatRemovedCallsSection(result);
  }

  // Section 3: Data Flow Changes (Phase 3)
  const dataFlowOutput = await analyzeDataFlowImpact(storage);
  output += dataFlowOutput;

  // Section 4: Risk Assessment
  output += formatRiskAssessment(result);

  return output;
}

/**
 * Format removed calls section
 */
function formatRemovedCallsSection(result: ImpactResult): string {
  let output = "🔴 Removed Function Calls:\n\n";

  for (const impact of result.removedCallImpacts.slice(0, 5)) {
    const severityIcon = getSeverityIcon(impact.severity);
    output += `  ${severityIcon} ${impact.removedCall}\n`;
    output += `     File: ${impact.filePath}:${impact.line}\n`;

    if (impact.callers.length > 0) {
      output += `     Affected callers: ${impact.callers.length}\n`;
      for (const caller of impact.callers.slice(0, 3)) {
        output += `       • ${caller.name} (${caller.file}:${caller.line})\n`;
      }
      if (impact.callers.length > 3) {
        output += `       ... and ${impact.callers.length - 3} more\n`;
      }
    }
    output += "\n";
  }

  if (result.removedCallImpacts.length > 5) {
    output += `  ... and ${result.removedCallImpacts.length - 5} more removed calls\n\n`;
  }

  return output;
}

/**
 * Format risk assessment
 */
function formatRiskAssessment(result: ImpactResult): string {
  let output = "\nRisk Assessment:\n";

  const icon = getRiskIcon(result.riskLevel);
  output += `  ${icon} ${result.riskLevel}`;

  if (result.riskLevel === "CRITICAL" || result.riskLevel === "HIGH") {
    output += " - Review carefully before deploying\n";
  } else if (result.riskLevel === "MEDIUM") {
    output += " - Test thoroughly\n";
  } else {
    output += " - Low risk changes\n";
  }

  return output;
}

/**
 * Get severity icon
 */
function getSeverityIcon(severity: string): string {
  switch (severity) {
    case "CRITICAL":
      return "🔴";
    case "HIGH":
      return "🟠";
    case "MEDIUM":
      return "🟡";
    default:
      return "🟢";
  }
}

/**
 * Get risk icon
 */
function getRiskIcon(risk: string): string {
  switch (risk) {
    case "CRITICAL":
      return "🔴 CRITICAL";
    case "HIGH":
      return "🟠 HIGH";
    case "MEDIUM":
      return "🟡 MEDIUM";
    default:
      return "🟢 LOW";
  }
}
