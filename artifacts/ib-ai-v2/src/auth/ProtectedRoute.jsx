import { useState, useEffect } from 'react';
import { Redirect, useLocation } from 'wouter';
import { isAuthenticated, verifySession } from './authService';

/**
 * ProtectedRoute — guards any route behind a valid server session.
 *
 * Two-phase check:
 *   1. Immediate: if no token/cached-user in localStorage → redirect to /login now.
 *      This avoids a blank render when the user is definitely unauthenticated.
 *   2. Async: verifySession() confirms the token is still valid against the server.
 *      If the server returns 401 (expired/revoked), redirect to /login.
 *      Transient server errors (5xx) do NOT log the user out.
 *
 * The component renders children during the async check so there is no flash.
 * If verifySession() invalidates the session, a Redirect replaces the render.
 *
 * Note: useEffect deps are [] (not [location]) — wouter mounts a fresh
 * ProtectedRoute instance per-route, so each route gets its own verification
 * on mount. Re-running verifySession() on every in-page location event was
 * causing a re-render cascade through ChatApp during the onboarding animations.
 */
export function ProtectedRoute({ children }) {
  const [location] = useLocation();
  const [verified, setVerified] = useState(null); // null=pending, true=ok, false=invalid

  useEffect(() => {
    if (!isAuthenticated()) {
      setVerified(false);
      return;
    }
    verifySession().then((user) => {
      setVerified(!!user);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Phase 1: definitely not authenticated (no token) → redirect immediately
  if (!isAuthenticated()) {
    return <Redirect to={`/login?next=${encodeURIComponent(location)}`} />;
  }

  // Phase 2: server confirmed session is invalid → redirect
  if (verified === false) {
    return <Redirect to={`/login?next=${encodeURIComponent(location)}`} />;
  }

  // Render children while verification is pending (verified === null) or confirmed (true)
  return children;
}
