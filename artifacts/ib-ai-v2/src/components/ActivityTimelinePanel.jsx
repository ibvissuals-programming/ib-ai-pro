/**
 * ActivityTimelinePanel — Global system activity feed for the CEO dashboard.
 *
 * Consumes: GET /api/admin/logs?limit=100
 * Renders the audit log as a vertical event timeline with colored type badges,
 * relative timestamps, and usernames.
 *
 * All data comes from the existing auditLog — no new backend required.
 */

import { RefreshCw, AlertCircle, Activity, LogIn, UserPlus, Image, Wand2, AlertTriangle, Cpu } from 'lucide-react';

// ── Event config ──────────────────────────────────────────────────────────────

const EVENT_CONFIG = {
  login_success:          { label: 'Login',           icon: LogIn,      dot: 'bg-emerald-400',  text: 'text-emerald-400',  bg: 'bg-emerald-400/10',  border: 'border-emerald-400/20' },
  login_failure:          { label: 'Login failed',    icon: LogIn,      dot: 'bg-red-400',      text: 'text-red-400',      bg: 'bg-red-400/10',      border: 'border-red-400/20' },
  signup_success:         { label: 'New account',     icon: UserPlus,   dot: 'bg-sky-400',      text: 'text-sky-400',      bg: 'bg-sky-400/10',      border: 'border-sky-400/20' },
  signup_failure:         { label: 'Signup failed',   icon: UserPlus,   dot: 'bg-red-400',      text: 'text-red-400',      bg: 'bg-red-400/10',      border: 'border-red-400/20' },
  image_generate_success: { label: 'Image generated', icon: Wand2,      dot: 'bg-violet-400',   text: 'text-violet-400',   bg: 'bg-violet-400/10',   border: 'border-violet-400/20' },
  image_generate_failure: { label: 'Gen failed',      icon: Wand2,      dot: 'bg-red-400',      text: 'text-red-400',      bg: 'bg-red-400/10',      border: 'border-red-400/20' },
  image_edit_success:     { label: 'Image edited',    icon: Image,      dot: 'bg-violet-400',   text: 'text-violet-400',   bg: 'bg-violet-400/10',   border: 'border-violet-400/20' },
  image_edit_failure:     { label: 'Edit failed',     icon: Image,      dot: 'bg-red-400',      text: 'text-red-400',      bg: 'bg-red-400/10',      border: 'border-red-400/20' },
  image_analysis_success: { label: 'Image analyzed',  icon: Cpu,        dot: 'bg-indigo-400',   text: 'text-indigo-400',   bg: 'bg-indigo-400/10',   border: 'border-indigo-400/20' },
  image_analysis_failure: { label: 'Analysis failed', icon: Cpu,        dot: 'bg-red-400',      text: 'text-red-400',      bg: 'bg-red-400/10',      border: 'border-red-400/20' },
  auth_error:             { label: 'Auth error',      icon: AlertTriangle, dot: 'bg-amber-400', text: 'text-amber-400',    bg: 'bg-amber-400/10',    border: 'border-amber-400/20' },
  system_error:           { label: 'System error',    icon: AlertTriangle, dot: 'bg-orange-400',text: 'text-orange-400',   bg: 'bg-orange-400/10',   border: 'border-orange-400/20' },
};

function getConfig(type) {
  return EVENT_CONFIG[type] ?? {
    label: type,
    icon: Activity,
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    bg: 'bg-muted/30',
    border: 'border-border/30',
  };
}

// ── Formatting ─────────────────────────────────────────────────────────────────

function formatRelative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 5_000)      return 'just now';
  if (diff < 60_000)     return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' });
}

function formatTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Lagos' });
}

function formatLastOk(ms) {
  if (!ms) return null;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 3) return 'just now';
  return `${diff}s ago`;
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function SkeletonEvent() {
  return (
    <div className="flex gap-3 items-start py-2">
      <div className="flex flex-col items-center shrink-0 mt-0.5">
        <div className="w-2 h-2 rounded-full bg-muted/40 animate-pulse" />
        <div className="w-px flex-1 bg-border/10 mt-1 min-h-[20px]" />
      </div>
      <div className="flex-1 min-w-0 space-y-1.5 pb-2">
        <div className="flex items-center gap-2">
          <div className="h-3 w-16 bg-muted/40 rounded animate-pulse" />
          <div className="h-3 w-10 bg-muted/30 rounded animate-pulse" />
        </div>
        <div className="h-2.5 w-3/4 bg-muted/30 rounded animate-pulse" />
      </div>
    </div>
  );
}

// ── Event row ──────────────────────────────────────────────────────────────────

function EventRow({ entry, isLast }) {
  const cfg = getConfig(entry.type);
  const Icon = cfg.icon;

  return (
    <div className="flex gap-3 items-start group">
      {/* Timeline spine */}
      <div className="flex flex-col items-center shrink-0 mt-1">
        <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
        {!isLast && <span className="w-px flex-1 bg-border/15 mt-1 min-h-[28px]" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-3">
        <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
          {/* Type badge */}
          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide ${cfg.text} ${cfg.bg} ${cfg.border}`}>
            <Icon size={7} />
            {cfg.label}
          </span>

          {/* Username */}
          {entry.username && (
            <span className="text-[10px] text-muted-foreground/70 font-medium">
              {entry.username}
            </span>
          )}

          {/* Time */}
          <span className="text-[9px] text-muted-foreground/40 ml-auto" title={formatTime(entry.timestamp)}>
            {formatRelative(entry.timestamp)}
          </span>
        </div>

        {/* Message */}
        <p className="text-[10px] text-muted-foreground/60 leading-relaxed line-clamp-1">
          {entry.message}
        </p>
      </div>
    </div>
  );
}

// ── Summary chips ─────────────────────────────────────────────────────────────

function SummaryChips({ entries }) {
  if (!entries || entries.length === 0) return null;

  const counts = entries.reduce((acc, e) => {
    const key = e.type.includes('failure') || e.type.includes('error') ? 'errors' :
                e.type.includes('image') ? 'images' :
                e.type.includes('login') || e.type.includes('signup') ? 'auth' : 'other';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const chips = [
    { key: 'images', label: 'renders',  color: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
    { key: 'auth',   label: 'auth',     color: 'text-sky-400 bg-sky-400/10 border-sky-400/20' },
    { key: 'errors', label: 'errors',   color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  ].filter(({ key }) => counts[key] > 0);

  return (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border/15">
      <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wide mr-1">Last {entries.length}</span>
      {chips.map(({ key, label, color }) => (
        <span key={key} className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold tabular-nums ${color}`}>
          {counts[key]} {label}
        </span>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ActivityTimelinePanel({ data, loading, error, lastOk }) {
  const entries = data?.entries ?? [];

  return (
    <div className="glass-card rounded-xl flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">
            Activity Timeline
            {data?.count != null && (
              <span className="ml-1.5 text-xs text-muted-foreground font-normal">
                ({data.count} events)
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw size={11} className="text-muted-foreground animate-spin" />}
          {lastOk && !loading && (
            <span className="text-[10px] text-muted-foreground/60 hidden sm:block">
              {formatLastOk(lastOk)}
            </span>
          )}
        </div>
      </div>

      {/* Summary chips */}
      {!error && entries.length > 0 && <SummaryChips entries={entries} />}

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 py-3 max-h-96">
        {error && !loading ? (
          <div className="flex items-center gap-2 py-8 text-xs text-amber-400/80 justify-center">
            <AlertCircle size={13} />
            {error}
          </div>
        ) : loading && entries.length === 0 ? (
          <div className="space-y-0">
            {Array.from({ length: 8 }).map((_, i) => <SkeletonEvent key={i} />)}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Activity size={20} className="text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No activity yet</p>
            <p className="text-xs text-muted-foreground/50">Events will appear here as users interact with the system</p>
          </div>
        ) : (
          <div>
            {entries.map((entry, i) => (
              <EventRow key={entry.id} entry={entry} isLast={i === entries.length - 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
