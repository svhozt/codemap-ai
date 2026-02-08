/**
 * Removed Call Impact Analyzer
 * Calculates the impact of removed function calls using the call graph
 */

import type { FlowStorage } from '../flow/storage.js';
import type { RemovedCall } from './removed-calls.js';

export interface RemovedCallImpact {
  removedCall: RemovedCall;

  // Direct impact
  functionNode?: {
    id: string;
    name: string;
    file: string;
    line: number;
  };

  // Is this function still called elsewhere?
  stillCalledBy: Array<{
    name: string;
    file: string;
    line: number;
  }>;

  // Propagated impact: all functions that depend on removedFrom
  impactedFunctions: Array<{
    name: string;
    file: string;
    line: number;
    reason: string;
  }>;

  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
}

/**
 * Security/validation keywords that trigger CRITICAL severity
 */
const SECURITY_KEYWORDS = [
  // Authentication & Authorization
  'authenticate', 'authorization', 'authorize', 'login', 'logout',
  'signin', 'signout', 'verify', 'check', 'validate', 'permission',
  'access', 'role', 'admin', 'auth',

  // Input validation & sanitization
  'sanitize', 'escape', 'clean', 'filter', 'whitelist', 'blacklist',
  'validate', 'verification', 'check',

  // Security tokens & sessions
  'token', 'session', 'cookie', 'csrf', 'xsrf', 'jwt', 'oauth',
  'api_key', 'apikey', 'secret', 'password', 'hash', 'encrypt',

  // Injection prevention
  'xss', 'sql', 'injection', 'query', 'prepared', 'statement',

  // Rate limiting & abuse prevention
  'ratelimit', 'throttle', 'captcha', 'honeypot',
];

/**
 * Analyze the impact of removed function calls
 */
export function analyzeRemovedCallImpact(
  removedCalls: RemovedCall[],
  storage: FlowStorage
): RemovedCallImpact[] {
  const impacts: RemovedCallImpact[] = [];

  for (const removedCall of removedCalls) {
    try {
      const impact = analyzeSingleRemovedCall(removedCall, storage);
      if (impact) {
        impacts.push(impact);
      }
    } catch (error) {
      // Log error but continue processing other calls
      console.error(`Error analyzing removed call ${removedCall.callee}:`, error);
    }
  }

  return impacts;
}

/**
 * Analyze a single removed call
 */
function analyzeSingleRemovedCall(
  removedCall: RemovedCall,
  storage: FlowStorage
): RemovedCallImpact | null {
  // Step 1: Find the function node in call graph
  const nodes = storage.searchNodesByName(removedCall.callee);

  if (nodes.length === 0) {
    // Function not in graph (might be external library or not indexed)
    return null;
  }

  const functionNode = nodes[0];

  // Step 2: Check if function is still called elsewhere
  const allCallers = storage.getResolvedCallers(functionNode.id);
  const stillCalledBy = allCallers
    .filter(c => c.name !== removedCall.removedFrom)
    .map(c => ({
      name: c.name,
      file: c.filePath,
      line: c.startLine,
    }));

  // Step 3: Find all functions that call removedFrom
  // (These are the functions that are now affected)
  const removedFromNodes = storage.searchNodesByName(removedCall.removedFrom);

  let impactedFunctions: Array<{
    name: string;
    file: string;
    line: number;
    reason: string;
  }> = [];

  if (removedFromNodes.length > 0) {
    const removedFromNode = removedFromNodes[0];

    // Get all functions that depend on removedFrom
    // Use BFS with depth limit to prevent explosion
    const impactedNodes = storage.getImpactedNodes(removedFromNode.id, 5);

    impactedFunctions = impactedNodes.map(n => ({
      name: n.name,
      file: n.filePath,
      line: n.startLine,
      reason: `Calls ${removedCall.removedFrom}() which no longer calls ${removedCall.callee}()`,
    }));
  }

  // Step 4: Calculate severity
  const severity = calculateSeverity(
    removedCall,
    stillCalledBy,
    impactedFunctions
  );

  // Step 5: Build description
  const description = buildImpactDescription(
    removedCall,
    stillCalledBy,
    impactedFunctions,
    severity
  );

  return {
    removedCall,
    functionNode: {
      id: functionNode.id,
      name: functionNode.name,
      file: functionNode.filePath,
      line: functionNode.startLine,
    },
    stillCalledBy,
    impactedFunctions,
    severity,
    description,
  };
}

/**
 * Calculate severity based on impact
 */
function calculateSeverity(
  removedCall: RemovedCall,
  stillCalledBy: Array<{ name: string }>,
  impactedFunctions: Array<{ name: string }>
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  // Check if this is a security/validation function
  const isSecurityFunction = SECURITY_KEYWORDS.some(keyword =>
    removedCall.callee.toLowerCase().includes(keyword)
  );

  // CRITICAL: Security function removed and has significant impact
  if (isSecurityFunction && impactedFunctions.length > 5) {
    return 'CRITICAL';
  }

  // CRITICAL: Security function removed and now orphaned
  if (isSecurityFunction && stillCalledBy.length === 0) {
    return 'CRITICAL';
  }

  // HIGH: Function is now orphaned (not called anywhere)
  if (stillCalledBy.length === 0) {
    return 'HIGH';
  }

  // HIGH: Large impact (>20 impacted functions)
  if (impactedFunctions.length > 20) {
    return 'HIGH';
  }

  // MEDIUM: Moderate impact (10-20 impacted functions)
  if (impactedFunctions.length >= 10) {
    return 'MEDIUM';
  }

  // MEDIUM: Security function with any impact
  if (isSecurityFunction && impactedFunctions.length > 0) {
    return 'MEDIUM';
  }

  // LOW: Small impact (<10 impacted functions)
  return 'LOW';
}

/**
 * Build human-readable impact description
 */
function buildImpactDescription(
  removedCall: RemovedCall,
  stillCalledBy: Array<{ name: string; file: string }>,
  impactedFunctions: Array<{ name: string }>,
  severity: string
): string {
  const parts: string[] = [];

  // Main statement
  parts.push(
    `${removedCall.callee}() was removed from ${removedCall.removedFrom}() at line ${removedCall.lineNumber}`
  );

  // Orphaned warning
  if (stillCalledBy.length === 0) {
    parts.push(`⚠️ ORPHANED: ${removedCall.callee}() is no longer called anywhere in the codebase`);
  } else {
    // Still called by others
    const callerNames = stillCalledBy.slice(0, 3).map(c => c.name).join(', ');
    const moreCount = stillCalledBy.length > 3 ? ` and ${stillCalledBy.length - 3} more` : '';
    parts.push(`Still called by: ${callerNames}${moreCount}`);
  }

  // Impact count
  if (impactedFunctions.length > 0) {
    parts.push(
      `Impact: ${impactedFunctions.length} function${impactedFunctions.length === 1 ? '' : 's'} ` +
      `depend on ${removedCall.removedFrom}()`
    );
  }

  // Security warning
  if (severity === 'CRITICAL') {
    parts.push('🔴 CRITICAL: Security or validation function removed from execution path');
  }

  return parts.join('\n');
}
