import { useState, useEffect } from 'react';
import { getCurrentUser, isAuthenticated, logout, verifySession } from '../auth/authService';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load from cache immediately so the UI is not blank on refresh
    const cached = getCurrentUser();
    setUser(cached);

    // Then verify against the server (updates credits, role, etc.)
    verifySession().then((serverUser) => {
      if (serverUser) {
        setUser(serverUser);
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
