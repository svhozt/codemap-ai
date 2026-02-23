import { useEffect, useState, useCallback } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  BackgroundVariant,
  MiniMap,
  MarkerType,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ImpactNode, ImpactData } from '../types';
import { getLayoutedElements, getSeverityColor } from '../lib/graph-layout';
import { fileName } from '../lib/paths';
import { AlertCircle, GitBranch } from 'lucide-react';
import { cn } from '../lib/utils';

interface Props {
  data: ImpactData;
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string | null) => void;
}

// React Flow requires node data to be an index-signature record.
type FunctionNodeData = ImpactNode & { selected?: boolean } & Record<string, unknown>;
type FunctionFlowNode = Node<FunctionNodeData, 'functionNode'>;

function FunctionNode({ data }: NodeProps<FunctionFlowNode>) {
  const severityColor = getSeverityColor(data.severity);

  return (
    <div
      className={cn(
        'px-4 py-3 rounded-xl border-2 bg-slate-900 text-slate-100 shadow-lg transition-shadow',
        'w-[300px]',
        data.selected && 'ring-4 ring-blue-500/60'
      )}
      style={{ borderColor: severityColor }}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-500 !border-slate-300" />
      <div className="flex items-start gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: severityColor + '26' }}>
          {data.isChanged ? (
            <AlertCircle className="w-5 h-5" style={{ color: severityColor }} strokeWidth={2.5} />
          ) : (
            <GitBranch className="w-5 h-5" style={{ color: severityColor }} strokeWidth={2.5} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono font-bold text-sm truncate" title={data.name}>
              {data.name}()
            </span>
            {data.isChanged && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 font-bold">
                MODIFIED
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400 truncate mb-2" title={data.filePath}>
            {fileName(data.filePath)}:{data.line}
          </div>
          <div className="flex gap-2 items-center">
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded border"
              style={{ color: severityColor, borderColor: severityColor, backgroundColor: severityColor + '1a' }}
            >
              {data.severity}
            </span>
            <span className="text-xs text-slate-400" title="callers / callees in the whole project">
              ↑ {data.callerCount} · ↓ {data.calleeCount}
            </span>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500 !border-slate-300" />
    </div>
  );
}

const nodeTypes = {
  functionNode: FunctionNode,
};

function Graph({ data, selectedNodeId, onNodeSelect }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FunctionFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { fitView } = useReactFlow();

  // Layout once per data set
  useEffect(() => {
    let cancelled = false;
    async function layoutGraph() {
      setIsLoading(true);

      const initialNodes: FunctionFlowNode[] = data.nodes.map((n) => ({
        id: n.id,
        type: 'functionNode',
        data: { ...n },
        position: { x: 0, y: 0 },
      }));

      const nodeIds = new Set(data.nodes.map((n) => n.id));
      const initialEdges: Edge[] = data.edges
        .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
        .map((e) => {
          const color = e.isOnCriticalPath ? '#60a5fa' : '#64748b';
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            type: 'smoothstep',
            animated: e.isOnCriticalPath,
            style: { strokeWidth: 2, stroke: color },
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
          };
        });

      const layouted = await getLayoutedElements(initialNodes, initialEdges, {
        direction: 'TB',
        spacing: { node: 60, rank: 120 },
      });
      if (cancelled) return;

      setNodes(layouted.nodes);
      setEdges(layouted.edges);
      setIsLoading(false);
    }

    layoutGraph();
    return () => {
      cancelled = true;
    };
  }, [data, setNodes, setEdges]);

  // Highlight the selected node and its edges, and bring it into view
  useEffect(() => {
    setNodes((current) =>
      current.map((node) =>
        node.data.selected === (node.id === selectedNodeId)
          ? node
          : { ...node, data: { ...node.data, selected: node.id === selectedNodeId } }
      )
    );
    setEdges((current) =>
      current.map((edge) => {
        const touches = selectedNodeId !== null && (edge.source === selectedNodeId || edge.target === selectedNodeId);
        return { ...edge, style: { ...edge.style, opacity: selectedNodeId && !touches ? 0.25 : 1 } };
      })
    );
    if (selectedNodeId) {
      fitView({ nodes: [{ id: selectedNodeId }], duration: 400, maxZoom: 1.2 });
    }
  }, [selectedNodeId, setNodes, setEdges, fitView, isLoading]);

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
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.05}
        maxZoom={1.5}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="#334155" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(node) => getSeverityColor((node.data as FunctionNodeData).severity)}
          maskColor="rgba(2, 6, 23, 0.7)"
          pannable
          zoomable
        />
      </ReactFlow>
    </div>
  );
}

export function ImpactGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
