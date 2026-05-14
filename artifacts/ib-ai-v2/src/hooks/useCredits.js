import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchCredits } from '../services/creditsApi';

const POLL_INTERVAL_MS = 60_000; // 60 s

/**
 * Hook that manages credit state for a user.
 *
 * - Fetches credit status on mount and every 60 s.
 * - Exposes refresh() for manual refresh (call after a successful image analysis).
 * - Credit display is non-critical: failures are silently absorbed.
 *
 * @param {string|null} username
 */
export function useCredits(username) {
  const [credits, setCredits] = useState(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!username) return;
    setLoading(true);
    try {
      const data = await fetchCredits(username);
      if (mountedRef.current) {
        setCredits(data);
      }
    } catch {
      // Non-critical — credit display is decorative. Do not propagate.
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [username]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();

    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  return { credits, loading, refresh };
}
