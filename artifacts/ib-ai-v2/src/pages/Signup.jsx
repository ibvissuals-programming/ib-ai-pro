import { useState } from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import { Cpu, AlertCircle, CheckCircle } from 'lucide-react';
import { signup, login } from '../auth/authService';
import { useAuth } from '../hooks/useAuth';

export default function Signup() {
  const [, setLocation] = useLocation();
  const { setUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!username.trim() || !password.trim() || !confirmPassword.trim()) {
      setError('Please fill in all fields');
      return;
    }
    if (username.trim().length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    await new Promise(r => setTimeout(r, 400));
    const result = signup(username.trim(), password);
    setLoading(false);

    if (result.success) {
      setSuccess(true);
      await new Promise(r => setTimeout(r, 800));
      login(username.trim(), password);
      setUser({ username: username.trim() });
      setLocation('/chat');
    } else {
      setError(result.error || 'Signup failed');
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="w-full max-w-sm"
      >
        <div className="flex flex-col items-center mb-8">
          <div className="w-11 h-11 rounded-2xl bg-primary flex items-center justify-center mb-4 shadow-lg shadow-primary/20">
            <Cpu size={19} className="text-primary-foreground" />
          </div>
          <h1 className="text-xl font-semibold text-foreground tracking-tight font-heading">
            IB AI <span className="text-primary">Pro</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1 font-light">Create your account</p>
        </div>

        <div className="glass-card p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                data-testid="input-username"
                autoFocus
                className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all"
                placeholder="Choose a username (min 3 chars)"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                data-testid="input-password"
                className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all"
                placeholder="Min 6 characters"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                data-testid="input-confirm-password"
                className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all"
                placeholder="Repeat your password"
              />
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="flex items-center gap-2 text-destructive text-xs bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
              >
                <AlertCircle size={12} className="shrink-0" />
                {error}
              </motion.div>
            )}

            {success && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-2 text-green-400 text-xs bg-green-500/10 border border-green-500/20 rounded-xl px-3 py-2.5"
              >
                <CheckCircle size={12} className="shrink-0" />
                Account created. Redirecting...
              </motion.div>
            )}

            <button
              type="submit"
              disabled={loading || success}
              data-testid="button-signup"
              className="w-full bg-primary text-primary-foreground rounded-xl py-2.5 text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed mt-2 shadow-lg shadow-primary/20"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                    className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full"
                  />
                  Creating account...
                </span>
              ) : 'Create account'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-muted-foreground mt-4">
          Already have an account?{' '}
          <button
            onClick={() => setLocation('/login')}
            data-testid="link-login"
            className="text-primary hover:underline font-medium transition-colors"
          >
            Sign in
          </button>
        </p>

        <p className="text-center text-xs text-muted-foreground/40 mt-5 leading-relaxed max-w-xs mx-auto">
          Accounts are stored locally in this browser. Clearing browser data will remove your account.
        </p>
      </motion.div>
    </div>
  );
}
