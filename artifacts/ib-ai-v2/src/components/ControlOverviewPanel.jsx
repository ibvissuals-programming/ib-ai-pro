/**
 * ControlOverviewPanel — aggregate system snapshot from /api/admin/overview.
 *
 * Displays:
 *   - Total users / active now / active 24h
 *   - Chats today / messages today
 *   - Avg response time (ms)
 *   - Error rate (%)
 *   - Total memory entries
 *   - Events in last minute
 *
 * Polling interval handled by caller (useOverview hook, 10s).
 */
import { RefreshCw, AlertCircle, LayoutDashboard } from 'lucide-react';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatLastOk(ms) {
  if (!ms) return null;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 3) return 'just now';
  return `${diff}s ago`;
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }) {
  return (
    <div className={`glass-subtle rounded-lg px-3 py-3 border border-border/20 ${accent ?? ''}`}>
      <div className="text-xl font-bold text-foreground tabular-nums leading-none">
        {value ?? '—'}
      </div>
      <div className="text-[10px] text-muted-foreground mt-1">{label}</div>
      {sub != null && (
        <div className="text-[10px] text-muted-foreground/40 mt-0.5">{sub}</div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ControlOverviewPanel({ data, loading, error, lastOk }) {
  const users   = data?.users;
  const chats   = data?.chats;
  const perf    = data?.performance;
  const memory  = data?.memory;
  const ep      = data?.eventPipeline;

  return (
    <div className="glass-card rounded-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <LayoutDashboard size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">Control Overview</span>
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw size={11} className="text-muted-foreground animate-spin" />}
          {lastOk && !loading && (
            <span className="text-[10px] text-muted-foreground/60">{formatLastOk(lastOk)}</span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-4">
        {error && !loading ? (
          <div className="flex items-center gap-2 text-xs text-amber-400/80">
            <AlertCircle size={13} className="shrink-0" />
            {error}
          </div>
        ) : (
          <div className="space-y-3">
            {/* Users row */}
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest font-semibold mb-2">
                Users
              </p>
              <div className="grid grid-cols-3 gap-2">
                <StatCard label="Total"     value={users?.total} />
                <StatCard label="Active now" value={users?.activeNow} accent={users?.activeNow > 0 ? 'border-emerald-500/20' : ''} />
                <StatCard label="Last 24h"  value={users?.active24h} />
              </div>
            </div>

            {/* Chat activity row */}
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest font-semibold mb-2">
                Chat Activity (today)
              </p>
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Chat requests" value={chats?.today} />
                <StatCard label="Messages"      value={chats?.messagesTODAY} />
              </div>
            </div>

            {/* Performance row */}
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest font-semibold mb-2">
                Performance
              </p>
              <div className="grid grid-cols-3 gap-2">
                <StatCard
                  label="Avg latency"
                  value={perf?.avgResponseMs != null ? `${perf.avgResponseMs}ms` : '—'}
                />
                <StatCard
                  label="Error rate"
                  value={perf?.errorRate != null ? `${perf.errorRate}%` : '—'}
                  accent={perf?.errorRate > 0 ? 'border-red-500/20' : ''}
                />
                <StatCard
                  label="Events / min"
                  value={perf?.eventsLastMinute ?? '—'}
                  accent={perf?.eventsLastMinute > 0 ? 'border-sky-500/20' : ''}
                />
              </div>
            </div>

            {/* Memory + pipeline row */}
            <div>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest font-semibold mb-2">
                Memory & Events
              </p>
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Memory entries" value={memory?.totalEntries ?? '—'} />
                <StatCard label="Events tracked"  value={ep?.totalEventsSinceStart ?? '—'} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
