/**
 * AiToolHealthPanel — live AI tool health matrix from /api/ai/system-health.
 *
 * Displays per-tool: status, success rate, avg latency, circuit state, call count.
 * Shows the system stability score breakdown at the bottom.
 *
 * Props: { data, loading, error, lastOk } — standard panel contract from useAdminPolling.
 * Auto-refresh: 30 s interval handled by parent (useAdminPolling → useAiSystemHealth).
 */
import { RefreshCw, AlertCircle, Zap } from 'lucide-react';

const TOOL_LABELS = {
  groq:   'Groq LLM',
  gemini: 'Gemini',
  tts:    'TTS',
  image:  'Image',
  video:  'Video',
  prompt: 'Prompt Expand',
};

const TOOLS = ['groq', 'gemini', 'tts', 'image', 'video', 'prompt'];

function formatLastOk(ms) {
  if (!ms) return null;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 3) return 'just now';
  return `${diff}s ago`;
}

function StatusBadge({ status }) {
  const color =
    status === 'healthy'  ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' :
    status === 'degraded' ? 'text-amber-400 bg-amber-400/10 border-amber-400/20' :
    status === 'failing'  ? 'text-red-400 bg-red-400/10 border-red-400/20' :
                            'text-muted-foreground/60 bg-muted/20 border-border/20';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${color}`}>
      {status ?? 'offline'}
    </span>
  );
}

function CircuitBadge({ state }) {
  const color =
    state === 'closed'    ? 'text-emerald-400/70' :
    state === 'open'      ? 'text-red-400' :
    state === 'half-open' ? 'text-amber-400' :
                            'text-muted-foreground/40';
  return (
    <span className={`text-[10px] font-mono ${color}`}>
      {state ?? '—'}
    </span>
  );
}

function ScorePill({ label, val }) {
  const color =
    val == null  ? 'text-muted-foreground/40' :
    val >= 90    ? 'text-emerald-400' :
    val >= 70    ? 'text-amber-400' :
                   'text-red-400';
  return (
    <div className="glass-subtle rounded-lg px-2.5 py-2 text-center">
      <div className="text-[10px] text-muted-foreground/60 mb-0.5">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{val ?? '—'}</div>
    </div>
  );
}

export function AiToolHealthPanel({ data, loading, error, lastOk }) {
  const tools = data?.tools ?? {};
  const score = data?.systemScore;

  return (
    <div className="glass-card rounded-xl flex flex-col">
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">AI Tool Health</span>
          {score != null && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ml-1 ${
              score.global >= 90 ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' :
              score.global >= 70 ? 'text-amber-400 bg-amber-400/10 border-amber-400/20' :
                                   'text-red-400 bg-red-400/10 border-red-400/20'
            }`}>
              score {score.global}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw size={11} className="text-muted-foreground animate-spin" />}
          {lastOk && !loading && (
            <span className="text-[10px] text-muted-foreground/60">{formatLastOk(lastOk)}</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {error && !loading ? (
          <div className="flex items-center gap-2 px-4 py-5 text-xs text-amber-400/80">
            <AlertCircle size={13} className="shrink-0" />
            {error}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/20">
                  <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Tool</th>
                  <th className="text-left px-4 py-2.5 text-muted-foreground font-medium">Status</th>
                  <th className="text-right px-4 py-2.5 text-muted-foreground font-medium hidden sm:table-cell">Rate</th>
                  <th className="text-right px-4 py-2.5 text-muted-foreground font-medium hidden md:table-cell">Latency</th>
                  <th className="text-left px-4 py-2.5 text-muted-foreground font-medium hidden lg:table-cell">Circuit</th>
                  <th className="text-right px-4 py-2.5 text-muted-foreground font-medium">Calls</th>
                </tr>
              </thead>
              <tbody>
                {TOOLS.map((tool) => {
                  const t = tools[tool] ?? {};
                  return (
                    <tr key={tool} className="border-b border-border/10 last:border-0 hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-2.5 font-medium text-foreground/90">{TOOL_LABELS[tool]}</td>
                      <td className="px-4 py-2.5"><StatusBadge status={t.status} /></td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground hidden sm:table-cell tabular-nums">
                        {t.successRate != null ? `${t.successRate}%` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground hidden md:table-cell tabular-nums">
                        {t.latency != null ? `${t.latency}ms` : '—'}
                      </td>
                      <td className="px-4 py-2.5 hidden lg:table-cell">
                        <CircuitBadge state={t.circuit} />
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">
                        {t.totalCalls ?? 0}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {score && (
          <div className="px-4 py-3 border-t border-border/20">
            <div className="grid grid-cols-4 gap-2">
              <ScorePill label="Success"  val={score.breakdown?.successRate} />
              <ScorePill label="Latency"  val={score.breakdown?.latencyStability} />
              <ScorePill label="Fallback" val={score.breakdown?.fallbackRate} />
              <ScorePill label="Errors"   val={score.breakdown?.errorFrequency} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
