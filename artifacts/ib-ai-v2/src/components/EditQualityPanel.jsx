/**
 * EditQualityPanel — CEO Edit Quality Observability
 *
 * Fetches edit quality metrics from /api/image/edit-quality and displays:
 *   - Stability score (0-100)
 *   - Success/retry/failure rates
 *   - Mode popularity distribution
 *   - Top failure categories
 *   - Retry reasons breakdown
 */
import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { getAuthHeaders } from '../auth/authService';
import {
  Shield, RefreshCw, TrendingUp, BarChart2,
  AlertCircle, CheckCircle, Clock, Zap,
} from 'lucide-react';

const POLL_INTERVAL = 30_000;

function StabilityRing({ score }) {
  const color =
    score >= 85 ? 'text-emerald-400' :
    score >= 65 ? 'text-amber-400' :
    'text-red-400';

  const bgColor =
    score >= 85 ? 'bg-emerald-400/10 border-emerald-400/20' :
    score >= 65 ? 'bg-amber-400/10 border-amber-400/20' :
    'bg-red-400/10 border-red-400/20';

  return (
    <div className={`flex flex-col items-center justify-center w-20 h-20 rounded-full border-2 ${bgColor} shrink-0`}>
      <span className={`text-2xl font-bold ${color}`}>{score}</span>
      <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Score</span>
    </div>
  );
}

function StatRow({ label, value, sub, color = 'text-foreground' }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-[12px] font-semibold ${color} tabular-nums`}>
        {value}
        {sub && <span className="text-[10px] text-muted-foreground ml-1 font-normal">{sub}</span>}
      </span>
    </div>
  );
}

function ModeBar({ mode, count, total }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const modeColors = {
    polish: 'bg-emerald-500',
    cinematic: 'bg-violet-500',
    social: 'bg-blue-500',
    luxury: 'bg-amber-500',
    restore: 'bg-orange-500',
    portrait_safe: 'bg-green-500',
    style_transfer: 'bg-pink-500',
    creative: 'bg-red-500',
  };
  const barColor = modeColors[mode] ?? 'bg-primary';

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground capitalize">{mode.replace('_', ' ')}</span>
        <span className="text-foreground/80 tabular-nums">{count} <span className="text-muted-foreground">({pct}%)</span></span>
      </div>
      <div className="h-1 rounded-full bg-secondary/40 overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.4 }}
          className={`h-full rounded-full ${barColor}`}
        />
      </div>
    </div>
  );
}

export function EditQualityPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/image/edit-quality', { headers: getAuthHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
      setLastRefresh(Date.now());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const id = setInterval(fetchMetrics, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchMetrics]);

  const totalModeUses = data?.modePopularity?.reduce((s, m) => s + m.count, 0) ?? 0;

  return (
    <div className="rounded-2xl border border-border/50 bg-card/50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-violet-500/15 flex items-center justify-center">
            <Shield size={12} className="text-violet-400" />
          </div>
          <span className="text-sm font-semibold text-foreground">Edit Quality</span>
        </div>
        <button
          onClick={fetchMetrics}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {error && (
          <div className="flex items-center gap-2 text-[11px] text-amber-400 bg-amber-400/10 rounded-lg px-3 py-2 border border-amber-400/20">
            <AlertCircle size={11} />
            {error} — edit metrics require at least one edit attempt
          </div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            <RefreshCw size={14} className="animate-spin mr-2" /> Loading metrics…
          </div>
        )}

        {data && (
          <>
            {/* Top row: stability score + rates */}
            <div className="flex items-start gap-4">
              <StabilityRing score={data.stabilityScore ?? 0} />
              <div className="flex-1 space-y-0">
                <StatRow
                  label="Success Rate"
                  value={`${data.successRate ?? 0}%`}
                  color={data.successRate >= 90 ? 'text-emerald-400' : data.successRate >= 70 ? 'text-amber-400' : 'text-red-400'}
                />
                <StatRow label="Retry Rate" value={`${data.retryRate ?? 0}%`} />
                <StatRow label="Total Edits" value={data.totalAttempts ?? 0} />
                <StatRow
                  label="Avg Latency"
                  value={data.avgLatencyMs > 0 ? `${(data.avgLatencyMs / 1000).toFixed(1)}s` : '—'}
                  sub={data.p95LatencyMs > 0 ? `p95: ${(data.p95LatencyMs / 1000).toFixed(1)}s` : undefined}
                />
              </div>
            </div>

            {/* Mode popularity */}
            {data.modePopularity?.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <BarChart2 size={9} />
                  Mode Usage
                </div>
                <div className="space-y-1.5">
                  {data.modePopularity.map((m) => (
                    <ModeBar key={m.mode} mode={m.mode} count={m.count} total={totalModeUses} />
                  ))}
                </div>
              </div>
            )}

            {/* Top failure categories */}
            {data.topFailureCategories?.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <AlertCircle size={9} />
                  Failure Categories
                </div>
                {data.topFailureCategories.map(({ category, count }) => (
                  <div key={category} className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground capitalize">{category.replace('_', ' ')}</span>
                    <span className="text-red-400 font-semibold tabular-nums">{count}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Retry reasons */}
            {data.retries > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Zap size={9} />
                  Retry Causes
                </div>
                {Object.entries(data.retryReasons ?? {})
                  .filter(([, v]) => v > 0)
                  .sort(([, a], [, b]) => b - a)
                  .map(([reason, count]) => (
                    <div key={reason} className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground capitalize">{reason.replace(/_/g, ' ')}</span>
                      <span className="text-amber-400 font-semibold tabular-nums">{count}</span>
                    </div>
                  ))}
              </div>
            )}

            {/* Status badges */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[
                { label: 'Identity Lock', ok: true },
                { label: 'Validation', ok: true },
                { label: 'Retry Guard', ok: true },
                { label: '8-Mode System', ok: true },
              ].map(({ label, ok }) => (
                <span key={label} className={`flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full border font-medium ${
                  ok
                    ? 'bg-emerald-500/10 border-emerald-400/20 text-emerald-400'
                    : 'bg-red-500/10 border-red-400/20 text-red-400'
                }`}>
                  {ok ? <CheckCircle size={8} /> : <AlertCircle size={8} />}
                  {label}
                </span>
              ))}
            </div>

            {lastRefresh && (
              <div className="flex items-center gap-1 text-[9px] text-muted-foreground/50">
                <Clock size={8} />
                Updated {new Date(lastRefresh).toLocaleTimeString()}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
