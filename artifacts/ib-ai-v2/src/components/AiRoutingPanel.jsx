/**
 * AiRoutingPanel — Live AI provider routing visibility panel.
 *
 * Consumes /api/system/ai-status (via props from useAdminPolling).
 * Auto-refresh is handled by the parent hook (30s interval).
 *
 * Sections:
 *   1. Provider status — active provider card + availability pills
 *   2. Performance KPIs — avg latency + success rate per provider
 *   3. Routing stats — total requests, fallbacks, fallback rate, last fallback
 *
 * Color coding:
 *   green  — Groq active as primary, healthy
 *   blue   — Gemini active as primary (Groq not configured), normal
 *   yellow — Fallback triggered (Groq failed → Gemini serving)
 *   red    — No provider available / degraded
 */
import { AlertCircle, RefreshCw, Zap, CheckCircle, XCircle, ArrowRightLeft, Activity } from 'lucide-react';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (ms == null) return '—';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms >= 1000)   return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatRelative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 5_000)     return 'just now';
  if (diff < 60_000)    return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatLastOk(ms) {
  if (!ms) return null;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 3) return 'just now';
  return `${diff}s ago`;
}

// ── Provider state classifier ─────────────────────────────────────────────────

function classifyState(data) {
  if (!data) return { state: 'loading', label: '…', color: 'muted' };

  const { activeProvider, groqAvailable, geminiAvailable, fallbackCount } = data;

  if (!groqAvailable && !geminiAvailable) {
    return { state: 'red',    label: 'Degraded',        color: 'red' };
  }
  if (fallbackCount > 0 && activeProvider === 'gemini') {
    return { state: 'yellow', label: 'Fallback Active', color: 'yellow' };
  }
  if (groqAvailable && activeProvider === 'groq') {
    return { state: 'green',  label: 'Groq Primary',    color: 'green' };
  }
  if (!groqAvailable && geminiAvailable) {
    return { state: 'blue',   label: 'Gemini Primary',  color: 'blue' };
  }
  if (activeProvider === 'none') {
    return { state: 'muted',  label: 'No Requests Yet', color: 'muted' };
  }
  return { state: 'green',  label: 'Healthy',           color: 'green' };
}

const STATE_STYLES = {
  green:  { ring: 'border-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400', pulse: 'bg-emerald-400' },
  blue:   { ring: 'border-sky-500/30',     bg: 'bg-sky-500/10',     text: 'text-sky-400',     dot: 'bg-sky-400',     pulse: 'bg-sky-400' },
  yellow: { ring: 'border-amber-500/30',   bg: 'bg-amber-500/10',   text: 'text-amber-400',   dot: 'bg-amber-400',   pulse: 'bg-amber-400' },
  red:    { ring: 'border-red-500/30',     bg: 'bg-red-500/10',     text: 'text-red-400',     dot: 'bg-red-400',     pulse: 'bg-red-400' },
  muted:  { ring: 'border-border/20',      bg: 'bg-muted/20',       text: 'text-muted-foreground', dot: 'bg-muted-foreground/40', pulse: '' },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function AvailabilityPill({ label, available }) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium ${
      available
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
        : 'border-border/20 bg-muted/20 text-muted-foreground/50'
    }`}>
      {available
        ? <CheckCircle size={10} className="shrink-0" />
        : <XCircle    size={10} className="shrink-0" />
      }
      {label}
    </div>
  );
}

function KpiCard({ label, value, sub, accent }) {
  return (
    <div className={`glass-subtle rounded-lg px-3 py-3 border border-border/20 ${accent ?? ''}`}>
      <div className="text-xl font-bold text-foreground tabular-nums">{value ?? '—'}</div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-muted-foreground/40 mt-0.5">{sub}</div>}
    </div>
  );
}

function StatRow({ label, value, valueClass }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/10 last:border-0">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-[11px] font-semibold tabular-nums ${valueClass ?? 'text-foreground'}`}>
        {value ?? '—'}
      </span>
    </div>
  );
}

// ── Panel wrapper (local — matches CeoDashboard pattern) ─────────────────────

function Panel({ icon: Icon, title, lastOk, loading, error, children }) {
  return (
    <div className="glass-card rounded-xl flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">{title}</span>
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

// ── Main export ───────────────────────────────────────────────────────────────

export function AiRoutingPanel({ data, loading, error, lastOk }) {
  const { state, label, color } = classifyState(data);
  const styles = STATE_STYLES[color] ?? STATE_STYLES.muted;

  const providerLabel = data?.activeProvider
    ? data.activeProvider === 'none' ? 'None' : data.activeProvider.toUpperCase()
    : '—';

  const fallbackRate = data?.fallbackRate;
  const fallbackRateClass =
    fallbackRate == null     ? 'text-muted-foreground/40' :
    fallbackRate === 0       ? 'text-emerald-400' :
    fallbackRate < 20        ? 'text-amber-400' :
    'text-red-400';

  const successRateClass = (rate) =>
    rate == null   ? 'text-muted-foreground' :
    rate >= 95     ? 'text-emerald-400' :
    rate >= 80     ? 'text-amber-400' :
    'text-red-400';

  return (
    <Panel icon={Activity} title="AI Routing" lastOk={lastOk} loading={loading} error={error}>
      <div className="px-4 py-4 space-y-5">

        {/* ── Section 1: Active provider + availability ── */}
        <div className="flex flex-col sm:flex-row gap-3">

          {/* Active provider card */}
          <div className={`flex-1 flex items-center gap-3 px-4 py-3.5 rounded-xl border ${styles.ring} ${styles.bg}`}>
            <div className="relative shrink-0">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${styles.dot}`} />
              {state !== 'muted' && state !== 'loading' && (
                <span className={`absolute inset-0 rounded-full ${styles.pulse} opacity-40 animate-ping`} />
              )}
            </div>
            <div className="min-w-0">
              <div className={`text-xs font-semibold ${styles.text}`}>{label}</div>
              <div className="text-xl font-bold text-foreground tabular-nums mt-0.5 leading-none">
                {providerLabel}
              </div>
              <div className="text-[10px] text-muted-foreground/60 mt-1">active provider</div>
            </div>
            <ArrowRightLeft size={16} className={`ml-auto shrink-0 ${styles.text} opacity-50`} />
          </div>

          {/* Availability pills */}
          <div className="flex sm:flex-col gap-2 justify-start sm:justify-center shrink-0">
            <AvailabilityPill label="Groq"   available={data?.groqAvailable ?? false} />
            <AvailabilityPill label="Gemini" available={data?.geminiAvailable ?? false} />
          </div>
        </div>

        {/* ── Section 2: Performance KPIs ── */}
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1">
            <Zap size={9} /> Performance
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <KpiCard
              label="Groq Avg Latency"
              value={formatMs(data?.avgLatencyGroq)}
              sub="per stream"
            />
            <KpiCard
              label="Gemini Avg Latency"
              value={formatMs(data?.avgLatencyGemini)}
              sub="per stream"
            />
            <KpiCard
              label="Groq Success Rate"
              value={data?.successRateGroq != null ? `${data.successRateGroq}%` : null}
              sub="of requests"
              accent={data?.successRateGroq != null && data.successRateGroq < 80 ? 'border-red-500/20' : ''}
            />
            <KpiCard
              label="Gemini Success Rate"
              value={data?.successRateGemini != null ? `${data.successRateGemini}%` : null}
              sub="of requests"
              accent={data?.successRateGemini != null && data.successRateGemini < 80 ? 'border-red-500/20' : ''}
            />
          </div>
        </div>

        {/* ── Section 3: Routing stats ── */}
        <div className="border border-border/20 rounded-lg px-3 py-1">
          <StatRow
            label="Total Requests"
            value={data?.totalRequests ?? 0}
          />
          <StatRow
            label="Fallback Count"
            value={data?.fallbackCount ?? 0}
            valueClass={data?.fallbackCount > 0 ? 'text-amber-400' : 'text-muted-foreground/40'}
          />
          <StatRow
            label="Fallback Rate"
            value={fallbackRate != null ? `${fallbackRate}%` : '—'}
            valueClass={fallbackRateClass}
          />
          <StatRow
            label="Last Fallback"
            value={formatRelative(data?.lastFallback)}
            valueClass={data?.lastFallback ? 'text-amber-400' : 'text-muted-foreground/40'}
          />
        </div>

        {/* ── Zero state ── */}
        {!loading && !error && data?.totalRequests === 0 && (
          <p className="text-[11px] text-muted-foreground/50 text-center">
            No AI requests yet — metrics appear after the first chat message.
          </p>
        )}

      </div>
    </Panel>
  );
}
