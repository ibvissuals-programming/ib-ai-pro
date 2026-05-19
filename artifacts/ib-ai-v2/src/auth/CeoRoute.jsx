import { useLocation, Redirect } from 'wouter';
import { isAuthenticated, getCurrentUser } from './authService';

/**
 * CeoRoute — wraps a page so only role === "ceo" users can reach it.
 *
 * Not authenticated  → /login?next=...
 * Authenticated, not ceo → /chat  (silently redirect, no error flash)
 * CEO → render children
 */
export function CeoRoute({ children }) {
  const [location] = useLocation();

  if (!isAuthenticated()) {
    return <Redirect to={`/login?next=${encodeURIComponent(location)}`} />;
  }

  const user = getCurrentUser();
  if (!user || user.role !== 'ceo') {
    return <Redirect to="/chat" />;
  }

  return children;
}
