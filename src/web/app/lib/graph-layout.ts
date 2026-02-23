import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';

export interface LayoutOptions {
  direction?: 'TB' | 'LR';
  spacing?: {
    node?: number;
    rank?: number;
  };
}

/** Rendered size of a function node (see ImpactGraph). */
const NODE_WIDTH = 300;
const NODE_HEIGHT = 110;

export async function getLayoutedElements<N extends Node>(
  nodes: N[],
  edges: Edge[],
  options: LayoutOptions = {}
): Promise<{ nodes: N[]; edges: Edge[] }> {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: options.direction || 'TB',
    ranksep: options.spacing?.rank ?? 120,
    nodesep: options.spacing?.node ?? 60,
    edgesep: 20,
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    dagreGraph.setEdge(edge.source, edge.target);
  }

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const position = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: position.x - NODE_WIDTH / 2,
        y: position.y - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

export function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
      return '#ef4444'; // red-500
    case 'HIGH':
      return '#f97316'; // orange-500
    case 'MEDIUM':
      return '#eab308'; // yellow-500
    case 'LOW':
      return '#22c55e'; // green-500
    default:
      return '#6b7280'; // gray-500
  }
}
