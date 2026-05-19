/**
 * AiRoutingPanel — Live AI provider routing visibility + diagnostic console.
 *
 * Consumes /api/system/ai-status (via props from useAdminPolling, 30s poll).
 *
 * Sections:
 *   1. Provider status   — active provider card + availability pills
 *   2. Performance KPIs  — avg latency + success rate per provider
 *   3. Routing stats     — total requests, fallbacks, fallback rate, last fallback
 *   4. Diagnostic loop   — controlled test executor with 3 modes + real-time feedback
 *
 * Color coding:
 *   green  — Groq active as primary, healthy
 *   blue   — Gemini active as primary (Groq not configured), normal
 *   yellow — Fallback triggered (Groq failed → Gemini serving)
 *   red    — No provider available / degraded
 *
 * Diagnostic loop safety:
 *   - CEO-only (panel is already CEO-gated by the dashboard)
 *   - Sends directly to /api/chat — full middleware stack, real metrics
 *   - Does NOT write to chat history (direct fetch, no useChat hook)
 *   - AbortController allows mid-stream cancellation
 */
import { useState, useRef } from 'react';
import {
  AlertCircle, RefreshCw, Zap, CheckCircle, XCircle,
  ArrowRightLeft, Activity, Play, Square, Loader2,
  FlaskConical, Clock, TriangleAlert,
} from 'lucide-react';
import { getAuthHeaders } from '../auth/authService';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

const TEST_MODES = {
  LIGHT: {
    label: 'Light',
    desc: 'Minimum prompt — pure latency measurement',
    prompt: 'Reply in exactly one sentence: what AI model are you?',
    color: 'text-sky-400 border-sky-500/20 bg-sky-500/10',
    activeColor: 'border-sky-400/40 bg-sky-500/15 text-sky-300',
  },
  STANDARD: {
    label: 'Standard',
    desc: 'Normal complexity — production equivalent',
    prompt: 'System diagnostic test. Confirm your model identity and respond with a short 2-sentence structured reply.',
    color: 'text-violet-400 border-violet-500/20 bg-violet-500/10',
    activeColor: 'border-violet-400/40 bg-violet-500/15 text-violet-300',
  },
  STRESS: {
    label: 'Stress',
    desc: 'Long prompt — tests throughput and fallback pressure',
    prompt: 'Write a detailed technical analysis covering: (1) AI provider routing strategies and primary/fallback patterns in production, (2) latency optimization in streaming APIs, (3) retry logic and circuit breaker design for reliability, (4) observability and monitoring best practices for AI inference layers. Be thorough and use clear section headings.',
    color: 'text-orange-400 border-orange-500/20 bg-orange-500/10',
    activeColor: 'border-orange-400/40 bg-orange-500/15 text-orange-300',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (ms == null) return '—';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms >= 1_000)  return `${(ms / 1000).toFixed(1)}s`;
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
  if (!groqAvailable && !geminiAvailable)               return { state: 'red',    label: 'Degraded',        color: 'red' };
  if (fallbackCount > 0 && activeProvider === 'gemini') return { state: 'yellow', label: 'Fallback Active', color: 'yellow' };
  if (groqAvailable && activeProvider === 'groq')       return { state: 'green',  label: 'Groq Primary',    color: 'green' };
  if (!groqAvailable && geminiAvailable)                return { state: 'blue',   label: 'Gemini Primary',  color: 'blue' };
  if (activeProvider === 'none')                        return { state: 'muted',  label: 'No Requests Yet', color: 'muted' };
  return { state: 'green', label: 'Healthy', color: 'green' };
}

const STATE_STYLES = {
  green:  { ring: 'border-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400', pulse: 'bg-emerald-400' },
  blue:   { ring: 'border-sky-500/30',     bg: 'bg-sky-500/10',     text: 'text-sky-400',     dot: 'bg-sky-400',     pulse: 'bg-sky-400' },
  yellow: { ring: 'border-amber-500/30',   bg: 'bg-amber-500/10',   text: 'text-amber-400',   dot: 'bg-amber-400',   pulse: 'bg-amber-400' },
  red:    { ring: 'border-red-500/30',     bg: 'bg-red-500/10',     text: 'text-red-400',     dot: 'bg-red-400',     pulse: 'bg-red-400' },
  muted:  { ring: 'border-border/20',      bg: 'bg-muted/20',       text: 'text-muted-foreground', dot: 'bg-muted-foreground/40', pulse: '' },
};

// ── Phase metadata ────────────────────────────────────────────────────────────

const PHASE_META = {
  connecting:  { label: 'Connecting to AI pipeline…',   color: 'text-sky-400',     spin: true  },
  streaming:   { label: 'Streaming response…',           color: 'text-violet-400',  spin: false },
  refreshing:  { label: 'Updating metrics…',             color: 'text-amber-400',   spin: true  },
  done:        { label: 'Test complete',                 color: 'text-emerald-400', spin: false },
  error:       { label: 'Test failed',                   color: 'text-red-400',     spin: false },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function AvailabilityPill({ label, available }) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium ${
      available
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
        : 'border-border/20 bg-muted/20 text-muted-foreground/50'
    }`}>
      {available ? <CheckCircle size={10} className="shrink-0" /> : <XCircle size={10} className="shrink-0" />}
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

// ── Diagnostic result card ────────────────────────────────────────────────────

function ResultCard({ result, phase }) {
  if (!result && phase === 'idle') return null;

  const isBusy = phase === 'connecting' || phase === 'streaming' || phase === 'refreshing';
  const meta   = PHASE_META[phase];

  // Streaming pulse dot
  const StreamDot = () => (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-60" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-400" />
    </span>
  );

  return (
    <div className={`rounded-xl border px-4 py-3.5 space-y-3 transition-colors ${
      phase === 'done'  ? 'border-emerald-500/20 bg-emerald-500/5' :
      phase === 'error' ? 'border-red-500/20 bg-red-500/5' :
      'border-border/20 bg-muted/10'
    }`}>
      {/* Phase status row */}
      <div className="flex items-center gap-2">
        {isBusy ? (
          phase === 'streaming'
            ? <StreamDot />
            : <Loader2 size={12} className={`shrink-0 animate-spin ${meta?.color}`} />
        ) : phase === 'done' ? (
          <CheckCircle size={12} className="shrink-0 text-emerald-400" />
        ) : (
          <XCircle size={12} className="shrink-0 text-red-400" />
        )}
        <span className={`text-[11px] font-semibold ${meta?.color ?? 'text-muted-foreground'}`}>
          {meta?.label}
        </span>
        {result?.latencyMs != null && (
          <span className="ml-auto text-[11px] text-muted-foreground/60 flex items-center gap-1 tabular-nums">
            <Clock size={9} /> {formatMs(result.latencyMs)}
          </span>
        )}
      </div>

      {/* Result detail — only when done or error */}
      {result && !isBusy && (
        <>
          {result.success ? (
            <div className="grid grid-cols-3 gap-2">
              {/* Provider used */}
              <div className="glass-subtle rounded-lg px-3 py-2.5 border border-border/20">
                <div className="text-[10px] text-muted-foreground mb-1">Provider</div>
                <div className={`text-sm font-bold uppercase ${
                  result.providerUsed === 'groq'   ? 'text-emerald-400' :
                  result.providerUsed === 'gemini' ? 'text-sky-400' :
                  'text-muted-foreground'
                }`}>
                  {result.providerUsed ?? '—'}
                </div>
              </div>

              {/* Latency */}
              <div className="glass-subtle rounded-lg px-3 py-2.5 border border-border/20">
                <div className="text-[10px] text-muted-foreground mb-1">Latency</div>
                <div className="text-sm font-bold text-foreground tabular-nums">
                  {formatMs(result.latencyMs)}
                </div>
              </div>

              {/* Fallback */}
              <div className={`rounded-lg px-3 py-2.5 border ${
                result.fallbackOccurred
                  ? 'border-amber-500/20 bg-amber-500/10'
                  : 'glass-subtle border-border/20'
              }`}>
                <div className="text-[10px] text-muted-foreground mb-1">Fallback</div>
                <div className={`text-sm font-bold ${result.fallbackOccurred ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {result.fallbackOccurred ? 'Yes' : 'No'}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-xs text-red-400/80">
              <TriangleAlert size={12} className="shrink-0 mt-0.5" />
              <span className="break-all">{result.error ?? 'Unknown error'}</span>
            </div>
          )}

          {/* Updated metrics after test */}
          {result.freshStatus && result.success && (
            <div className="border-t border-border/20 pt-2.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">
                Updated Metrics
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[11px]">
                {[
                  { label: 'Total Requests',  value: result.freshStatus.totalRequests },
                  { label: 'Fallback Count',  value: result.freshStatus.fallbackCount,
                    cls: result.freshStatus.fallbackCount > 0 ? 'text-amber-400' : '' },
                  { label: 'Groq Latency',    value: formatMs(result.freshStatus.avgLatencyGroq) },
                  { label: 'Gemini Latency',  value: formatMs(result.freshStatus.avgLatencyGemini) },
                ].map(({ label, value, cls }) => (
                  <div key={label} className="glass-subtle rounded-md px-2 py-1.5 border border-border/10">
                    <div className="text-muted-foreground/60 text-[10px]">{label}</div>
                    <div className={`font-semibold tabular-nums ${cls ?? 'text-foreground'}`}>{value ?? '—'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function AiRoutingPanel({ data, loading, error, lastOk }) {
  // ── Routing display state ─────────────────────────────────────────────────
  const { state, label, color } = classifyState(data);
  const styles = STATE_STYLES[color] ?? STATE_STYLES.muted;

  const providerLabel = data?.activeProvider
    ? data.activeProvider === 'none' ? 'None' : data.activeProvider.toUpperCase()
    : '—';

  const fallbackRate = data?.fallbackRate;
  const fallbackRateClass =
    fallbackRate == null ? 'text-muted-foreground/40' :
    fallbackRate === 0   ? 'text-emerald-400' :
    fallbackRate < 20    ? 'text-amber-400' :
    'text-red-400';

  // ── Diagnostic loop state ─────────────────────────────────────────────────
  const [testMode, setTestMode] = useState('STANDARD');
  const [phase, setPhase]       = useState('idle'); // idle | connecting | streaming | refreshing | done | error
  const [result, setResult]     = useState(null);
  const abortRef = useRef(null);

  const isBusy = phase === 'connecting' || phase === 'streaming' || phase === 'refreshing';

  async function runTest() {
    if (isBusy) return;

    const snapshotFallbackCount = data?.fallbackCount ?? 0;

    setPhase('connecting');
    setResult(null);

    const startMs = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          messages: [{ role: 'user', content: TEST_MODES[testMode].prompt }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        setResult({
          success: false,
          error: errJson.error || (res.status === 402 ? 'Insufficient credits' : `HTTP ${res.status}`),
          latencyMs: Date.now() - startMs,
        });
        setPhase('error');
        return;
      }

      // ── Consume SSE stream ─────────────────────────────────────────────────
      setPhase('streaming');

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let streamError = null;

      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') break outer;
          try {
            const json = JSON.parse(raw);
            if (json.error) { streamError = json.code || 'Stream error'; break outer; }
          } catch { /* skip malformed lines */ }
        }
      }
      reader.releaseLock();

      const latencyMs = Date.now() - startMs;

      if (streamError) {
        setResult({ success: false, error: streamError, latencyMs });
        setPhase('error');
        return;
      }

      // ── Immediately refresh ai-status ──────────────────────────────────────
      setPhase('refreshing');

      let freshStatus = null;
      try {
        const statusRes = await fetch(`${BASE}/api/system/ai-status`, {
          headers: getAuthHeaders(),
          signal: controller.signal,
        });
        if (statusRes.ok) freshStatus = await statusRes.json();
      } catch { /* non-fatal — result still shown without fresh metrics */ }

      const fallbackOccurred = freshStatus
        ? (freshStatus.fallbackCount ?? 0) > snapshotFallbackCount
        : false;

      setResult({
        success: true,
        latencyMs,
        mode: testMode,
        providerUsed: freshStatus?.activeProvider ?? null,
        fallbackOccurred,
        freshStatus,
      });
      setPhase('done');

    } catch (err) {
      if (err.name === 'AbortError') {
        setPhase('idle');
        return;
      }
      setResult({
        success: false,
        error: err.message || 'Network error',
        latencyMs: Date.now() - startMs,
      });
      setPhase('error');
    }
  }

  function cancelTest() {
    abortRef.current?.abort();
    setPhase('idle');
    setResult(null);
  }

  function resetTest() {
    setPhase('idle');
    setResult(null);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Panel icon={Activity} title="AI Routing" lastOk={lastOk} loading={loading} error={error}>
      <div className="px-4 py-4 space-y-5">

        {/* ── Section 1: Active provider + availability ── */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className={`flex-1 flex items-center gap-3 px-4 py-3.5 rounded-xl border ${styles.ring} ${styles.bg}`}>
            <div className="relative shrink-0">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${styles.dot}`} />
              {state !== 'muted' && state !== 'loading' && (
                <span className={`absolute inset-0 rounded-full ${styles.pulse} opacity-40 animate-ping`} />
              )}
            </div>
            <div className="min-w-0">
              <div className={`text-xs font-semibold ${styles.text}`}>{label}</div>
              <div className="text-xl font-bold text-foreground tabular-nums mt-0.5 leading-none">{providerLabel}</div>
              <div className="text-[10px] text-muted-foreground/60 mt-1">active provider</div>
            </div>
            <ArrowRightLeft size={16} className={`ml-auto shrink-0 ${styles.text} opacity-50`} />
          </div>

          <div className="flex sm:flex-col gap-2 justify-start sm:justify-center shrink-0">
            <AvailabilityPill label="Groq"   available={data?.groqAvailable   ?? false} />
            <AvailabilityPill label="Gemini" available={data?.geminiAvailable ?? false} />
          </div>
        </div>

        {/* ── Section 2: Performance KPIs ── */}
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1">
            <Zap size={9} /> Performance
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <KpiCard label="Groq Avg Latency"   value={formatMs(data?.avgLatencyGroq)}   sub="per stream" />
            <KpiCard label="Gemini Avg Latency" value={formatMs(data?.avgLatencyGemini)} sub="per stream" />
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
          <StatRow label="Total Requests" value={data?.totalRequests ?? 0} />
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

        {!loading && !error && data?.totalRequests === 0 && phase === 'idle' && (
          <p className="text-[11px] text-muted-foreground/50 text-center -mt-1">
            No AI requests yet — run a diagnostic test or send a chat message to populate metrics.
          </p>
        )}

        {/* ── Section 4: Diagnostic Loop ── */}
        <div className="border-t border-border/20 pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
              <FlaskConical size={10} /> Diagnostic Loop
            </p>
            {(phase === 'done' || phase === 'error') && (
              <button
                onClick={resetTest}
                className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* Mode selector */}
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(TEST_MODES).map(([key, mode]) => {
              const active = testMode === key;
              return (
                <button
                  key={key}
                  onClick={() => !isBusy && setTestMode(key)}
                  disabled={isBusy}
                  className={`
                    relative px-2.5 py-2.5 rounded-lg border text-left transition-all
                    ${active ? mode.activeColor : 'border-border/20 bg-muted/10 hover:bg-muted/20 text-muted-foreground'}
                    ${isBusy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                  `}
                >
                  <div className="text-[11px] font-semibold mb-0.5">{mode.label}</div>
                  <div className="text-[10px] opacity-70 leading-tight">{mode.desc}</div>
                  {active && (
                    <span className="absolute top-1.5 right-1.5">
                      <CheckCircle size={9} className="opacity-70" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Run / Cancel button */}
          <div className="flex gap-2">
            {isBusy ? (
              <button
                onClick={cancelTest}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-red-500/20 bg-red-500/10 text-red-400 text-xs font-medium hover:bg-red-500/20 transition-colors w-full justify-center"
              >
                <Square size={11} className="shrink-0" />
                Cancel Test
              </button>
            ) : (
              <button
                onClick={runTest}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-primary/20 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors w-full justify-center"
              >
                <Play size={11} className="shrink-0" />
                Run {TEST_MODES[testMode].label} Test
              </button>
            )}
          </div>

          {/* Result card — shown during all active phases and when done/error */}
          {(isBusy || result) && (
            <ResultCard result={result} phase={phase} />
          )}
        </div>

      </div>
    </Panel>
  );
}
