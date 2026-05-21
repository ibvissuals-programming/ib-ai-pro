/**
 * ProviderStabilityPanel — CEO Dashboard
 *
 * Displays AI provider readiness from /api/ai/system-health.
 * Reuses the existing aiToolHealth poll data passed as props.
 *
 * Props: { data, loading, error, lastOk }  — standard panel contract
 *
 * Shows: provider name, feature enabled, model, circuit state,
 * readiness badge, and fallback activity per tool.
 */
import { motion } from 'framer-motion';
import { Shield, RefreshCw, AlertCircle, CheckCircle, XCircle, Clock } from 'lucide-react';

const PROVIDER_META = [
  { key: 'gemini', label: 'Gemini AI',    description: 'Chat + Prompt Expansion',  color: 'text-blue-400',   dot: 'bg-blue-400'   },
  { key: 'tts',    label: 'Gemini TTS',   description: 'Text-to-Speech (WAV)',      color: 'text-rose-400',   dot: 'bg-rose-400'   },
  { key: 'video',  label: 'Gemini Veo 2', description: 'Image-to-Video Generation', color: 'text-violet-400', dot: 'bg-violet-400' },
  { key: 'image',  label: 'Image Stack',  description: 'Gen (Flux) + Edit (Gemini)',color: 'text-emerald-400',dot: 'bg-emerald-400'},
];

function ReadyBadge({ ready }) {
  if (ready) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-1.5 py-0.5 rounded">
        <CheckCircle size={9} /> Ready
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] font-medium text-red-400 bg-red-400/10 border border-red-400/20 px-1.5 py-0.5 rounded">
      <XCircle size={9} /> Not Ready
    </span>
  );
}

function CircuitBadge({ state }) {
  const color =
    state === 'closed'    ? 'text-emerald-400/80' :
    state === 'open'      ? 'text-red-400'         :
    state === 'half-open' ? 'text-amber-400'        :
                            'text-muted-foreground/40';
  return (
    <span className={`text-[9px] font-mono ${color}`}>
      cb:{state ?? 'closed'}
    </span>
  );
}

function formatLastOk(ms) {
  if (!ms) return null;
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 3)  return 'just now';
  return `${diff}s ago`;
}

export function ProviderStabilityPanel({ data, loading, error, lastOk }) {
  // data comes from /api/ai/system-health which has { tools, capabilities, systemScore, ... }
  // or from /api/admin/multimodal-stats which has { tools: { image, tts, video, prompt } }
  // We read from whichever is available.
  const tools       = data?.tools       ?? {};
  const capabilities = data?.capabilities ?? {};

  const getReady = (key) => {
    // Try capability first (from system-health), fall back to tool.ready
    const cap = capabilities[key];
    if (cap) return cap.featureEnabled && cap.providerReady;
    return tools[key]?.ready ?? null;
  };

  const getModel = (key) => {
    return capabilities[key]?.model ?? tools[key]?.provider ?? null;
  };

  const getCircuit = (key) => {
    return tools[key]?.circuit ?? null;
  };

  const getStatus = (key) => {
    return tools[key]?.status ?? null;
  };

  const getNote = (key) => {
    if (key === 'video') return capabilities?.video?.veoAccessNote ?? null;
    return null;
  };

  return (
    <div className="glass-card rounded-xl flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">Provider Stability</span>
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

      <div className="flex-1 px-4 py-4">
        {error && !loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-amber-400/80">
            <AlertCircle size={13} className="shrink-0" />
            {error}
          </div>
        ) : (
          <div className="space-y-2">
            {PROVIDER_META.map(({ key, label, description, color, dot }) => {
              const ready   = getReady(key);
              const model   = getModel(key);
              const circuit = getCircuit(key);
              const status  = getStatus(key);
              const note    = getNote(key);

              if (loading && ready == null) {
                return <div key={key} className="h-16 rounded-xl bg-secondary/20 animate-pulse" />;
              }

              return (
                <motion.div
                  key={key}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-start gap-3 px-3 py-3 rounded-xl border border-border/25 bg-secondary/20"
                >
                  {/* Status dot */}
                  <div className="mt-0.5 shrink-0">
                    <span className={`inline-block w-2 h-2 rounded-full ${
                      ready === true  ? dot :
                      ready === false ? 'bg-red-400' :
                                        'bg-muted-foreground/30'
                    }`} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`text-xs font-semibold ${color}`}>{label}</p>
                      <ReadyBadge ready={ready === true} />
                      {circuit && <CircuitBadge state={circuit} />}
                      {status && status !== 'healthy' && (
                        <span className="text-[9px] text-amber-400 font-medium">{status}</span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
                    {model && (
                      <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5 truncate">{model}</p>
                    )}
                    {note && (
                      <div className="flex items-start gap-1 mt-1.5">
                        <Clock size={9} className="text-amber-400 shrink-0 mt-0.5" />
                        <p className="text-[10px] text-amber-400/80 leading-relaxed">{note}</p>
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
