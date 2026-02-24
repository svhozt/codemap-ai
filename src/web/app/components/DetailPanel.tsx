import type { ImpactNode, ImpactData } from '../types';
import { getSeverityColor } from '../lib/graph-layout';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { relativePath, fileName } from '../lib/paths';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { X, AlertCircle, ArrowDownCircle, ArrowUpCircle, FileCode } from 'lucide-react';

interface Props {
  node: ImpactNode;
  data: ImpactData;
  onClose: () => void;
  onNavigate: (nodeId: string) => void;
}

function isNode(node: ImpactNode | undefined): node is ImpactNode {
  return node !== undefined;
}

export function DetailPanel({ node, data, onClose, onNavigate }: Props) {
  const severityColor = getSeverityColor(node.severity);

  const callees = data.edges
    .filter(e => e.source === node.id)
    .map(e => data.nodes.find(n => n.id === e.target))
    .filter(isNode);

  const callers = data.edges
    .filter(e => e.target === node.id)
    .map(e => data.nodes.find(n => n.id === e.source))
    .filter(isNode);

  return (
    <>
      {/* Backdrop overlay */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
        onClick={onClose}
      />

      {/* Modal popup */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-slate-950 border border-slate-800 rounded-xl shadow-2xl max-w-4xl w-full max-h-[80vh] overflow-y-auto pointer-events-auto">
          <div className="p-6">
        <div className="flex items-start justify-between mb-6">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <div
                className="p-3 rounded-xl"
                style={{ backgroundColor: severityColor + '20' }}
              >
                {node.isChanged ? (
                  <AlertCircle className="w-6 h-6" style={{ color: severityColor }} />
                ) : (
                  <FileCode className="w-6 h-6" style={{ color: severityColor }} />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xl font-bold font-mono text-slate-100">{node.name}()</h3>
                  {node.isChanged && (
                    <Badge variant="destructive">Modified</Badge>
                  )}
                  <Badge
                    variant="outline"
                    style={{
                      backgroundColor: severityColor + '15',
                      borderColor: severityColor,
                      color: severityColor,
                    }}
                  >
                    {node.severity}
                  </Badge>
                </div>
                <div className="text-sm text-slate-400 mt-1 font-mono">
                  {relativePath(node.filePath, data.analysisPath)}:{node.line}
                </div>
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="flex-shrink-0 hover:bg-slate-800"
          >
            <X className="w-5 h-5 text-slate-400" />
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-6">
          {/* Callers */}
          <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-slate-100">
                <ArrowUpCircle className="w-5 h-5 text-blue-400" />
                Called By ({callers.length}{node.callerCount > callers.length ? ` of ${node.callerCount} in project` : ''})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {callers.length > 0 ? (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                  {callers.slice(0, 10).map(caller => (
                    <button
                      type="button"
                      key={caller.id}
                      onClick={() => onNavigate(caller.id)}
                      className="w-full text-left p-3 rounded-lg bg-slate-800/50 hover:bg-slate-800 transition-colors cursor-pointer"
                    >
                      <div className="text-sm font-mono font-medium text-slate-200 truncate">
                        {caller.name}()
                      </div>
                      <div className="text-xs text-slate-400 truncate mt-1">
                        📄 {fileName(caller.filePath)}:{caller.line}
                      </div>
                    </button>
                  ))}
                  {callers.length > 10 && (
                    <div className="text-sm text-slate-400 text-center py-2">
                      +{callers.length - 10} more
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-slate-400 text-center py-8">
                  No callers found
                </div>
              )}
            </CardContent>
          </Card>

          {/* Callees */}
          <Card className="bg-slate-900 border-slate-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-slate-100">
                <ArrowDownCircle className="w-5 h-5 text-green-400" />
                Calls ({callees.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {callees.length > 0 ? (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                  {callees.slice(0, 10).map(callee => (
                    <button
                      type="button"
                      key={callee.id}
                      onClick={() => onNavigate(callee.id)}
                      className="w-full text-left p-3 rounded-lg bg-slate-800/50 hover:bg-slate-800 transition-colors cursor-pointer"
                    >
                      <div className="text-sm font-mono font-medium text-slate-200 truncate">
                        {callee.name}()
                      </div>
                      <div className="text-xs text-slate-400 truncate mt-1">
                        📄 {fileName(callee.filePath)}:{callee.line}
                      </div>
                    </button>
                  ))}
                  {callees.length > 10 && (
                    <div className="text-sm text-slate-400 text-center py-2">
                      +{callees.length - 10} more
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-slate-400 text-center py-8">
                  No calls found
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Breaking changes warning */}
        {node.hasBreakingChanges && (
          <Card className="mt-6 border-red-500/50 bg-red-500/10">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-red-400">
                    Possibly Broken by This Change
                  </div>
                  <div className="text-xs text-red-300/80 mt-1">
                    A call this function depends on was removed, or data it reads is no longer returned. Check it still behaves correctly.
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
          </div>
        </div>
      </div>
    </>
  );
}
