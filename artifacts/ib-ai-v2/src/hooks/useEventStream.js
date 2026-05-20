/**
 * useEventStream — SSE connection to /api/admin/event-stream.
 *
 * Uses fetch + ReadableStream (not EventSource) so we can attach the
 * Authorization header. Auto-reconnects after disconnect with a 3s backoff.
 *
 * Returns:
 *   events    — array of parsed event objects, newest first, capped at 200
 *   connected — true while the SSE stream is open
 *   error     — null | 'unauthorized' | 'forbidden' | 'disconnected'
 *   paused    — whether new events are being buffered only
 *   setPaused — toggle pause
 *   clearEvents — wipe the event list
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { getAuthHeaders } from '../auth/authService';

const MAX_EVENTS = 200;

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

export function useEventStream() {
  const [events,    setEvents]    = useState([]);
  const [connected, setConnected] = useState(false);
  const [error,     setError]     = useState(null);
  const [paused,    setPaused]    = useState(false);

  // Pending buffer when paused
  const pendingRef  = useRef([]);
  const pausedRef   = useRef(false);
  const cancelRef   = useRef(false);
  const retryRef    = useRef(null);

  // Keep pausedRef in sync
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const connect = useCallback(async () => {
    if (cancelRef.current) return;

    const headers = getAuthHeaders();
    if (!headers.Authorization) { setError('unauthorized'); return; }

    try {
      const res = await fetch(`${BASE}/api/admin/event-stream`, { headers });

      if (cancelRef.current) return;

      if (res.status === 401) { setError('unauthorized');  return; }
      if (res.status === 403) { setError('forbidden');     return; }
      if (!res.ok)            { scheduleRetry();           return; }

      setConnected(true);
      setError(null);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (cancelRef.current) { reader.cancel(); break; }

        const { done, value } = await reader.read();
        if (done || cancelRef.current) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        const parsed = [];
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === ': ping') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt && evt.type) parsed.push(evt);
          } catch { /* ignore malformed */ }
        }

        if (parsed.length === 0) continue;

        if (pausedRef.current) {
          pendingRef.current = [...parsed, ...pendingRef.current].slice(0, MAX_EVENTS);
        } else {
          setEvents((prev) => [...parsed, ...prev].slice(0, MAX_EVENTS));
        }
      }
    } catch {
      if (cancelRef.current) return;
    }

    if (!cancelRef.current) {
      setConnected(false);
      scheduleRetry();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function scheduleRetry() {
    if (cancelRef.current) return;
    retryRef.current = setTimeout(connect, 3_000);
  }

  useEffect(() => {
    cancelRef.current = false;
    connect();
    return () => {
      cancelRef.current = true;
      setConnected(false);
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [connect]);

  // Flush pending buffer when unpausing
  const handleSetPaused = useCallback((val) => {
    setPaused(val);
    if (!val && pendingRef.current.length > 0) {
      setEvents((prev) => [...pendingRef.current, ...prev].slice(0, MAX_EVENTS));
      pendingRef.current = [];
    }
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
    pendingRef.current = [];
  }, []);

  return {
    events,
    connected,
    error,
    paused,
    setPaused: handleSetPaused,
    clearEvents,
  };
}
