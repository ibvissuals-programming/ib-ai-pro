import { useLocation, Redirect } from 'wouter';
import { isAuthenticated } from './authService';

export function ProtectedRoute({ children }) {
  const [location] = useLocation();

  if (!isAuthenticated()) {
    return <Redirect to={`/login?next=${encodeURIComponent(location)}`} />;
  }

  return children;
}
