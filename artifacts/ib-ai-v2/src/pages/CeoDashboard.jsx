/**
 * CeoDashboard — IB AI CEO Admin Dashboard
 *
 * Polls 4 admin endpoints and renders live system visibility:
 *   - System health
 *   - Active users
 *   - Daily stats
 *   - Audit log
 *
 * No backend changes required. Pure frontend consumer of existing APIs.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, Redirect } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity, Users, BarChart2, ScrollText,
  ArrowLeft, RefreshCw, LogOut, Sun, Moon,
  AlertCircle, Clock,
  ChevronRight, ChevronDown, Cpu, Shield,
  LayoutDashboard, UsersRound,
  Film, Zap, CheckCircle, XCircle, SkipForward, Sparkles,
  MessageSquare, ChevronUp, User,
} from 'lucide-react';
import { logout, getAuthHeaders } from '../auth/authService';
import { useAdminPolling } from '../hooks/useAdminPolling';
import { useTheme } from '../contexts/ThemeContext';
import { UsersDirectoryPanel } from '../components/UsersDirectoryPanel';
import { ActivityTimelinePanel } from '../components/ActivityTimelinePanel';
import { AiRoutingPanel } from '../components/AiRoutingPanel';

// ── Time helpers ──────────────────────────────────────────────────────────────

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatRelative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 5_000)   return 'just now';
  if (diff < 60_000)  return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Lagos' });
}

function formatLastOk(ms) {
  if (!ms) return null;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 3) return 'just now';
  return `${diff}s ago`;
}

// ── Event type styling ────────────────────────────────────────────────────────

const EVENT_STYLES = {
  login_success:          { label: 'login',         color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  login_failure:          { label: 'login fail',    color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  signup_success:         { label: 'signup',        color: 'text-sky-400 bg-sky-400/10 border-sky-400/20' },
  signup_failure:         { label: 'signup fail',   color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  image_generate_success: { label: 'img gen',       color: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
  image_generate_failure: { label: 'img gen fail',  color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  image_edit_success:     { label: 'img edit',      color: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
  image_edit_failure:     { label: 'img edit fail', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  image_analysis_success: { label: 'img analyze',   color: 'text-indigo-400 bg-indigo-400/10 border-indigo-400/20' },
  image_analysis_failure: { label: 'analyze fail',  color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  auth_error:             { label: 'auth error',    color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  system_error:           { label: 'sys error',     color: 'text-orange-400 bg-orange-400/10 border-orange-400/20' },
};

function eventStyle(type) {
  return EVENT_STYLES[type] ?? { label: type, color: 'text-muted-foreground bg-muted/40 border-border/30' };
}

function roleBadge(role) {
  if (role === 'ceo')     return 'text-purple-300 bg-purple-500/10 border-purple-500/25';
  if (role === 'premium') return 'text-blue-300 bg-blue-500/10 border-blue-500/25';
  return 'text-muted-foreground bg-muted/30 border-border/30';
}

function statusColor(status) {
  if (status === 'operational') return 'text-emerald-400';
  if (status === 'degraded')    return 'text-amber-400';
  return 'text-muted-foreground';
}

function StatusDot({ status }) {
  const color = status === 'operational' ? 'bg-emerald-400' : status === 'degraded' ? 'bg-amber-400' : 'bg-muted-foreground';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color} shrink-0`} />;
}

// ── Shared panel wrapper ──────────────────────────────────────────────────────

function Panel({ icon: Icon, title, lastOk, loading, error, children, className = '' }) {
  return (
    <div className={`glass-card rounded-xl flex flex-col min-h-0 ${className}`}>
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {loading && (
            <RefreshCw size={11} className="text-muted-foreground animate-spin" />
          )}
          {lastOk && !loading && (
            <span className="text-[10px] text-muted-foreground/60 hidden sm:block">
              {formatLastOk(lastOk)}
            </span>
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
          children
        )}
      </div>
    </div>
  );
}

// ── Panel 1: System Health ────────────────────────────────────────────────────

function HealthPanel({ data, loading, error, lastOk }) {
  const mem = data?.memory;
  const status = data?.status ?? {};
  const heapPct = mem ? Math.round((mem.heapUsedMb / mem.heapTotalMb) * 100) : 0;

  return (
    <Panel icon={Activity} title="System Health" lastOk={lastOk} loading={loading} error={error}>
      <div className="px-4 py-4 space-y-4">
        {/* Status rows */}
        <div className="space-y-2">
          {[
            { label: 'Backend',        key: 'backend' },
            { label: 'Image Pipeline', key: 'imagePipeline' },
            { label: 'Auth',           key: 'auth' },
          ].map(({ label, key }) => (
            <div key={key} className="flex items-center justify-between py-1.5 border-b border-border/20 last:border-0">
              <span className="text-xs text-muted-foreground">{label}</span>
              <div className="flex items-center gap-1.5">
                <StatusDot status={status[key]} />
                <span className={`text-xs font-medium capitalize ${statusColor(status[key])}`}>
                  {status[key] ?? '—'}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Uptime + memory */}
        <div className="grid grid-cols-2 gap-3">
          <div className="glass-subtle rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
              <Clock size={9} /> Uptime
            </div>
            <div className="text-sm font-semibold text-foreground">
              {data ? formatUptime(data.uptimeSeconds) : '—'}
            </div>
          </div>
          <div className="glass-subtle rounded-lg px-3 py-2.5">
            <div className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
              <Cpu size={9} /> Active Users
            </div>
            <div className="text-sm font-semibold text-foreground">
              {data?.activeUsers ?? '—'}
            </div>
          </div>
        </div>

        {/* Memory bar */}
        {mem && (
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground mb-1.5">
              <span>Heap Memory</span>
              <span>{mem.heapUsedMb}MB / {mem.heapTotalMb}MB</span>
            </div>
            <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary/70 rounded-full transition-all duration-700"
                style={{ width: `${heapPct}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground/50 mt-1">
              <span>RSS {mem.rssMb}MB</span>
              <span>Ext {mem.externalMb}MB</span>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ── Panel 2: Active Users ─────────────────────────────────────────────────────

function ActiveUsersPanel({ data, loading, error, lastOk }) {
  const users = data?.users ?? [];

  return (
    <Panel icon={Users} title={`Active Users${data ? ` (${data.count})` : ''}`} lastOk={lastOk} loading={loading} error={error}>
      {users.length === 0 && !loading && !error ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground/60">
          No users active in the last 5 minutes
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/20">
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">User</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Role</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium hidden sm:table-cell">Last Seen</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium hidden md:table-cell">Last Login</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.userId} className="border-b border-border/10 last:border-0 hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-2.5 font-medium text-foreground">{u.username}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${roleBadge(u.role)}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">
                    {formatRelative(u.lastSeenAt)}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden md:table-cell">
                    {u.lastLoginAt ? formatRelative(u.lastLoginAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ── Panel 3: Stats ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }) {
  return (
    <div className={`glass-subtle rounded-lg px-3 py-3 border border-border/20 ${accent || ''}`}>
      <div className="text-2xl font-bold text-foreground tabular-nums">
        {value ?? '—'}
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
      {sub != null && (
        <div className="text-[10px] text-muted-foreground/50 mt-1">{sub}</div>
      )}
    </div>
  );
}

function StatsPanel({ data, loading, error, lastOk }) {
  const [expanded, setExpanded] = useState(false);
  const t = data?.today;
  const b = t?.breakdown;

  return (
    <Panel icon={BarChart2} title="Today's Stats" lastOk={lastOk} loading={loading} error={error}>
      <div className="px-4 py-4 space-y-4">
        {/* Top-level metrics */}
        <div className="grid grid-cols-3 gap-2">
          <StatCard label="Logins" value={t?.totalLoginsToday} />
          <StatCard label="Images" value={t?.totalImagesGeneratedToday} />
          <StatCard
            label="Errors"
            value={t?.totalErrorsToday}
            accent={t?.totalErrorsToday > 0 ? 'border-red-500/20' : ''}
          />
        </div>

        {/* Tracked users */}
        {data?.users && (
          <div className="flex gap-2">
            <div className="glass-subtle rounded-lg px-3 py-2 flex-1 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Tracked users</span>
              <span className="text-xs font-semibold text-foreground">{data.users.trackedSinceStart}</span>
            </div>
            <div className="glass-subtle rounded-lg px-3 py-2 flex-1 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Online now</span>
              <span className="text-xs font-semibold text-emerald-400">{data.users.activeNow}</span>
            </div>
          </div>
        )}

        {/* Expandable breakdown */}
        {b && (
          <div>
            <button
              onClick={() => setExpanded(x => !x)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Breakdown
            </button>

            <AnimatePresence>
              {expanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 space-y-1 border border-border/20 rounded-lg overflow-hidden">
                    {[
                      ['Login success',    b.loginSuccess,        'text-emerald-400'],
                      ['Login failure',    b.loginFailure,        'text-red-400'],
                      ['Signup success',   b.signupSuccess,       'text-emerald-400'],
                      ['Signup failure',   b.signupFailure,       'text-red-400'],
                      ['Images generated', b.imageGenerated,      'text-violet-400'],
                      ['Gen failures',    b.imageGenerateFailed,  'text-red-400'],
                      ['Images edited',   b.imageEdited,          'text-violet-400'],
                      ['Edit failures',   b.imageEditFailed,      'text-red-400'],
                      ['Auth errors',     b.authErrors,           'text-amber-400'],
                      ['System errors',   b.systemErrors,         'text-orange-400'],
                    ].map(([label, val, color]) => (
                      <div key={label} className="flex justify-between items-center px-3 py-1.5 border-b border-border/10 last:border-0 hover:bg-white/[0.02]">
                        <span className="text-[11px] text-muted-foreground">{label}</span>
                        <span className={`text-[11px] font-semibold tabular-nums ${val > 0 ? color : 'text-muted-foreground/40'}`}>
                          {val ?? 0}
                        </span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ── Panel 4: Activity Log ─────────────────────────────────────────────────────

function LogRow({ entry }) {
  const [open, setOpen] = useState(false);
  const s = eventStyle(entry.type);
  const hasMeta = entry.metadata && Object.keys(entry.metadata).length > 0;

  return (
    <>
      <tr
        className={`border-b border-border/10 last:border-0 hover:bg-white/[0.02] transition-colors ${hasMeta ? 'cursor-pointer' : ''}`}
        onClick={() => hasMeta && setOpen(x => !x)}
      >
        <td className="px-4 py-2.5 text-muted-foreground/70 tabular-nums whitespace-nowrap">
          {formatTime(entry.timestamp)}
        </td>
        <td className="px-4 py-2.5">
          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium whitespace-nowrap ${s.color}`}>
            {s.label}
          </span>
        </td>
        <td className="px-4 py-2.5 text-foreground max-w-[120px] truncate">
          {entry.username ?? <span className="text-muted-foreground/40">—</span>}
        </td>
        <td className="px-4 py-2.5 text-muted-foreground/60 text-[11px] max-w-[160px] truncate hidden lg:table-cell">
          {entry.message}
        </td>
        <td className="px-4 py-2.5 text-right">
          {hasMeta && (
            <span className="text-muted-foreground/40 hover:text-muted-foreground transition-colors">
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
          )}
        </td>
      </tr>
      {open && hasMeta && (
        <tr className="bg-white/[0.01]">
          <td colSpan={5} className="px-4 pb-3 pt-1">
            <pre className="text-[10px] text-muted-foreground bg-muted/30 rounded-lg px-3 py-2 overflow-x-auto border border-border/20">
              {JSON.stringify(entry.metadata, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function LogsPanel({ data, loading, error, lastOk }) {
  const entries = data?.entries ?? [];

  return (
    <Panel icon={ScrollText} title={`Audit Log${data ? ` (${data.count} shown)` : ''}`} lastOk={lastOk} loading={loading} error={error}>
      {entries.length === 0 && !loading && !error ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground/60">
          No log entries yet
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/20">
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium whitespace-nowrap">Time</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Event</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">User</th>
                <th className="text-left px-4 py-2.5 text-muted-foreground font-medium hidden lg:table-cell">Message</th>
                <th className="px-4 py-2.5 w-6" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <LogRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ── Panel 5: Render Analytics ─────────────────────────────────────────────────

function VerifierBadge({ outcome }) {
  if (outcome === 'PASS')    return <span className="flex items-center gap-1 text-emerald-400"><CheckCircle size={10} /> Pass</span>;
  if (outcome === 'FAIL')    return <span className="flex items-center gap-1 text-red-400"><XCircle size={10} /> Fail</span>;
  return <span className="flex items-center gap-1 text-muted-foreground/50"><SkipForward size={10} /> Skip</span>;
}

function IntensityChip({ intensity }) {
  const color =
    intensity === 'EXTREME' ? 'text-red-400 bg-red-400/10 border-red-400/20' :
    intensity === 'HIGH'    ? 'text-orange-400 bg-orange-400/10 border-orange-400/20' :
    intensity === 'MEDIUM'  ? 'text-blue-400 bg-blue-400/10 border-blue-400/20' :
    intensity === 'LOW'     ? 'text-sky-300 bg-sky-400/10 border-sky-400/20' :
    'text-muted-foreground bg-muted/30 border-border/30';
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${color}`}>
      {intensity}
    </span>
  );
}

function RenderAnalyticsPanel({ data, loading, error, lastOk }) {
  const [showEntries, setShowEntries] = useState(false);
  const stats   = data?.stats;
  const entries = data?.entries ?? [];

  const profileDist = stats?.profileDistribution ?? {};
  const profileTotal = Object.values(profileDist).reduce((s, v) => s + v, 0);

  return (
    <Panel icon={Film} title="Render Analytics" lastOk={lastOk} loading={loading} error={error}>
      <div className="px-4 py-4 space-y-4">

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'Total Renders',  value: stats?.total ?? '—',            sub: 'since start' },
            { label: 'Avg Duration',   value: stats?.total ? `${(stats.avgDurationMs / 1000).toFixed(1)}s` : '—', sub: 'per render' },
            { label: 'Pass Rate',      value: stats?.total ? `${stats.passRate}%` : '—',  sub: 'verifier ok' },
            { label: 'Retry Rate',     value: stats?.total ? `${stats.retryRate}%` : '—', sub: 'needed retry' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="glass-subtle rounded-lg px-3 py-3 border border-border/20">
              <div className="text-xl font-bold text-foreground tabular-nums">{value}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
              <div className="text-[10px] text-muted-foreground/40 mt-0.5">{sub}</div>
            </div>
          ))}
        </div>

        {/* ── Profile distribution ── */}
        {profileTotal > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1">
              <Film size={9} /> Profile Distribution
            </p>
            <div className="space-y-1.5">
              {Object.entries(profileDist)
                .sort(([, a], [, b]) => b - a)
                .map(([profile, count]) => {
                  const pct = Math.round((count / profileTotal) * 100);
                  return (
                    <div key={profile} className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground w-36 truncate shrink-0">{profile}</span>
                      <div className="flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary/60 rounded-full transition-all duration-700"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground/60 tabular-nums w-8 text-right shrink-0">{count}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* ── Verifier outcome distribution ── */}
        {stats?.verifierOutcomeDistribution && stats.total > 0 && (
          <div className="flex gap-3 flex-wrap">
            {[
              { label: 'Passed',  key: 'PASS',    color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
              { label: 'Failed',  key: 'FAIL',    color: 'text-red-400 bg-red-400/10 border-red-400/20' },
              { label: 'Skipped', key: 'SKIPPED', color: 'text-muted-foreground bg-muted/30 border-border/30' },
            ].map(({ label, key, color }) => (
              <div key={key} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium ${color}`}>
                {label}: {stats.verifierOutcomeDistribution[key] ?? 0}
              </div>
            ))}
          </div>
        )}

        {/* ── Recent entries toggle ── */}
        {entries.length > 0 && (
          <div>
            <button
              onClick={() => setShowEntries((x) => !x)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {showEntries ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Recent renders ({entries.length})
            </button>

            <AnimatePresence>
              {showEntries && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/20">
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium whitespace-nowrap">Time</th>
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium">Profile</th>
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium">Intensity</th>
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium hidden sm:table-cell">Verifier</th>
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium hidden md:table-cell">Duration</th>
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium hidden lg:table-cell">Retries</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((e) => (
                          <tr key={e.id} className="border-b border-border/10 last:border-0 hover:bg-white/[0.02] transition-colors">
                            <td className="px-2 py-2 text-muted-foreground/70 whitespace-nowrap tabular-nums">
                              {formatTime(e.timestamp)}
                            </td>
                            <td className="px-2 py-2 text-foreground max-w-[140px] truncate">
                              {e.renderProfile}
                            </td>
                            <td className="px-2 py-2">
                              <IntensityChip intensity={e.intensity} />
                            </td>
                            <td className="px-2 py-2 hidden sm:table-cell">
                              <VerifierBadge outcome={e.verifierOutcome} />
                            </td>
                            <td className="px-2 py-2 text-muted-foreground/70 tabular-nums hidden md:table-cell">
                              {(e.processingDurationMs / 1000).toFixed(1)}s
                            </td>
                            <td className="px-2 py-2 text-muted-foreground/70 hidden lg:table-cell">
                              {e.retryCount > 0
                                ? <span className="text-amber-400 font-medium">{e.retryCount}</span>
                                : <span className="text-muted-foreground/30">—</span>
                              }
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {!loading && !error && stats?.total === 0 && (
          <p className="text-xs text-muted-foreground/50 text-center py-4">
            No render telemetry yet — data appears after the first image edit.
          </p>
        )}
      </div>
    </Panel>
  );
}

// ── Panel 6: Cinematic Insights ───────────────────────────────────────────────

function CinematicInsightsPanel({ data, loading, error, lastOk }) {
  const [showEdits, setShowEdits] = useState(false);

  return (
    <Panel icon={Sparkles} title="Cinematic Insights" lastOk={lastOk} loading={loading} error={error}>
      <div className="px-4 py-4 space-y-4">

        {/* ── Summary stats ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'Total Edits',    value: data?.totalEdits ?? '—',           sub: 'since start' },
            { label: 'Avg Duration',   value: data?.totalEdits ? `${(data.averageProcessingMs / 1000).toFixed(1)}s` : '—', sub: 'per edit' },
            { label: 'Success Rate',   value: data?.totalEdits ? `${data.successRate}%` : '—',  sub: 'pass rate' },
            { label: 'AI Director',    value: data?.totalEdits ? `${data.cinematicAnalysisEdits}` : '—', sub: 'director used' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="glass-subtle rounded-lg px-3 py-3 border border-border/20">
              <div className="text-xl font-bold text-foreground tabular-nums">{value}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
              <div className="text-[10px] text-muted-foreground/40 mt-0.5">{sub}</div>
            </div>
          ))}
        </div>

        {/* ── Most used styles ── */}
        {data?.mostUsedStyles?.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1">
              <Sparkles size={9} /> Most Used Styles
            </p>
            <div className="space-y-1.5">
              {data.mostUsedStyles.slice(0, 6).map(({ style, count }) => {
                const total = data.mostUsedStyles.reduce((s, e) => s + e.count, 0);
                const pct = Math.round((count / Math.max(total, 1)) * 100);
                return (
                  <div key={style} className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground w-40 truncate shrink-0">{style}</span>
                    <div className="flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary/60 rounded-full transition-all duration-700"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground/60 tabular-nums w-8 text-right shrink-0">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Recent edits toggle ── */}
        {data?.last20Edits?.length > 0 && (
          <div>
            <button
              onClick={() => setShowEdits((x) => !x)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {showEdits ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Recent edits ({data.last20Edits.length})
            </button>

            <AnimatePresence>
              {showEdits && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/20">
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium whitespace-nowrap">Time</th>
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium">Profile</th>
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium hidden sm:table-cell">Duration</th>
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium hidden md:table-cell">Director</th>
                          <th className="text-left px-2 py-2 text-muted-foreground font-medium hidden lg:table-cell">Prompt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.last20Edits.map((e) => (
                          <tr key={e.id} className="border-b border-border/10 last:border-0 hover:bg-white/[0.02] transition-colors">
                            <td className="px-2 py-2 text-muted-foreground/70 whitespace-nowrap tabular-nums">
                              {formatTime(e.timestamp)}
                            </td>
                            <td className="px-2 py-2 text-foreground max-w-[120px] truncate">
                              {e.renderProfile}
                            </td>
                            <td className="px-2 py-2 text-muted-foreground/70 tabular-nums hidden sm:table-cell">
                              {(e.processingDurationMs / 1000).toFixed(1)}s
                            </td>
                            <td className="px-2 py-2 hidden md:table-cell">
                              {e.cinematicAnalysisUsed
                                ? <span className="flex items-center gap-1 text-violet-400"><Sparkles size={9} /> on</span>
                                : <span className="text-muted-foreground/30">off</span>
                              }
                            </td>
                            <td className="px-2 py-2 text-muted-foreground/50 text-[10px] max-w-[200px] truncate hidden lg:table-cell">
                              {e.promptUsed ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {!loading && !error && !data?.totalEdits && (
          <p className="text-xs text-muted-foreground/50 text-center py-4">
            No cinematic edits yet — data appears after the first image edit.
          </p>
        )}
      </div>
    </Panel>
  );
}

// ── Panel 6: Chat Logs (CEO only) ─────────────────────────────────────────────

function ChatLogsPanel() {
  const [sessions, setSessions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastOk, setLastOk] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [sessionMessages, setSessionMessages] = useState({});
  const [loadingMsgs, setLoadingMsgs] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/chat-sessions?limit=100', {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSessions(await res.json());
      setLastOk(Date.now());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleSession(id) {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (sessionMessages[id]) return;
    setLoadingMsgs((p) => ({ ...p, [id]: true }));
    try {
      const res = await fetch(`/api/admin/chat-sessions/${id}/messages`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const msgs = await res.json();
      setSessionMessages((p) => ({ ...p, [id]: msgs }));
    } catch (e) {
      console.error('[ChatLogsPanel] failed to load messages:', e.message);
    } finally {
      setLoadingMsgs((p) => ({ ...p, [id]: false }));
    }
  }

  const isEmpty = !loading && !error && (!sessions || sessions.length === 0);

  return (
    <Panel icon={MessageSquare} title="Chat Logs" lastOk={lastOk} loading={loading} error={error}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-[11px] text-muted-foreground/60">
          {sessions ? `${sessions.length} session${sessions.length !== 1 ? 's' : ''}` : ''}
        </span>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {isEmpty && (
        <p className="text-xs text-muted-foreground/50 text-center py-8">
          No chat sessions yet — conversations will appear here as users chat.
        </p>
      )}

      {sessions && sessions.length > 0 && (
        <div className="divide-y divide-border/20">
          {sessions.map((s) => {
            const isExpanded = expandedId === s.id;
            const msgs = sessionMessages[s.id];
            const isLoadingMsgs = loadingMsgs[s.id];

            return (
              <div key={s.id}>
                {/* Session row */}
                <button
                  onClick={() => toggleSession(s.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/30 transition-colors text-left group"
                >
                  <div className="flex items-center gap-1.5 shrink-0">
                    <User size={11} className="text-muted-foreground/60" />
                    <span className="text-[11px] font-medium text-primary/80 w-20 truncate">
                      {s.username}
                    </span>
                  </div>
                  <span className="flex-1 text-xs text-foreground/80 truncate min-w-0">
                    {s.title}
                  </span>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[10px] text-muted-foreground/60 hidden sm:block">
                      {s.messageCount} msg{s.messageCount !== 1 ? 's' : ''}
                    </span>
                    <span className="text-[10px] text-muted-foreground/50 hidden md:block">
                      {formatRelative(s.updatedAt)}
                    </span>
                    {isExpanded
                      ? <ChevronUp size={12} className="text-muted-foreground" />
                      : <ChevronDown size={12} className="text-muted-foreground/50 group-hover:text-muted-foreground" />
                    }
                  </div>
                </button>

                {/* Expanded messages */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="bg-secondary/20 border-t border-border/20 px-4 py-3 space-y-2 max-h-72 overflow-y-auto">
                        {isLoadingMsgs && (
                          <p className="text-[11px] text-muted-foreground/50 text-center py-2">Loading…</p>
                        )}
                        {msgs && msgs.length === 0 && (
                          <p className="text-[11px] text-muted-foreground/50 text-center py-2">No messages</p>
                        )}
                        {msgs && msgs.map((m) => (
                          <div
                            key={m.id}
                            className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                          >
                            <div className={`
                              max-w-[80%] rounded-lg px-3 py-2 text-[11px] leading-relaxed
                              ${m.role === 'user'
                                ? 'bg-primary/15 text-foreground/90'
                                : 'bg-secondary/60 text-foreground/80'
                              }
                            `}>
                              <div className="flex items-center gap-1.5 mb-1 opacity-60">
                                <span className="font-medium capitalize">{m.role}</span>
                                {m.providerUsed && (
                                  <span className="text-[9px] px-1 rounded border border-border/30">
                                    {m.providerUsed}
                                  </span>
                                )}
                                {m.fallbackUsed && (
                                  <span className="text-[9px] text-amber-400/80">fallback</span>
                                )}
                                {m.latencyMs && (
                                  <span className="text-[9px]">{m.latencyMs}ms</span>
                                )}
                              </div>
                              <p className="whitespace-pre-wrap break-words line-clamp-6">
                                {m.content ?? '[binary content]'}
                              </p>
                            </div>
                          </div>
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
    </Panel>
  );
}

// ── Dashboard header ──────────────────────────────────────────────────────────

function DashboardHeader({ user }) {
  const { theme, toggleTheme } = useTheme();

  const handleLogout = () => {
    logout();
    window.location.href = '/login';
  };

  return (
    <header className="glass-panel border-b border-border/50 sticky top-0 z-10" style={{ borderRadius: 0 }}>
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/chat"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 hover:bg-secondary px-2 py-1.5 rounded-lg"
          >
            <ArrowLeft size={12} />
            <span className="hidden sm:block">Back to Chat</span>
          </Link>
          <div className="h-4 w-px bg-border/40 shrink-0" />
          <div className="flex items-center gap-2 min-w-0">
            <Shield size={14} className="text-primary shrink-0" />
            <span className="text-sm font-semibold text-foreground truncate">CEO Dashboard</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-purple-500/30 bg-purple-500/10 text-purple-300 font-medium hidden sm:inline">
              CEO
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <span className="text-xs text-muted-foreground px-1 hidden lg:block">{user}</span>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-lg hover:bg-secondary transition-colors"
          >
            <LogOut size={13} />
            <span className="hidden sm:block">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

function TabBar({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'overview',  label: 'Overview',   icon: LayoutDashboard },
    { id: 'users',     label: 'Users',      icon: UsersRound },
    { id: 'chatLogs',  label: 'Chat Logs',  icon: MessageSquare },
  ];

  return (
    <div className="border-b border-border/30 bg-background/40 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-4">
        <nav className="flex gap-0" role="tablist">
          {tabs.map(({ id, label, icon: Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={isActive}
                onClick={() => onTabChange(id)}
                className={`
                  relative flex items-center gap-1.5 px-4 py-3 text-xs font-medium
                  transition-colors select-none
                  ${isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground/70'
                  }
                `}
              >
                <Icon size={13} className="shrink-0" />
                {label}
                {isActive && (
                  <motion.div
                    layoutId="tab-indicator"
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CeoDashboard() {
  const { health, stats, activeUsers, logs, renderAnalytics, cinematicInsights, activityTimeline, aiStatus, globalErrorCode } = useAdminPolling();
  const [activeTab, setActiveTab] = useState('overview');

  // Handle global auth errors
  if (globalErrorCode === 'unauthorized') {
    return <Redirect to="/login" />;
  }

  if (globalErrorCode === 'forbidden') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="glass-card rounded-xl p-8 max-w-sm w-full text-center space-y-4">
          <Shield size={32} className="text-destructive mx-auto" />
          <h1 className="text-lg font-semibold text-foreground">CEO Access Required</h1>
          <p className="text-sm text-muted-foreground">
            This dashboard is only accessible to CEO accounts.
          </p>
          <Link href="/chat" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
            <ArrowLeft size={13} /> Back to Chat
          </Link>
        </div>
      </div>
    );
  }

  const cachedUser = (() => {
    try { return JSON.parse(localStorage.getItem('ib_cached_user')) || null; }
    catch { return null; }
  })();

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader user={cachedUser?.username ?? 'CEO'} />
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      <main className="max-w-7xl mx-auto px-4 py-5">
        <AnimatePresence mode="wait">
          {activeTab === 'overview' ? (
            <motion.div
              key="overview"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
            >
              {/* Top row: Health + Active Users */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <HealthPanel
                  data={health.data}
                  loading={health.loading}
                  error={health.error}
                  lastOk={health.lastOk}
                />
                <ActiveUsersPanel
                  data={activeUsers.data}
                  loading={activeUsers.loading}
                  error={activeUsers.error}
                  lastOk={activeUsers.lastOk}
                />
              </div>

              {/* Bottom row: Stats (narrow) + Logs (wide) */}
              <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4 mt-4">
                <StatsPanel
                  data={stats.data}
                  loading={stats.loading}
                  error={stats.error}
                  lastOk={stats.lastOk}
                />
                <LogsPanel
                  data={logs.data}
                  loading={logs.loading}
                  error={logs.error}
                  lastOk={logs.lastOk}
                />
              </div>

              {/* AI Routing — full width */}
              <div className="mt-4">
                <AiRoutingPanel
                  data={aiStatus.data}
                  loading={aiStatus.loading}
                  error={aiStatus.error}
                  lastOk={aiStatus.lastOk}
                />
              </div>

              {/* Render Analytics — full width */}
              <div className="mt-4">
                <RenderAnalyticsPanel
                  data={renderAnalytics.data}
                  loading={renderAnalytics.loading}
                  error={renderAnalytics.error}
                  lastOk={renderAnalytics.lastOk}
                />
              </div>

              {/* Cinematic Insights — full width */}
              <div className="mt-4">
                <CinematicInsightsPanel
                  data={cinematicInsights.data}
                  loading={cinematicInsights.loading}
                  error={cinematicInsights.error}
                  lastOk={cinematicInsights.lastOk}
                />
              </div>

              {/* Activity Timeline — full width */}
              <div className="mt-4">
                <ActivityTimelinePanel
                  data={activityTimeline.data}
                  loading={activityTimeline.loading}
                  error={activityTimeline.error}
                  lastOk={activityTimeline.lastOk}
                />
              </div>

              <p className="text-center text-[10px] text-muted-foreground/40 mt-6 pb-4">
                Live data — health 8s · stats 10s · users 12s · logs 15s · render analytics 20s · cinematic insights 25s · ai routing 30s · timeline 30s
              </p>
            </motion.div>
          ) : activeTab === 'users' ? (
            <motion.div
              key="users"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
            >
              <UsersDirectoryPanel />
              <p className="text-center text-[10px] text-muted-foreground/40 mt-6 pb-4">
                User list refreshes every 30s — read-only view
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="chatLogs"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
            >
              <ChatLogsPanel />
              <p className="text-center text-[10px] text-muted-foreground/40 mt-6 pb-4">
                All user conversations — click a session to expand messages
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
