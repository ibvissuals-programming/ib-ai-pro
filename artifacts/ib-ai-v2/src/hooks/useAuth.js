import { useState, useEffect } from 'react';
import { getCurrentUser, isAuthenticated, logout } from '../auth/authService';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { 
    setUser(getCurrentUser()); 
    setLoading(false); 
  }, []);

  const handleLogout = () => { 
    logout(); 
    setUser(null); 
  };

  return { user, loading, isAuthenticated: !!user, logout: handleLogout, setUser };
}
