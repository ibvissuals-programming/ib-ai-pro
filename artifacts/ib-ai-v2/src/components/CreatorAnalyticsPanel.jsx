/**
 * CreatorAnalyticsPanel.jsx — CEO Creator Analytics Observability
 *
 * Fetches /api/creator/analytics and renders:
 *   - Workflow funnel (upload → edit → voice → video → export)
 *   - Top edit modes
 *   - Top voice styles
 *   - Category distribution
 *   - Device split
 *   - Active users
 */
import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart2, RefreshCw, Users, Zap, Mic, Film, ArrowRight,
  TrendingUp, AlertCircle,
} from 'lucide-react';
import { getCreatorAnalytics } from '../services/creatorSessionsApi';

const POLL_INTERVAL = 60_000;

const FUNNEL_STEPS = [
  { key: 'upload', label: 'Upload', color: 'bg-blue-500' },
  { key: 'edit',   label: 'Edit',   color: 'bg-violet-500' },
  { key: 'voice',  label: 'Voice',  color: 'bg-emerald-500' },
  { key: 'video',  label: 'Video',  color: 'bg-amber-500' },
  { key: 'export', label: 'Export', color: 'bg-rose-500' },
];

function FunnelBar({ label, count, maxCount, color }) {
  const pct = maxCount > 0 ? Math.max(4, Math.round((count / maxCount) * 100)) : 4;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-10 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-secondary/40 overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, delay: 0.05 }}
          className={`h-full rounded-full ${color}`}
        />
      </div>
      <span className="text-[10px] text-foreground/70 tabular-nums w-7 text-right">{count}</span>
    </div>
  );
}

function TopList({ items, label }) {
  if (!items?.length) return (
    <div className="text-[10px] text-muted-foreground/50 italic">No data yet</div>
  );
  return (
    <div className="space-y-1">
      {items.map(({ key, count }, i) => (
        <div key={key} className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground capitalize">{key.replace(/_/g, ' ')}</span>
          <span className="text-foreground/70 font-semibold tabular-nums">{count}</span>
        </div>
      ))}
    </div>
  );
}

export function CreatorAnalyticsPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const json = await getCreatorAnalytics();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchData]);

  const maxFunnel = data ? Math.max(...FUNNEL_STEPS.map(s => data.funnel?.[s.key] ?? 0), 1) : 1;

  return (
    <div className="rounded-2xl border border-border/50 bg-card/50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-primary/15 flex items-center justify-center">
            <TrendingUp size={12} className="text-primary" />
          </div>
          <span className="text-sm font-semibold text-foreground">Creator Analytics</span>
        </div>
        <button
          onClick={fetchData}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="p-4 space-y-5">
        {error && (
          <div className="flex items-center gap-2 text-[11px] text-amber-400 bg-amber-400/10 rounded-lg px-3 py-2 border border-amber-400/20">
            <AlertCircle size={11} />
            {error}
          </div>
        )}

        {data && (
          <>
            {/* Key metrics row */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Users',   value: data.totals?.activeUsers  ?? 0, icon: <Users size={10} /> },
                { label: 'Edits',   value: data.totals?.edits        ?? 0, icon: <Film size={10} /> },
                { label: 'Voices',  value: data.totals?.voiceGenerations ?? 0, icon: <Mic size={10} /> },
              ].map(({ label, value, icon }) => (
                <div key={label} className="rounded-xl border border-border/40 bg-background/40 px-2.5 py-2.5 text-center">
                  <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">{icon}<span className="text-[9px] uppercase tracking-wider">{label}</span></div>
                  <div className="text-base font-bold text-foreground tabular-nums">{value}</div>
                </div>
              ))}
            </div>

            {/* Workflow funnel */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <BarChart2 size={9} /> Workflow Funnel
                </div>
                {data.funnelConversion > 0 && (
                  <span className="text-[10px] text-emerald-400 font-semibold">{data.funnelConversion}% full-flow</span>
                )}
              </div>
              <div className="space-y-1.5">
                {FUNNEL_STEPS.map(step => (
                  <FunnelBar
                    key={step.key}
                    label={step.label}
                    count={data.funnel?.[step.key] ?? 0}
                    maxCount={maxFunnel}
                    color={step.color}
                  />
                ))}
              </div>
            </div>

            {/* Top modes + voices side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Zap size={9} /> Top Modes
                </div>
                <TopList items={data.topEditModes} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Mic size={9} /> Top Voices
                </div>
                <TopList items={data.topVoices} />
              </div>
            </div>

            {/* Category usage */}
            {data.topCategories?.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <BarChart2 size={9} /> Workflow Categories
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {data.topCategories.map(({ key, count }) => (
                    <span key={key} className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-secondary/60 border border-border/40 text-foreground/70">
                      {key} <span className="text-primary font-semibold">{count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Device split */}
            {(data.deviceSplit?.mobile + data.deviceSplit?.desktop) > 0 && (
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Device split</span>
                <span className="text-foreground/70">
                  📱 {data.deviceSplit.mobile} mobile · 🖥 {data.deviceSplit.desktop} desktop
                </span>
              </div>
            )}

            {/* Global session stats */}
            <div className="flex items-center justify-between text-[11px] border-t border-border/30 pt-2.5">
              <span className="text-muted-foreground">Saved workflows</span>
              <span className="font-semibold text-foreground tabular-nums">
                {data.globalStats?.totalSessions ?? 0} across {data.globalStats?.totalUsers ?? 0} users
              </span>
            </div>
          </>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            <RefreshCw size={14} className="animate-spin mr-2" /> Loading analytics…
          </div>
        )}
      </div>
    </div>
  );
}
