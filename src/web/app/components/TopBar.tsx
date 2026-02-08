import React from 'react';
import type { ImpactData } from '../types';
import { Network, Clock, FolderTree } from 'lucide-react';

interface Props {
  data: ImpactData;
}

export function TopBar({ data }: Props) {
  return (
    <div className="h-14 border-b border-slate-800 bg-slate-950 px-6 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Network className="w-5 h-5 text-blue-400" />
        <div>
          <div className="text-base font-semibold text-slate-100">CodeMap Impact</div>
          <div className="text-xs text-slate-500">{data.statistics.totalAffected} functions affected</div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800">
          <FolderTree className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-sm font-medium text-slate-200">{data.statistics.filesAffected}</span>
          <span className="text-xs text-slate-500">files</span>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800">
          <Clock className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs font-mono text-slate-300">
            {new Date(data.timestamp).toLocaleTimeString()}
          </span>
        </div>

        <div className="px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <span className="text-xs font-semibold text-blue-400">{data.changedFiles.length} changed</span>
        </div>
      </div>
    </div>
  );
}
