import type { ImpactData } from '../types';
import { getSeverityColor } from '../lib/graph-layout';
import { FileCode, AlertCircle, GitBranch, ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';
import { relativePath } from '../lib/paths';

interface Props {
  data: ImpactData;
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string) => void;
}

export function Sidebar({ data, selectedNodeId, onNodeSelect }: Props) {
  const nodesByFile = data.nodes.reduce((acc, node) => {
    if (!acc[node.filePath]) {
      acc[node.filePath] = [];
    }
    acc[node.filePath].push(node);
    return acc;
  }, {} as Record<string, typeof data.nodes>);

  return (
    <div className="w-80 bg-slate-950 overflow-y-auto border-r border-slate-800">
      {/* Simple Header */}
      <div className="p-4 border-b border-slate-800">
        <div className="flex items-center gap-2 mb-1">
          <FileCode className="w-4 h-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-100">Impact Analysis</h2>
        </div>
        <p className="text-xs text-slate-500">
          {Object.keys(nodesByFile).length} files • {data.nodes.length} functions
        </p>
      </div>

      <div className="p-3 space-y-3">
        {/* Statistics */}
        <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-800">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-3.5 h-3.5 text-slate-400" />
            <h3 className="text-xs font-semibold text-slate-100">Severity</h3>
          </div>
          <div className="space-y-1.5">
            {Object.entries(data.statistics.bySeverity).map(([severity, count]) => {
              if (count === 0) return null;
              const color = getSeverityColor(severity);
              return (
                <div key={severity} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-xs text-slate-300">{severity}</span>
                  </div>
                  <span className="text-xs font-semibold text-slate-100 px-1.5 py-0.5 bg-slate-800 rounded">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Files & Functions */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1">
            <GitBranch className="w-3.5 h-3.5 text-slate-500" />
            <h3 className="text-xs font-semibold text-slate-100">Affected Files</h3>
          </div>

          {Object.entries(nodesByFile).map(([filePath, nodes]) => {
            const displayPath = relativePath(filePath, data.analysisPath);
            const highestSeverity = nodes.reduce((max, node) => {
              const severities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
              const maxIdx = severities.indexOf(max);
              const nodeIdx = severities.indexOf(node.severity);
              return nodeIdx > maxIdx ? node.severity : max;
            }, 'LOW');
            const severityColor = getSeverityColor(highestSeverity);

            return (
              <div
                key={filePath}
                className="rounded-lg overflow-hidden bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-colors"
              >
                {/* File Header */}
                <div
                  className="px-2.5 py-2 bg-slate-900 border-l-2 flex items-center gap-2"
                  style={{ borderLeftColor: severityColor }}
                >
                  <FileCode className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                  <span
                    className="text-xs font-medium text-slate-200 truncate flex-1"
                    title={displayPath}
                    style={{ direction: 'rtl', textAlign: 'left' }}
                  >
                    {displayPath}
                  </span>
                  <div
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: severityColor }}
                  />
                </div>

                {/* Functions List */}
                <div>
                  {nodes.map(node => (
                    <button
                      key={node.id}
                      onClick={() => onNodeSelect(node.id)}
                      className={cn(
                        'w-full px-2.5 py-2 text-left hover:bg-slate-800/70 transition-colors border-l-2',
                        selectedNodeId === node.id
                          ? 'bg-blue-950/30 border-blue-500'
                          : 'border-transparent'
                      )}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        {node.isChanged ? (
                          <AlertCircle className="w-3 h-3 text-red-400 flex-shrink-0" strokeWidth={2.5} />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />
                        )}
                        <span className="text-xs font-mono font-medium text-slate-200 truncate">
                          {node.name}()
                        </span>
                        {node.isChanged && (
                          <span className="text-[10px] px-1 py-0.5 bg-red-500/20 text-red-400 rounded font-bold">
                            MOD
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-5">
                        <span className="text-[10px] text-slate-500">L{node.line}</span>
                        <span
                          className="text-[10px] px-1 py-0.5 rounded font-bold"
                          style={{
                            backgroundColor: getSeverityColor(node.severity) + '20',
                            color: getSeverityColor(node.severity),
                          }}
                        >
                          {node.severity}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
