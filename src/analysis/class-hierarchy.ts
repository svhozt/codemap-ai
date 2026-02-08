/**
 * Class Hierarchy Builder
 * Builds inheritance trees for improved method resolution
 */

import type { FlowNode } from "../graph/types.js";

export interface ClassNode {
  id: string;              // Node ID
  name: string;            // Class name
  file: string;            // File path
  line: number;            // Start line
  extends: string[];       // Parent class names
  methods: string[];       // Method names defined in this class
}

export interface ClassHierarchy {
  classes: Map<string, ClassNode>;           // class_name -> ClassNode
  children: Map<string, string[]>;           // parent_name -> [child_name, ...]
  parents: Map<string, string[]>;            // child_name -> [parent_name, ...]
}

/**
 * Build class hierarchy from flow nodes
 */
export function buildClassHierarchy(nodes: FlowNode[]): ClassHierarchy {
  const classes = new Map<string, ClassNode>();
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();

  // Step 1: Collect all class nodes
  for (const node of nodes) {
    if (node.type === "class") {
      const classNode: ClassNode = {
        id: node.id,
        name: node.name,
        file: node.filePath,
        line: node.startLine,
        extends: node.extends || [],
        methods: [], // Will populate in next step
      };

      classes.set(node.name, classNode);
    }
  }

  // Step 2: Find methods for each class
  for (const node of nodes) {
    if (node.type === "method" && node.parentClass) {
      const classNode = classes.get(node.parentClass);
      if (classNode) {
        classNode.methods.push(node.name);
      }
    }
  }

  // Step 3: Build parent-child relationships
  for (const [className, classNode] of classes) {
    for (const parentName of classNode.extends) {
      // Add to children map (parent -> children)
      if (!children.has(parentName)) {
        children.set(parentName, []);
      }
      children.get(parentName)!.push(className);

      // Add to parents map (child -> parents)
      if (!parents.has(className)) {
        parents.set(className, []);
      }
      parents.get(className)!.push(parentName);
    }
  }

  return {
    classes,
    children,
    parents,
  };
}

/**
 * Get all methods available for a class (including inherited)
 */
export function getAvailableMethods(
  className: string,
  hierarchy: ClassHierarchy
): string[] {
  const methods = new Set<string>();
  const visited = new Set<string>();

  // BFS up the inheritance chain
  const queue = [className];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    // Add methods from current class
    const classNode = hierarchy.classes.get(current);
    if (classNode) {
      for (const method of classNode.methods) {
        methods.add(method);
      }

      // Add parent classes to queue
      const parentNames = hierarchy.parents.get(current) || [];
      for (const parent of parentNames) {
        queue.push(parent);
      }
    }
  }

  return Array.from(methods);
}

/**
 * Find which class defines a method (searching up inheritance chain)
 */
export function findMethodDefinition(
  className: string,
  methodName: string,
  hierarchy: ClassHierarchy
): ClassNode | null {
  const visited = new Set<string>();
  const queue = [className];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const classNode = hierarchy.classes.get(current);
    if (classNode) {
      // Check if this class defines the method
      if (classNode.methods.includes(methodName)) {
        return classNode;
      }

      // Search parent classes
      const parentNames = hierarchy.parents.get(current) || [];
      for (const parent of parentNames) {
        queue.push(parent);
      }
    }
  }

  return null;
}

/**
 * Check if a class inherits from another class
 */
export function inheritsFrom(
  childClass: string,
  parentClass: string,
  hierarchy: ClassHierarchy
): boolean {
  const visited = new Set<string>();
  const queue = [childClass];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (current === parentClass) {
      return true;
    }

    // Check parents
    const parentNames = hierarchy.parents.get(current) || [];
    for (const parent of parentNames) {
      queue.push(parent);
    }
  }

  return false;
}

/**
 * Get all descendants of a class
 */
export function getDescendants(
  className: string,
  hierarchy: ClassHierarchy
): string[] {
  const descendants: string[] = [];
  const visited = new Set<string>();
  const queue = [className];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    // Add children
    const childNames = hierarchy.children.get(current) || [];
    for (const child of childNames) {
      descendants.push(child);
      queue.push(child);
    }
  }

  return descendants;
}

/**
 * Get the full inheritance chain for a class
 */
export function getInheritanceChain(
  className: string,
  hierarchy: ClassHierarchy
): string[] {
  const chain: string[] = [className];
  const visited = new Set<string>();
  let current = className;

  while (true) {
    if (visited.has(current)) {
      break;
    }
    visited.add(current);

    const parentNames = hierarchy.parents.get(current) || [];
    if (parentNames.length === 0) {
      break;
    }

    // Take first parent (for simplicity, handle multiple inheritance later)
    const parent = parentNames[0];
    chain.push(parent);
    current = parent;
  }

  return chain;
}

/**
 * Resolve method call on a class instance
 * Returns the class node that defines the method
 */
export function resolveMethodCall(
  instanceType: string,
  methodName: string,
  hierarchy: ClassHierarchy
): ClassNode | null {
  return findMethodDefinition(instanceType, methodName, hierarchy);
}

/**
 * Get statistics about class hierarchy
 */
export function getHierarchyStats(hierarchy: ClassHierarchy): {
  totalClasses: number;
  classesWithParents: number;
  classesWithChildren: number;
  maxDepth: number;
} {
  const totalClasses = hierarchy.classes.size;
  const classesWithParents = hierarchy.parents.size;
  const classesWithChildren = hierarchy.children.size;

  // Calculate max depth
  let maxDepth = 0;
  for (const className of hierarchy.classes.keys()) {
    const chain = getInheritanceChain(className, hierarchy);
    maxDepth = Math.max(maxDepth, chain.length);
  }

  return {
    totalClasses,
    classesWithParents,
    classesWithChildren,
    maxDepth,
  };
}
