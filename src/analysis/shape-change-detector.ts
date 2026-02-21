/**
 * Data shape changes
 *
 * A "breaking property change" is a property that a function's returned
 * object/dict literal no longer contains (or whose literal type changed) while
 * callers of that function still read it. Detection lives in
 * `findReturnShapeBreaks` in src/commands/impact.ts, which compares the version
 * of each changed function in HEAD with the working tree.
 */

export interface BreakingPropertyChange {
  propertyPath: string;
  changeType: "removed" | "typeChanged";
  functionName: string;
  filePath: string;
  line: number;
  oldType?: string;
  newType?: string;
  accessLocations: Array<{
    functionName: string;
    file: string;
    line: number;
    scopeId: string;
  }>;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}
