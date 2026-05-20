/**
 * EventFeedPanel — real-time event feed via SSE.
 *
 * Connects to GET /api/admin/event-stream and renders live pipeline events:
 *   chat_request_started   → sky
 *   chat_request_completed → emerald
 *   memory_extracted       → violet
 *   memory_injected        → purple
 *   memory_skipped         → gray
 *   error_occurred         → red
 *
 * Controls: pause (buffers incoming), clear, connection indicator.
 * Auto-scrolls to the top (newest) when not paused.
 */
import { useRef, useEffect } from 'react';
import { Radio, Pause, Play, Trash2, AlertCircle } from 'lucide-react';
import { useEventStream } from '../hooks/useEventStream';

// ── Event type config ─────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  chat_request_started:   { label: 'chat:start',   cls: 'text-sky-400 bg-sky-400/10 border-sky-400/20' },
  chat_request_completed: { label: 'chat:done',    cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  memory_extracted:       { label: 'mem:extract',  cls: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
  memory_injected:        { label: 'mem:inject',   cls: 'text-purple-400 bg-purple-400/10 border-purple-400/20' },
  memory_skipped:         { label: 'mem:skip',     cls: 'text-muted-foreground bg-muted/20 border-border/20' },
  error_occurred:         { label: 'error',        cls: 'text-red-400 bg-red-400/10 border-red-400/20' },
};

function typeConfig(type) {
  return TYPE_CONFIG[type] ?? { label: type, cls: 'text-muted-foreground bg-muted/20 border-border/20' };
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ── Single event row ──────────────────────────────────────────────────────────

function EventRow({ event }) {
  const cfg = typeConfig(event.type);
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 border-b border-border/10 last:border-0 hover:bg-white/[0.02] font-mono text-xs">
      {/* Type badge */}
      <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-medium ${cfg.cls}`}>
        {cfg.label}
      </span>

      {/* Core info */}
      <div className="flex-1 min-w-0 space-y-0.5">
        {event.userId && (
          <span className="text-muted-foreground/70 truncate block text-[10px]">
            uid:{event.userId.slice(0, 8)}
          </span>
        )}
        {event.latencyMs != null && (
          <span className="text-muted-foreground/60 text-[10px]">
            {event.latencyMs}ms
          </span>
        )}
        {event.meta && Object.keys(event.meta).length > 0 && (
          <span className="text-muted-foreground/40 text-[10px] truncate block">
            {Object.entries(event.meta)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k, v]) => `${k}:${v}`)
              .join(' ')}
          </span>
        )}
      </div>

      {/* Timestamp */}
      <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
        {fmtTime(event.timestamp)}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function EventFeedPanel() {
  const { events, connected, error, paused, setPaused, clearEvents } = useEventStream();
  const listRef = useRef(null);

  // Scroll to top when new events arrive (newest first) while not paused
  useEffect(() => {
    if (!paused && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [events.length, paused]);

  const connDot = connected
    ? 'bg-emerald-400 animate-pulse'
    : error === 'unauthorized' || error === 'forbidden'
      ? 'bg-red-400'
      : 'bg-amber-400 animate-pulse';

  const connLabel = connected
    ? 'live'
    : error === 'unauthorized' ? 'auth error'
    : error === 'forbidden'    ? 'access denied'
    : 'reconnecting…';

  return (
    <div className="glass-card rounded-xl flex flex-col" style={{ height: 'calc(100vh - 200px)', minHeight: '500px' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2">
          <Radio size={14} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">Live Event Feed</span>
          <div className="flex items-center gap-1.5 ml-1">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connDot}`} />
            <span className="text-[10px] text-muted-foreground/70">{connLabel}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Event count */}
          {events.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">
              {events.length} event{events.length !== 1 ? 's' : ''}
            </span>
          )}

          {/* Pause / resume */}
          <button
            onClick={() => setPaused(!paused)}
            title={paused ? 'Resume live feed' : 'Pause feed'}
            className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
              paused
                ? 'text-amber-400 bg-amber-400/10 border-amber-400/20 hover:bg-amber-400/20'
                : 'text-muted-foreground bg-muted/20 border-border/20 hover:text-foreground hover:bg-muted/40'
            }`}
          >
            {paused ? <Play size={10} /> : <Pause size={10} />}
            {paused ? 'Resume' : 'Pause'}
          </button>

          {/* Clear */}
          <button
            onClick={clearEvents}
            title="Clear event list"
            disabled={events.length === 0}
            className="p-1.5 rounded border border-border/20 text-muted-foreground hover:text-foreground hover:bg-muted/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[120px_1fr_80px] gap-2 px-4 py-2 border-b border-border/10 bg-muted/10 shrink-0">
        <span className="text-[10px] text-muted-foreground/60 font-medium uppercase tracking-wide">Type</span>
        <span className="text-[10px] text-muted-foreground/60 font-medium uppercase tracking-wide">Details</span>
        <span className="text-[10px] text-muted-foreground/60 font-medium uppercase tracking-wide text-right">Time</span>
      </div>

      {/* Auth / connection error states */}
      {(error === 'unauthorized' || error === 'forbidden') && (
        <div className="flex items-center gap-2 px-4 py-5 text-xs text-amber-400/80 border-b border-border/10">
          <AlertCircle size={13} className="shrink-0" />
          {error === 'unauthorized' ? 'Session expired — please log in again' : 'CEO access required'}
        </div>
      )}

      {/* Pause banner */}
      {paused && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-400/5 border-b border-amber-400/20 shrink-0">
          <Pause size={10} className="text-amber-400" />
          <span className="text-[11px] text-amber-400">
            Feed paused — incoming events are buffered
          </span>
        </div>
      )}

      {/* Event list */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4 py-16 gap-3">
            <Radio size={24} className="text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground/50">
              {connected ? 'Waiting for events…' : 'Connecting to event stream…'}
            </p>
            <p className="text-[10px] text-muted-foreground/30">
              Events appear here as the system processes chat requests and memory operations
            </p>
          </div>
        ) : (
          events.map((evt, i) => <EventRow key={`${evt.id ?? i}-${evt.timestamp}`} event={evt} />)
        )}
      </div>

      {/* Legend */}
      <div className="px-4 py-2.5 border-t border-border/20 shrink-0">
        <div className="flex flex-wrap gap-2">
          {Object.entries(TYPE_CONFIG).map(([, cfg]) => (
            <span key={cfg.label} className={`text-[9px] px-1.5 py-0.5 rounded border ${cfg.cls}`}>
              {cfg.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
