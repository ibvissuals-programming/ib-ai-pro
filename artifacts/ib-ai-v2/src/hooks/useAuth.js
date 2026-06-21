import { useState, useEffect } from 'react';
import { getCurrentUser, isAuthenticated, logout, verifySession } from '../auth/authService';

export function useAuth() {
  // Lazy initializer: read localStorage synchronously so the very first render
  // already has the correct user. Without this, every component that calls
  // useAuth() starts with user=null, causing a one-frame flash of empty/null
  // state in the sidebar, header, and chat list immediately after login.
  const [user, setUser] = useState(() => getCurrentUser());
  // Start as false when a user is already cached — no need to block on loading state.
  // Start as true only when we have a token but no cached user yet (rare edge case).
  const [loading, setLoading] = useState(() => !getCurrentUser());

  useEffect(() => {
    // Verify the cached token against the server (refreshes credits, role, etc.)
    // The cached user is already populated from the lazy useState initializer above,
    // so we skip the redundant setUser(cached) call here.
    verifySession().then((serverUser) => {
      if (serverUser) {
        // Use a functional update so React can bail out (no re-render) when the
        // meaningful fields haven't changed. This prevents a cascading re-render
        // through ChatApp → ChatWindow → OnboardingPanel while the welcome
        // animations are still playing (first ~500 ms after login).
        setUser((prev) => {
          if (
            prev &&
            prev.username === serverUser.username &&
            prev.role    === serverUser.role
          ) {
            return prev; // same reference → React skips re-render
          }
          return serverUser;
        });
      } else {
        // Token invalid or expired — clear local state
        setUser(null);
      }
      setLoading(false);
    });
  }, []);

  const handleLogout = () => {
    logout();
    setUser(null);
  };

  return { user, loading, isAuthenticated: !!user, logout: handleLogout, setUser };
}
