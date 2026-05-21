/**
 * MultimodalStatsPanel — CEO Dashboard
 *
 * Polls /api/admin/multimodal-stats every 30s and displays:
 *   - Per-tool generation counts, success rates, avg latency
 *   - Provider readiness indicators
 *   - Circuit breaker states
 *
 * Self-contained polling — uses getAuthHeaders() directly.
 * No external dependencies beyond lucide-react + framer-motion.
 */
import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { BarChart2, RefreshCw, AlertCircle, Zap, Mic, Video, Image, Sparkles } from 'lucide-react';
import { getAuthHeaders } from '../auth/authService';

const POLL_MS = 30_000;

const TOOL_META = {
  image:  { label: 'Image Gen/Edit', icon: Image,    color: 'text-violet-400', bg: 'bg-violet-400/10' },
  tts:    { label: 'Voice TTS',      icon: Mic,      color: 'text-rose-400',   bg: 'bg-rose-400/10'   },
  video:  { label: 'Video Veo 2',    icon: Video,    color: 'text-blue-400',   bg: 'bg-blue-400/10'   },
  prompt: { label: 'Prompt Expand',  icon: Sparkles, color: 'text-amber-400',  bg: 'bg-amber-400/10'  },
};

function CircuitBadge({ state }) {
  const color =
    state === 'closed'    ? 'text-emerald-400/80 bg-emerald-400/8'  :
    state === 'open'      ? 'text-red-400 bg-red-400/10'            :
    state === 'half-open' ? 'text-amber-400 bg-amber-400/10'        :
                            'text-muted-foreground/40 bg-transparent';
  return (
    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${color}`}>
      {state ?? 'closed'}
    </span>
  );
}

function StatusDot({ status }) {
  const color =
    status === 'healthy'  ? 'bg-emerald-400' :
    status === 'degraded' ? 'bg-amber-400'   :
    status === 'failing'  ? 'bg-red-400'     :
                            'bg-muted-foreground/30';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color} shrink-0`} />;
}

function fmt(ms) {
  if (ms == null) return '—';
  if (ms < 1000)  return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pct(rate) {
  if (rate == null) return '—';
  return `${Math.round(rate * 100)}%`;
}

export function MultimodalStatsPanel() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [lastOk, setLastOk]   = useState(null);
  const timerRef              = useRef(null);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/admin/multimodal-stats', { headers: getAuthHeaders() });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      setData(json);
      setLastOk(Date.now());
      setError(null);
    } catch (err) {
      setError(err.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    timerRef.current = setInterval(fetchStats, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  const tools = data?.tools ?? {};

  return (
    <div className="glass-card rounded-xl flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <BarChart2 size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">Multimodal Analytics</span>
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw size={11} className="text-muted-foreground animate-spin" />}
          {lastOk && !loading && (
            <span className="text-[10px] text-muted-foreground/60 hidden sm:block">
              {Math.floor((Date.now() - lastOk) / 1000)}s ago
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 px-4 py-4">
        {error && !loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-amber-400/80">
            <AlertCircle size={13} className="shrink-0" />
            {error}
          </div>
        ) : (
          <>
            {/* System score */}
            {data?.systemScore != null && (
              <div className="mb-4 flex items-center gap-3 px-3 py-2.5 rounded-xl bg-secondary/40 border border-border/30">
                <Zap size={13} className="text-primary shrink-0" />
                <div className="flex-1">
                  <p className="text-[10px] text-muted-foreground">System Stability Score</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full ${data.systemScore >= 90 ? 'bg-emerald-400' : data.systemScore >= 70 ? 'bg-amber-400' : 'bg-red-400'}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${data.systemScore}%` }}
                        transition={{ duration: 0.6 }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-foreground tabular-nums">
                      {data.systemScore}
                    </span>
                  </div>
                </div>
                <div className="text-[10px] text-muted-foreground text-right">
                  <p>{data.healthyTools ?? 0}/{data.activeTools ?? 0} healthy</p>
                </div>
              </div>
            )}

            {/* Per-tool rows */}
            <div className="space-y-2">
              {Object.entries(TOOL_META).map(([key, meta]) => {
                const t = tools[key];
                const Icon = meta.icon;
                if (!t && loading) {
                  return (
                    <div key={key} className="h-14 rounded-xl bg-secondary/20 animate-pulse" />
                  );
                }
                return (
                  <motion.div
                    key={key}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-border/25 bg-secondary/20 hover:bg-secondary/30 transition-colors"
                  >
                    <div className={`w-7 h-7 rounded-lg ${meta.bg} flex items-center justify-center shrink-0`}>
                      <Icon size={12} className={meta.color} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-medium text-foreground/90">{meta.label}</p>
                        <StatusDot status={t?.status} />
                        <CircuitBadge state={t?.circuit} />
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{t?.provider ?? '—'}</p>
                    </div>
                    <div className="flex items-center gap-4 shrink-0 text-right">
                      <div>
                        <p className="text-[10px] text-muted-foreground">Calls</p>
                        <p className="text-xs font-semibold text-foreground tabular-nums">{t?.totalCalls ?? 0}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Success</p>
                        <p className={`text-xs font-semibold tabular-nums ${t?.successRate == null ? 'text-muted-foreground' : t.successRate >= 0.9 ? 'text-emerald-400' : t.successRate >= 0.7 ? 'text-amber-400' : 'text-red-400'}`}>
                          {pct(t?.successRate)}
                        </p>
                      </div>
                      <div className="hidden sm:block">
                        <p className="text-[10px] text-muted-foreground">Avg Latency</p>
                        <p className="text-xs font-semibold text-foreground tabular-nums">{fmt(t?.avgLatencyMs)}</p>
                      </div>
                      {t?.persistedCount != null && (
                        <div className="hidden md:block">
                          <p className="text-[10px] text-muted-foreground">Saved</p>
                          <p className="text-xs font-semibold text-foreground tabular-nums">{t.persistedCount}</p>
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
