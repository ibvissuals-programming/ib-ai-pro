/**
 * SystemControlPanel — System Control Center for the CEO Dashboard.
 *
 * Four sections:
 *   1. System Status Cards — storage mode, DB, AI provider, pipeline
 *   2. Storage Control     — mode toggle + migration trigger + confirm modal
 *   3. Pipeline Analytics  — mode/intensity/status distribution bars + KPIs
 *   4. Admin Action Log    — recent admin control action stream
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Database, Zap, Server, Activity, RefreshCw, AlertCircle,
  CheckCircle, XCircle, ChevronRight, ChevronDown, Shield,
  BarChart2, Clock, GitBranch, Play, Loader2, Lock,
} from 'lucide-react';
import { getAuthHeaders } from '../auth/authService';

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

async function adminPost(path, body = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: json };
}

function formatRelative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 5_000)     return 'just now';
  if (diff < 60_000)    return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatMs(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatLastOk(ms) {
  if (!ms) return null;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 3) return 'just now';
  return `${diff}s ago`;
}

// ── Shared panel wrapper ──────────────────────────────────────────────────────

function Panel({ icon: Icon, title, lastOk, loading, error, children, className = '', badge }) {
  return (
    <div className={`glass-card rounded-xl flex flex-col min-h-0 ${className}`}>
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border/30 bg-muted/30 text-muted-foreground font-medium">
              {badge}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw size={11} className="text-muted-foreground animate-spin" />}
          {lastOk && !loading && (
            <span className="text-[10px] text-muted-foreground/60 hidden sm:block">{formatLastOk(lastOk)}</span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {error && !loading ? (
          <div className="flex items-center gap-2 px-4 py-5 text-xs text-amber-400/80">
            <AlertCircle size={13} className="shrink-0" />{error}
          </div>
        ) : children}
      </div>
    </div>
  );
}

// ── Section 1: System Status Cards ────────────────────────────────────────────

function StorageModeBadge({ mode }) {
  const styles = {
    postgres: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
    hybrid:   'text-blue-400 bg-blue-400/10 border-blue-400/20',
    json:     'text-amber-400 bg-amber-400/10 border-amber-400/20',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${styles[mode] ?? 'text-muted-foreground border-border/30 bg-muted/30'}`}>
      {mode ?? '—'}
    </span>
  );
}

function DbStatusDot({ status }) {
  const color =
    status === 'connected'    ? 'bg-emerald-400' :
    status === 'disconnected' ? 'bg-red-400'     :
    'bg-muted-foreground/40';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color} shrink-0`} />;
}

function AiBadge({ status }) {
  return status === 'active'
    ? <span className="flex items-center gap-1 text-emerald-400 text-[11px]"><CheckCircle size={10} /> Active</span>
    : <span className="flex items-center gap-1 text-red-400 text-[11px]"><XCircle size={10} /> Missing</span>;
}

function SystemStatusCards({ data, loading, error, lastOk }) {
  const storage  = data?.storage ?? {};
  const ai       = data?.ai      ?? {};
  const backend  = data?.backend ?? {};
  const pipeline = data?.pipeline ?? {};
  const users    = data?.users   ?? {};

  const cards = [
    {
      icon:    Database,
      title:   'Storage Mode',
      value:   <StorageModeBadge mode={storage.mode} />,
      sub:     storage.dbStatus
        ? <span className="flex items-center gap-1"><DbStatusDot status={storage.dbStatus} />{storage.dbStatus}</span>
        : null,
    },
    {
      icon:    Zap,
      title:   'AI Provider',
      value:   <AiBadge status={ai.gemini} />,
      sub:     'Gemini Flash',
    },
    {
      icon:    Server,
      title:   'Backend',
      value:   <span className={backend.status === 'operational' ? 'text-emerald-400 text-sm font-semibold' : 'text-amber-400 text-sm font-semibold'}>{backend.status ?? '—'}</span>,
      sub:     backend.uptimeSeconds != null ? `${Math.floor(backend.uptimeSeconds / 3600)}h uptime` : null,
    },
    {
      icon:    Activity,
      title:   'Pipeline',
      value:   <span className="text-sm font-semibold text-foreground">{pipeline.totalImages ?? 0} imgs</span>,
      sub:     pipeline.successRate != null ? `${pipeline.successRate}% success` : 'no data',
    },
    {
      icon:    Shield,
      title:   'Users',
      value:   <span className="text-sm font-semibold text-foreground">{users.total ?? '—'}</span>,
      sub:     users.activeNow != null ? `${users.activeNow} online` : null,
    },
    {
      icon:    Clock,
      title:   'Avg Latency',
      value:   <span className="text-sm font-semibold text-foreground">{formatMs(pipeline.avgLatencyMs)}</span>,
      sub:     pipeline.retryRate != null ? `${pipeline.retryRate}% retry` : 'no data',
    },
  ];

  return (
    <Panel icon={Server} title="System Status" lastOk={lastOk} loading={loading} error={error}>
      <div className="px-4 py-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {cards.map(({ icon: Icon, title, value, sub }) => (
          <div key={title} className="glass-subtle rounded-lg px-3 py-3 border border-border/20 flex flex-col gap-1">
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Icon size={9} className="shrink-0" /> {title}
            </div>
            <div>{value}</div>
            {sub && <div className="text-[10px] text-muted-foreground/60 flex items-center gap-1">{sub}</div>}
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── Section 2: Storage Control ────────────────────────────────────────────────

const MODE_INFO = {
  json:     { label: 'JSON Files', desc: 'Fast local storage, no external DB required. All data in data/*.json files.' },
  postgres: { label: 'PostgreSQL', desc: 'Full PostgreSQL persistence. Recommended for production.' },
  hybrid:   { label: 'Hybrid',     desc: 'PG primary with automatic JSON fallback on PG errors.' },
};

function ConfirmModal({ title, body, onConfirm, onCancel, confirmLabel = 'Confirm', danger = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="glass-card rounded-xl p-6 max-w-sm w-full space-y-4 border border-border/40"
      >
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-lg bg-muted/40 hover:bg-muted/60 text-muted-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
              danger
                ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/20'
                : 'bg-primary/20 hover:bg-primary/30 text-primary border border-primary/20'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function StorageControlPanel({ systemData, systemLoading, onRefreshSystem }) {
  const currentMode = systemData?.storage?.mode ?? 'json';
  const migRunning  = systemData?.storage?.migrationRunning ?? false;
  const lastMig     = systemData?.storage?.lastMigrationRun;

  const [pendingMode,  setPendingMode]  = useState(null);   // mode being confirmed
  const [showMigModal, setShowMigModal] = useState(false);
  const [busy,         setBusy]         = useState(false);
  const [feedback,     setFeedback]     = useState(null);   // { ok, msg }

  function flash(ok, msg) {
    setFeedback({ ok, msg });
    setTimeout(() => setFeedback(null), 4000);
  }

  async function handleModeChange(mode) {
    if (mode === currentMode) return;
    setPendingMode(mode);
  }

  async function confirmModeChange() {
    const mode = pendingMode;
    setPendingMode(null);
    setBusy(true);
    try {
      const { ok, data } = await adminPost('/admin/storage/mode', { mode });
      if (ok) {
        flash(true, data.message ?? `Storage mode set to ${mode}`);
        onRefreshSystem?.();
      } else {
        flash(false, data.error ?? 'Failed to update storage mode');
      }
    } catch {
      flash(false, 'Network error — could not update storage mode');
    } finally {
      setBusy(false);
    }
  }

  async function handleMigrate() {
    setShowMigModal(false);
    setBusy(true);
    try {
      const { ok, data } = await adminPost('/admin/storage/migrate');
      if (ok) {
        flash(true, 'Migration started — watch the action log for results.');
        onRefreshSystem?.();
      } else {
        flash(false, data.error ?? 'Failed to start migration');
      }
    } catch {
      flash(false, 'Network error — could not start migration');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AnimatePresence>
        {pendingMode && (
          <ConfirmModal
            title={`Switch to ${MODE_INFO[pendingMode]?.label}?`}
            body={`${MODE_INFO[pendingMode]?.desc} This takes effect immediately without a server restart.`}
            confirmLabel="Switch Mode"
            onConfirm={confirmModeChange}
            onCancel={() => setPendingMode(null)}
          />
        )}
        {showMigModal && (
          <ConfirmModal
            title="Run JSON → PostgreSQL Migration?"
            body="This copies all users and image history from JSON files into PostgreSQL. The operation is idempotent — existing PG records are preserved. It runs in the background and may take a moment."
            confirmLabel="Run Migration"
            onConfirm={handleMigrate}
            onCancel={() => setShowMigModal(false)}
          />
        )}
      </AnimatePresence>

      <Panel icon={Database} title="Storage Control" badge={currentMode.toUpperCase()}>
        <div className="px-4 py-4 space-y-5">

          {/* Mode selector */}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">
              Storage Mode
            </p>
            <div className="grid grid-cols-3 gap-2">
              {['json', 'postgres', 'hybrid'].map((mode) => {
                const active = currentMode === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => handleModeChange(mode)}
                    disabled={busy || systemLoading}
                    className={`
                      relative px-3 py-3 rounded-lg border text-left transition-all
                      ${active
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-border/20 bg-muted/20 hover:bg-muted/30 hover:border-border/40'}
                      ${busy || systemLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                    `}
                  >
                    <div className="text-[11px] font-semibold text-foreground mb-0.5">
                      {MODE_INFO[mode]?.label}
                    </div>
                    <div className="text-[10px] text-muted-foreground/70 leading-tight">
                      {MODE_INFO[mode]?.desc.split('.')[0]}
                    </div>
                    {active && (
                      <span className="absolute top-1.5 right-1.5 text-[10px] text-primary">
                        <CheckCircle size={10} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Migration */}
          <div className="flex items-start justify-between gap-4 pt-1 border-t border-border/20">
            <div>
              <p className="text-[11px] font-semibold text-foreground">JSON → PostgreSQL Migration</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Copy all JSON data into PostgreSQL. Idempotent — safe to re-run.
              </p>
              {lastMig && (
                <p className="text-[10px] text-muted-foreground/50 mt-1">
                  Last run: {formatRelative(lastMig)}
                </p>
              )}
            </div>
            <button
              onClick={() => setShowMigModal(true)}
              disabled={busy || migRunning}
              className={`
                flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-all shrink-0
                ${migRunning
                  ? 'border-amber-500/20 bg-amber-500/10 text-amber-400 cursor-not-allowed'
                  : busy
                    ? 'opacity-50 cursor-not-allowed border-border/20 text-muted-foreground'
                    : 'border-primary/20 bg-primary/10 text-primary hover:bg-primary/20'
                }
              `}
            >
              {migRunning
                ? <><Loader2 size={11} className="animate-spin" /> Running…</>
                : <><Play size={11} /> Migrate</>
              }
            </button>
          </div>

          {/* Feedback banner */}
          <AnimatePresence>
            {feedback && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
                  feedback.ok
                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                    : 'border-red-500/20 bg-red-500/10 text-red-400'
                }`}
              >
                {feedback.ok ? <CheckCircle size={11} /> : <XCircle size={11} />}
                {feedback.msg}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Panel>
    </>
  );
}

// ── Section 3: Pipeline Analytics ─────────────────────────────────────────────

function DistBar({ label, count, total, color }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground w-28 truncate shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground/60 tabular-nums w-12 text-right shrink-0">
        {count} <span className="text-muted-foreground/30">({pct}%)</span>
      </span>
    </div>
  );
}

const INTENSITY_COLORS = {
  LOW:     'bg-sky-400/70',
  MEDIUM:  'bg-blue-400/70',
  HIGH:    'bg-orange-400/70',
  EXTREME: 'bg-red-400/70',
};

function PipelineAnalyticsPanel({ data, loading, error, lastOk }) {
  const [section, setSection] = useState(null);

  const total       = data?.total       ?? 0;
  const byMode      = data?.byMode      ?? {};
  const byIntensity = data?.byIntensity ?? {};
  const byStatus    = data?.byStatus    ?? {};

  const sections = [
    { id: 'mode',      label: 'By Mode',      dist: byMode,      color: 'bg-primary/60' },
    { id: 'intensity', label: 'By Intensity',  dist: byIntensity, colorFn: (k) => INTENSITY_COLORS[k] ?? 'bg-muted-foreground/40' },
    { id: 'status',    label: 'By Status',     dist: byStatus,
      colorFn: (k) => k === 'success' ? 'bg-emerald-400/70' : 'bg-red-400/70' },
  ];

  return (
    <Panel icon={BarChart2} title="Pipeline Analytics" lastOk={lastOk} loading={loading} error={error}>
      <div className="px-4 py-4 space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'Total Images', value: total,                        sub: 'since start' },
            { label: 'Success Rate', value: data ? `${data.successRate}%` : '—', sub: 'pass rate' },
            { label: 'Avg Latency',  value: formatMs(data?.avgLatencyMs),  sub: 'per image' },
            { label: 'Retry Rate',   value: data ? `${data.retryRate}%` : '—',  sub: 'needed retry' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="glass-subtle rounded-lg px-3 py-3 border border-border/20">
              <div className="text-xl font-bold text-foreground tabular-nums">{value}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
              <div className="text-[10px] text-muted-foreground/40 mt-0.5">{sub}</div>
            </div>
          ))}
        </div>

        {/* Distribution sections */}
        {total === 0 ? (
          <p className="text-xs text-muted-foreground/50 text-center py-2">
            No pipeline data yet — data appears after the first image generation.
          </p>
        ) : (
          <div className="space-y-2">
            {sections.map(({ id, label, dist, color, colorFn }) => {
              const open    = section === id;
              const entries = Object.entries(dist).sort(([, a], [, b]) => b - a);
              return (
                <div key={id} className="border border-border/20 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setSection(open ? null : id)}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.02] transition-colors"
                  >
                    <span className="text-[11px] font-medium text-foreground">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground">{entries.length} variants</span>
                      {open ? <ChevronDown size={11} className="text-muted-foreground" /> : <ChevronRight size={11} className="text-muted-foreground" />}
                    </div>
                  </button>
                  <AnimatePresence>
                    {open && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden"
                      >
                        <div className="px-3 pb-3 pt-1 space-y-1.5 border-t border-border/10">
                          {entries.map(([k, v]) => (
                            <DistBar
                              key={k}
                              label={k}
                              count={v}
                              total={total}
                              color={colorFn ? colorFn(k) : color}
                            />
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ── Section 4: Admin Action Log ───────────────────────────────────────────────

const ACTION_STYLES = {
  storage_mode_change:  { label: 'mode change',  color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  migration_start:      { label: 'mig start',    color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  migration_complete:   { label: 'mig done',     color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  migration_failed:     { label: 'mig failed',   color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  user_role_change:     { label: 'role change',  color: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
  user_credit_adjust:   { label: 'credits',      color: 'text-sky-400 bg-sky-400/10 border-sky-400/20' },
  system_config_change: { label: 'config',       color: 'text-indigo-400 bg-indigo-400/10 border-indigo-400/20' },
  admin_error:          { label: 'error',         color: 'text-red-400 bg-red-400/10 border-red-400/20' },
};

function actionStyle(action) {
  return ACTION_STYLES[action] ?? { label: action, color: 'text-muted-foreground bg-muted/30 border-border/30' };
}

function ActionLogRow({ entry }) {
  const [open, setOpen] = useState(false);
  const s = actionStyle(entry.action);
  const hasDetails = entry.details && Object.keys(entry.details).length > 0;

  return (
    <>
      <tr
        className={`border-b border-border/10 last:border-0 hover:bg-white/[0.02] transition-colors ${hasDetails ? 'cursor-pointer' : ''}`}
        onClick={() => hasDetails && setOpen(x => !x)}
      >
        <td className="px-4 py-2.5 text-muted-foreground/70 tabular-nums whitespace-nowrap text-xs">
          {formatTime(entry.timestamp)}
        </td>
        <td className="px-4 py-2.5">
          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium whitespace-nowrap ${s.color}`}>
            {s.label}
          </span>
        </td>
        <td className="px-4 py-2.5 text-xs text-foreground">
          {entry.actor ?? <span className="text-muted-foreground/40">—</span>}
        </td>
        <td className="px-4 py-2.5 text-right w-6">
          {hasDetails && (
            <span className="text-muted-foreground/40">
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
          )}
        </td>
      </tr>
      {open && hasDetails && (
        <tr className="bg-white/[0.01]">
          <td colSpan={4} className="px-4 pb-3 pt-1">
            <pre className="text-[10px] text-muted-foreground bg-muted/30 rounded-lg px-3 py-2 overflow-x-auto border border-border/20">
              {JSON.stringify(entry.details, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function AdminActionLogPanel({ data, loading, error, lastOk }) {
  const entries = data?.entries ?? [];

  return (
    <Panel
      icon={Lock}
      title={`Admin Actions${data ? ` (${data.count} shown)` : ''}`}
      lastOk={lastOk}
      loading={loading}
      error={error}
    >
      {entries.length === 0 && !loading && !error ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground/60">
          No admin actions recorded yet
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/20">
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium whitespace-nowrap">Time</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Action</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Actor</th>
                <th className="px-4 py-2.5 w-6" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => <ActionLogRow key={e.id} entry={e} />)}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function SystemControlPanel({ systemHealth, pipelineStats, actionLogs }) {
  return (
    <div className="space-y-4">
      {/* Row 1: System Status Cards — full width */}
      <SystemStatusCards
        data={systemHealth.data}
        loading={systemHealth.loading}
        error={systemHealth.error}
        lastOk={systemHealth.lastOk}
      />

      {/* Row 2: Storage Control (left) + Pipeline Analytics (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <StorageControlPanel
          systemData={systemHealth.data}
          systemLoading={systemHealth.loading}
        />
        <PipelineAnalyticsPanel
          data={pipelineStats.data}
          loading={pipelineStats.loading}
          error={pipelineStats.error}
          lastOk={pipelineStats.lastOk}
        />
      </div>

      {/* Row 3: Admin Action Log — full width */}
      <AdminActionLogPanel
        data={actionLogs.data}
        loading={actionLogs.loading}
        error={actionLogs.error}
        lastOk={actionLogs.lastOk}
      />

      <p className="text-center text-[10px] text-muted-foreground/40 pb-4">
        System health 10s · pipeline 30s · action log 15s
      </p>
    </div>
  );
}
