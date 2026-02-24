import { useEffect, useState } from 'react';
import type { ImpactData } from './types';
import { ImpactGraph } from './components/ImpactGraph';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { DetailPanel } from './components/DetailPanel';

export default function App() {
  const [impactData, setImpactData] = useState<ImpactData | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/impact')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error((body && typeof body.error === 'string' && body.error) || `HTTP ${res.status}`);
        }
        return body as ImpactData;
      })
      .then((data) => {
        setImpactData(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent mx-auto mb-4"></div>
          <div className="text-lg font-semibold text-slate-100 mb-1">Loading Impact Analysis</div>
          <div className="text-sm text-slate-400">Analyzing call graph...</div>
        </div>
      </div>
    );
  }

  if (error || !impactData) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950 px-4">
        <div className="text-center">
          <div className="text-xl font-bold text-red-400 mb-2">Error Loading Data</div>
          <div className="text-sm text-slate-400">{error || 'No impact data found'}</div>
        </div>
      </div>
    );
  }

  const selectedNode = impactData.nodes.find((n) => n.id === selectedNodeId);

  const select = (id: string | null) => {
    setSelectedNodeId(id);
    setDetailOpen(id !== null);
  };

  return (
    <div className="flex flex-col h-screen bg-slate-900">
      <TopBar data={impactData} />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar data={impactData} selectedNodeId={selectedNodeId} onNodeSelect={select} />

        <div className="flex-1 relative">
          {impactData.nodes.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center px-6">
              <div>
                <div className="text-slate-200 font-semibold mb-1">No affected functions</div>
                <div className="text-sm text-slate-400">
                  The changed files contain no changed functions with callers in the index.
                </div>
              </div>
            </div>
          ) : (
            <ImpactGraph data={impactData} selectedNodeId={selectedNodeId} onNodeSelect={select} />
          )}
        </div>
      </div>

      {selectedNode && detailOpen && (
        <DetailPanel
          node={selectedNode}
          data={impactData}
          onClose={() => setDetailOpen(false)}
          onNavigate={(id) => select(id)}
        />
      )}
    </div>
  );
}
