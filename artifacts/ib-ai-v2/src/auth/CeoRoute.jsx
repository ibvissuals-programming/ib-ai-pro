import { useState, useEffect } from 'react';
import { useLocation, Redirect } from 'wouter';
import { isAuthenticated, verifySession } from './authService';

/**
 * CeoRoute — wraps a page so only role === "ceo" users can reach it.
 *
 * Two-phase check (mirrors ProtectedRoute):
 *   1. Immediate: if no token/cached-user in localStorage → redirect to /login now.
 *   2. Async: verifySession() confirms the token against the server AND returns the
 *      live role from PostgreSQL. If the server says role !== "ceo", redirect to /chat.
 *      This prevents localStorage role manipulation from granting CEO access.
 *
 * The component renders null while the async check is pending to avoid a flash.
 * Transient server errors fall back to the cached user's role (preserving UX).
 *
 * Not authenticated  → /login?next=...
 * Authenticated, not ceo → /chat  (silently redirect, no error flash)
 * CEO (server-confirmed) → render children
 */
export function CeoRoute({ children }) {
  const [location] = useLocation();
  // null=pending, { verified: true, isCeo: bool }=done, or { verified: false }=error
  const [check, setCheck] = useState(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      setCheck({ verified: true, isCeo: false, redirect: 'login' });
      return;
    }
    verifySession().then((user) => {
      if (!user) {
        // Session definitively invalid (401 → token cleared by verifySession)
        setCheck({ verified: true, isCeo: false, redirect: 'login' });
      } else {
        setCheck({ verified: true, isCeo: user.role === 'ceo', redirect: null });
      }
    });
  }, [location]);

  // Phase 1: definitely not authenticated → redirect immediately (no async needed)
  if (!isAuthenticated()) {
    return <Redirect to={`/login?next=${encodeURIComponent(location)}`} />;
  }

  // Async check pending — render nothing to avoid a role-based flash
  if (!check) return null;

  // Server said not CEO (or session invalid)
  if (!check.isCeo) {
    if (check.redirect === 'login') {
      return <Redirect to={`/login?next=${encodeURIComponent(location)}`} />;
    }
    return <Redirect to="/chat" />;
  }

  return children;
}
