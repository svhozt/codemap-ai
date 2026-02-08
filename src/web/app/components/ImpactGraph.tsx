import React, { useEffect, useState, useCallback } from 'react';
import {
  ReactFlow,
  Node,
  Edge,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  MiniMap,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ImpactNode, ImpactData } from '../types';
import { getLayoutedElements, getSeverityColor } from '../lib/graph-layout';
import { Badge } from './ui/badge';
import { AlertCircle, GitBranch, ArrowDown } from 'lucide-react';
import { cn } from '../lib/utils';

interface Props {
  data: ImpactData;
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string | null) => void;
}

function FunctionNode({ data }: { data: ImpactNode }) {
  const severityColor = getSeverityColor(data.severity);
  const bgGradient = data.isChanged
    ? 'from-red-50 via-red-100 to-red-50 dark:from-red-950 dark:via-red-900 dark:to-red-950'
    : data.severity === 'HIGH'
    ? 'from-orange-50 via-orange-100 to-orange-50 dark:from-orange-950 dark:via-orange-900 dark:to-orange-950'
    : 'from-blue-50 via-blue-100 to-blue-50 dark:from-blue-950 dark:via-blue-900 dark:to-blue-950';

  return (
    <div
      className={cn(
        'px-6 py-5 rounded-2xl border-2 bg-gradient-to-br shadow-lg hover:shadow-xl transition-all duration-200',
        'min-w-[280px] max-w-[320px]',
        bgGradient
      )}
      style={{ borderColor: severityColor, borderWidth: '3px' }}
    >
      <div className="flex items-start gap-3">
        <div
          className="rounded-xl p-2.5 shadow-sm"
          style={{ backgroundColor: severityColor + '25' }}
        >
          {data.isChanged ? (
            <AlertCircle className="w-6 h-6" style={{ color: severityColor }} strokeWidth={2.5} />
          ) : (
            <GitBranch className="w-6 h-6" style={{ color: severityColor }} strokeWidth={2.5} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono font-bold text-base truncate">{data.name}()</span>
            {data.isChanged && (
              <Badge variant="destructive" className="text-xs px-2 py-0.5">
                Modified
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate mb-3">
            📄 {data.filePath.split('/').pop()}:{data.line}
          </div>
          <div className="flex gap-2 items-center">
            <Badge
              variant="outline"
              className="text-xs font-bold px-2 py-1"
              style={{
                backgroundColor: severityColor + '15',
                borderColor: severityColor,
                color: severityColor,
                borderWidth: '2px'
              }}
            >
              {data.severity}
            </Badge>
            <div className="text-xs text-muted-foreground font-medium">
              <span className="inline-flex items-center gap-1">
                ↑ {data.callerCount} • ↓ {data.calleeCount}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  functionNode: FunctionNode,
};

export function ImpactGraph({ data, selectedNodeId, onNodeSelect }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function layoutGraph() {
      setIsLoading(true);

      const initialNodes: Node[] = data.nodes.map((n) => ({
        id: n.id,
        type: 'functionNode',
        data: n,
        position: { x: 0, y: 0 },
      }));

      const initialEdges: Edge[] = data.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        animated: e.isOnCriticalPath,
        style: {
          strokeWidth: 3,
          stroke: e.isOnCriticalPath ? '#3b82f6' : '#64748b',
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: e.isOnCriticalPath ? '#3b82f6' : '#64748b',
          width: 25,
          height: 25,
        },
        label: e.isOnCriticalPath ? 'calls' : undefined,
        labelStyle: {
          fontSize: 11,
          fontWeight: 600,
          fill: '#3b82f6',
        },
        labelBgStyle: {
          fill: '#eff6ff',
          fillOpacity: 0.9,
        },
      }));

      const { nodes: layoutedNodes, edges: layoutedEdges } = await getLayoutedElements(
        initialNodes,
        initialEdges,
        {
          direction: 'TB',
          spacing: { node: 200, rank: 300 },
        }
      );

      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
      setIsLoading(false);
    }

    layoutGraph();
  }, [data, setNodes, setEdges]);

  const onNodeClickHandler = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeSelect(node.id);
    },
    [onNodeSelect]
  );

  const onPaneClick = useCallback(() => {
    onNodeSelect(null);
  }, [onNodeSelect]);

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-slate-900">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent"></div>
          <div className="text-center">
            <p className="text-sm text-slate-100 font-semibold">Calculating Impact Flow</p>
            <p className="text-xs text-slate-400 mt-1">Analyzing call graph...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-slate-900">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClickHandler}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={1.5}
        defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={2}
          color="#94a3b8"
        />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(node) => {
            const data = node.data as ImpactNode;
            return getSeverityColor(data.severity);
          }}
          className="border-2 border-border shadow-lg"
          maskColor="rgb(240, 240, 240, 0.6)"
        />
      </ReactFlow>
    </div>
  );
}
