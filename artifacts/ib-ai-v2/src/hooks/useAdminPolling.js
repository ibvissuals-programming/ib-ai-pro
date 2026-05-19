/**
 * useAdminPolling — CEO dashboard data fetcher.
 *
 * Polls all 4 admin endpoints on independent intervals.
 * Each poll cancels the previous in-flight request via AbortController
 * so overlapping requests are impossible.
 *
 * Intervals:
 *   health       — 8 s
 *   stats        — 10 s
 *   activeUsers  — 12 s
 *   logs         — 15 s
 *
 * Error codes surfaced per endpoint:
 *   'unauthorized' — 401 → caller should redirect to /login
 *   'forbidden'    — 403 → caller should show CEO-only message
 *   'unreachable'  — network / fetch failure
 *   'empty'        — 200 but no payload
 *   'server'       — 4xx/5xx other than 401/403
 */
import { useState, useEffect, useRef } from 'react';
import { getAuthHeaders } from '../auth/authService';
import { safeJson } from '../utils/apiClient';

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

function useEndpointPoll(path, intervalMs) {
  const [data, setData]         = useState(null);
  const [error, setError]       = useState(null);
  const [errorCode, setErrCode] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [lastOk, setLastOk]     = useState(null); // Unix ms of last successful fetch

  const abortRef   = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const doFetch = async () => {
      // Cancel any previous in-flight request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`${BASE}/api${path}`, {
          headers: { ...getAuthHeaders() },
          signal: controller.signal,
        });

        if (!mountedRef.current || controller.signal.aborted) return;

        if (res.status === 401) { setErrCode('unauthorized'); setLoading(false); return; }
        if (res.status === 403) { setErrCode('forbidden');    setLoading(false); return; }

        const json = await safeJson(res);
        if (!mountedRef.current) return;

        if (!res.ok) {
          setError((json && json.error) ? json.error : `Server error (${res.status})`);
          setErrCode('server');
          setLoading(false);
          return;
        }

        if (!json || Object.keys(json).length === 0) {
          setError('No data received');
          setErrCode('empty');
          setLoading(false);
          return;
        }

        setData(json);
        setError(null);
        setErrCode(null);
        setLastOk(Date.now());
        setLoading(false);

      } catch (err) {
        if (!mountedRef.current || err.name === 'AbortError') return;
        setError('Server unreachable');
        setErrCode('unreachable');
        setLoading(false);
      }
    };

    doFetch();
    const timer = setInterval(doFetch, intervalMs);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [path, intervalMs]);

  return { data, error, errorCode, loading, lastOk };
}

/** Poll the user directory — 30 s interval (list changes rarely). */
export function useUserDirectory() {
  return useEndpointPoll('/admin/users', 30_000);
}

export function useAdminPolling() {
  const health             = useEndpointPoll('/admin/health',               8_000);
  const stats              = useEndpointPoll('/admin/stats',               10_000);
  const activeUsers        = useEndpointPoll('/admin/active-users',        12_000);
  const logs               = useEndpointPoll('/admin/logs?limit=50',       15_000);
  const renderAnalytics    = useEndpointPoll('/admin/render-analytics',    20_000);
  const cinematicInsights  = useEndpointPoll('/admin/cinematic-insights',  25_000);

  // Bubble up the most critical auth error code
  const allEndpoints = [health, stats, activeUsers, logs, renderAnalytics, cinematicInsights];
  const globalErrorCode =
    allEndpoints.some((e) => e.errorCode === 'unauthorized')
      ? 'unauthorized'
      : allEndpoints.some((e) => e.errorCode === 'forbidden')
        ? 'forbidden'
        : null;

  return { health, stats, activeUsers, logs, renderAnalytics, cinematicInsights, globalErrorCode };
}
