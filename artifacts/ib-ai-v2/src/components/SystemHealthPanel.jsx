/**
 * SystemHealthPanel — live subsystem health from /api/admin/system-health.
 *
 * Shows:
 *   - Backend: status, uptime, heap memory
 *   - Database: reachable / unreachable
 *   - Gemini API: configured, success rate, avg latency
 *   - Memory pipeline: status + last-10m extraction/skip counts
 *   - Recent error events (if any)
 *
 * Polling interval: 8s (handled by useSystemHealth from useAdminPolling).
 */
import { RefreshCw, AlertCircle, Activity } from 'lucide-react';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUptime(s) {
  if (s == null) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatLastOk(ms) {
  if (!ms) return null;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 3) return 'just now';
  return `${diff}s ago`;
}

function formatRelative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const color =
    status === 'operational' ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' :
    status === 'degraded'    ? 'text-amber-400 bg-amber-400/10 border-amber-400/20' :
    status === 'unreachable' ? 'text-red-400 bg-red-400/10 border-red-400/20' :
    status === 'idle'        ? 'text-sky-400 bg-sky-400/10 border-sky-400/20' :
                               'text-muted-foreground bg-muted/20 border-border/20';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${color}`}>
      {status ?? '—'}
    </span>
  );
}

// ── Subsystem row ─────────────────────────────────────────────────────────────

function SubsystemRow({ label, status, detail }) {
  return (
    <div className="flex items-start justify-between py-2.5 border-b border-border/10 last:border-0 gap-2">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        {detail && (
          <div className="text-[10px] text-muted-foreground/60 mt-0.5 space-y-0.5">
            {Array.isArray(detail) ? detail.map((d, i) => <div key={i}>{d}</div>) : <div>{detail}</div>}
          </div>
        )}
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SystemHealthPanel({ data, loading, error, lastOk }) {
  const ss = data?.subsystems;

  const gemini  = ss?.gemini;
  const backend = ss?.backend;
  const db      = ss?.database;
  const mem     = ss?.memoryPipeline;

  return (
    <div className="glass-card rounded-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">System Health</span>
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw size={11} className="text-muted-foreground animate-spin" />}
          {lastOk && !loading && (
            <span className="text-[10px] text-muted-foreground/60">{formatLastOk(lastOk)}</span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {error && !loading ? (
          <div className="flex items-center gap-2 px-4 py-5 text-xs text-amber-400/80">
            <AlertCircle size={13} className="shrink-0" />
            {error}
          </div>
        ) : (
          <div className="px-4 py-3 space-y-0">
            {/* Backend */}
            <SubsystemRow
              label="Backend"
              status={backend?.status}
              detail={[
                `uptime: ${formatUptime(backend?.uptimeSeconds)}`,
                backend?.memory ? `heap: ${backend.memory.heapUsedMb}MB / ${backend.memory.heapTotalMb}MB` : null,
                backend?.memory ? `rss: ${backend.memory.rssMb}MB` : null,
              ].filter(Boolean)}
            />

            {/* Database */}
            <SubsystemRow
              label="Database"
              status={db?.status}
              detail={db?.reachable === false ? 'Cannot reach PostgreSQL' : null}
            />

            {/* Gemini API */}
            <SubsystemRow
              label="Gemini API"
              status={gemini?.status}
              detail={[
                gemini?.totalRequests > 0 ? `requests: ${gemini.totalRequests}` : null,
                gemini?.successRate != null ? `success: ${gemini.successRate}%` : null,
                gemini?.avgLatencyMs != null ? `avg latency: ${gemini.avgLatencyMs}ms` : null,
                gemini?.lastUsedAt ? `last used: ${formatRelative(gemini.lastUsedAt)}` : null,
              ].filter(Boolean)}
            />

            {/* Memory pipeline */}
            <SubsystemRow
              label="Memory Pipeline"
              status={mem?.status}
              detail={[
                mem?.extractedLast10m != null ? `extracted (10m): ${mem.extractedLast10m}` : null,
                mem?.skippedLast10m   != null ? `skipped (10m): ${mem.skippedLast10m}`     : null,
              ].filter(Boolean)}
            />
          </div>
        )}

        {/* Recent errors */}
        {data?.recentErrors?.length > 0 && (
          <div className="px-4 py-3 border-t border-border/20">
            <p className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-widest mb-2">
              Recent Errors
            </p>
            <div className="space-y-1.5">
              {data.recentErrors.map((e, i) => (
                <div key={i} className="flex items-start gap-2 text-[10px] text-red-400/80">
                  <AlertCircle size={10} className="shrink-0 mt-0.5" />
                  <span className="text-muted-foreground/50 tabular-nums shrink-0">
                    {new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className="truncate">{e.route ?? e.type}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Event pipeline stats */}
        {data?.eventPipeline && (
          <div className="px-4 py-3 border-t border-border/20">
            <div className="flex gap-3">
              <div className="flex-1 glass-subtle rounded-lg px-3 py-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">Events since start</div>
                <div className="text-sm font-semibold text-foreground tabular-nums">
                  {data.eventPipeline.totalEvents ?? '—'}
                </div>
              </div>
              <div className="flex-1 glass-subtle rounded-lg px-3 py-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">Active SSE streams</div>
                <div className="text-sm font-semibold text-foreground tabular-nums">
                  {data.eventPipeline.activeStreams ?? '—'}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
