import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, KeyRound, Lock, CheckCircle, RefreshCw, WifiOff } from 'lucide-react';
import { IbLogo } from '../components/IbLogo';
import { login, recoveryLogin, recoveryResetPassword, changePassword, clearToken } from '../auth/authService';
import { checkServerHealth } from '../utils/serverReadiness';
import { useAuth } from '../hooks/useAuth';

// Retry loop constants — visible UX handled in Login.jsx, not silently in authService.
const RECONNECT_MAX_ATTEMPTS = 7;  // 7 × 1.5s ≈ 10.5s total window
const RECONNECT_DELAY_MS     = 1_500;

export default function Login() {
  const [, setLocation] = useLocation();
  const { setUser } = useAuth();

  const [mode, setMode] = useState('login'); // 'login' | 'recovery' | 'set-password'

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Tracks whether the set-password step was reached via recovery key (not login)
  const [isRecoveryMode, setIsRecoveryMode] = useState(false);

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // Reconnect UX state — active while a connection-error retry loop is running
  const [reconnecting, setReconnecting]         = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectFailed, setReconnectFailed]   = useState(false);

  // null = unknown, true = ready, false = starting up (only shown after debounce)
  const [serverReady, setServerReady] = useState(null);
  // showNotReadyBanner is only set true after 1500ms of the probe returning false.
  // This prevents a flash of the amber banner on healthy servers where the first
  // probe response arrives quickly.
  const [showNotReadyBanner, setShowNotReadyBanner] = useState(false);

  // Refs — survive re-renders without causing them
  // loginCancelledRef: set true on unmount so in-flight retry loops bail out cleanly
  const loginCancelledRef    = useRef(false);
  // lastCredentialsRef: stored so the manual Retry button can re-attempt with same creds
  const lastCredentialsRef   = useRef({ user: '', pass: '' });
  // reconnectTimerRef: tracks the pending setTimeout so it can be cancelled on unmount
  const reconnectTimerRef    = useRef(null);

  // Clear any stale token/cache whenever the login page mounts.
  // Prevents redirect loops from tokens that became invalid while the tab was closed.
  useEffect(() => { clearToken(); }, []);

  // Cancel any running retry loop on unmount
  useEffect(() => {
    loginCancelledRef.current = false;
    return () => {
      loginCancelledRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, []);

  // ── Server readiness probe ─────────────────────────────────────────────────
  // Polls /api/system/ready on mount. Shows an advisory "Server is starting…"
  // banner while the backend is booting.
  //
  // /api/system/ready is accurate: ready===true only when phase===COMPLETE and
  // all core services are up. Unlike /api/auth/health which always returns true.
  //
  // This banner is PURELY informational — the login button is always enabled.
  //
  // Absolute timeout (6s): if the backend doesn't confirm ready within 6s,
  // the banner is dismissed and the UI proceeds in limited mode. This prevents
  // any "frozen starting up" state after an import or cold start.

  useEffect(() => {
    let cancelled = false;
    let resolved = false;
    let retryTimer = null;
    let bannerTimer = null;

    // ── 6-second absolute cutoff ──────────────────────────────────────────────
    const cutoffTimer = setTimeout(() => {
      if (!cancelled) {
        resolved = true;
        clearTimeout(bannerTimer);
        setServerReady(true);
        setShowNotReadyBanner(false);
        setError(prev => {
          const lower = prev.toLowerCase();
          const isTransientError =
            lower.includes('starting up') ||
            lower.includes('temporarily unavailable') ||
            lower.includes('service unavailable') ||
            lower.includes('please try again in a moment');
          return isTransientError ? '' : prev;
        });
      }
    }, 6_000);

    async function probe() {
      if (resolved || cancelled) return;

      const result = await checkServerHealth();

      if (result.ready) {
        resolved = true;
        clearTimeout(cutoffTimer);
        clearTimeout(bannerTimer);
        setServerReady(true);
        setShowNotReadyBanner(false);
        setError(prev => {
          const lower = prev.toLowerCase();
          const isTransientError =
            lower.includes('starting up') ||
            lower.includes('temporarily unavailable') ||
            lower.includes('service unavailable') ||
            lower.includes('please try again in a moment');
          return isTransientError ? '' : prev;
        });
        return;
      }

      if (resolved || cancelled) return;
      setServerReady(false);
      // Only show the banner after 1500ms of the probe returning not-ready.
      // This prevents a one-frame flash of the banner on healthy servers where
      // the probe fires before the first response arrives.
      if (!bannerTimer) {
        bannerTimer = setTimeout(() => {
          if (!resolved && !cancelled) setShowNotReadyBanner(true);
        }, 1_500);
      }
      retryTimer = setTimeout(probe, 2_000);
    }

    probe();
    return () => {
      cancelled = true;
      resolved = true;
      clearTimeout(cutoffTimer);
      clearTimeout(bannerTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  // ── Login attempt with connection-error retry loop ─────────────────────────
  //
  // Three outcome paths from authService.login():
  //
  //   success: true          → navigate to /chat (or set-password on first-login)
  //   connectionError: true  → backend unreachable / still building → retry loop
  //   authError: true        → wrong credentials → show error, never retry
  //   (other)                → unexpected server error → show error, never retry
  //
  // The retry loop runs up to RECONNECT_MAX_ATTEMPTS times at RECONNECT_DELAY_MS
  // intervals, showing "Reconnecting…" with an attempt counter. After exhaustion,
  // it shows a permanent "Could not connect" message and a manual Retry button.

  const doLogin = async (user, pass, reconnectCount = 0) => {
    if (loginCancelledRef.current) return;

    if (reconnectCount === 0) {
      // Fresh attempt — reset all state
      lastCredentialsRef.current = { user, pass };
      setLoading(true);
      setError('');
      setReconnecting(false);
      setReconnectFailed(false);
      setReconnectAttempt(0);
    }

    const result = await login(user, pass);

    if (loginCancelledRef.current) return;

    if (result.success) {
      setLoading(false);
      setReconnecting(false);
      setUser(result.user);
      if (result.recoveryLogin) {
        setMode('set-password');
        setError('');
      } else {
        setLocation('/chat');
      }
      return;
    }

    if (result.connectionError) {
      const nextCount = reconnectCount + 1;
      if (nextCount <= RECONNECT_MAX_ATTEMPTS) {
        // Enter / continue "Reconnecting…" state
        setLoading(false);
        setReconnecting(true);
        setReconnectAttempt(nextCount);
        // Schedule next attempt after delay
        await new Promise(resolve => {
          reconnectTimerRef.current = setTimeout(resolve, RECONNECT_DELAY_MS);
        });
        reconnectTimerRef.current = null;
        if (!loginCancelledRef.current) {
          return doLogin(user, pass, nextCount);
        }
        return;
      }

      // All retries exhausted — surface permanent failure with Retry button
      setReconnecting(false);
      setLoading(false);
      setReconnectFailed(true);
      return;
    }

    // Auth or unexpected error — show message immediately, never retry
    setLoading(false);
    setReconnecting(false);
    setError(result.error || 'Login failed');
  };

  // ── Manual retry (Retry button after exhaustion) ───────────────────────────

  const handleRetry = () => {
    setReconnectFailed(false);
    const { user, pass } = lastCredentialsRef.current;
    doLogin(user, pass, 0);
  };

  // ── Recovery attempt ───────────────────────────────────────────────────────
  // recoveryLogin() only validates that inputs are non-empty — no network call.
  // The recovery key is forwarded to the server only in handleSetPassword().

  const doRecovery = async (user, key) => {
    setLoading(true);
    setError('');
    const result = await recoveryLogin(user, key);
    setLoading(false);

    if (result.success) {
      setIsRecoveryMode(true);
      setMode('set-password');
    } else {
      setError(result.error || 'Recovery failed');
    }
  };

  // ── Form submit handlers ───────────────────────────────────────────────────

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password.trim()) {
      setError('Please fill in all fields');
      return;
    }
    doLogin(username.trim(), password);
  };

  const handleRecovery = (e) => {
    e.preventDefault();
    setError('');
    if (!username.trim() || !recoveryKey.trim()) {
      setError('Please fill in username and recovery key');
      return;
    }
    doRecovery(username.trim(), recoveryKey.trim());
  };

  const handleSetPassword = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);

    let result;
    if (isRecoveryMode) {
      // Recovery path: submit key + new password directly to reset-password.
      // No token is issued — user must log in normally after this step.
      result = await recoveryResetPassword(username.trim(), recoveryKey.trim(), newPassword);
    } else {
      result = await changePassword(newPassword);
    }

    setLoading(false);
    if (result.success) {
      if (isRecoveryMode) {
        setSuccess('Password updated! Please sign in with your new password.');
        setTimeout(() => {
          setIsRecoveryMode(false);
          setMode('login');
          setNewPassword('');
          setConfirmPassword('');
          setRecoveryKey('');
          setSuccess('');
        }, 1800);
      } else {
        setSuccess('Password updated! Redirecting to chat…');
        setTimeout(() => setLocation('/chat'), 1500);
      }
    } else {
      setError(result.error || 'Password update failed');
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

        {/* Server-starting banner — shown only after 1500ms of failed probes */}
        <AnimatePresence>
          {showNotReadyBanner && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden mb-4"
            >
              <div className="flex items-center gap-2 text-amber-400 text-xs bg-amber-400/10 border border-amber-400/20 rounded-xl px-3 py-2.5">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                  className="w-3 h-3 border-2 border-amber-400/30 border-t-amber-400 rounded-full shrink-0"
                />
                Server is starting up — login will be available in a moment…
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex flex-col items-center mb-8">
          <motion.div
            initial={{ opacity: 0, scale: 0.88 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.38, ease: 'easeOut' }}
            className="mb-5"
          >
            <IbLogo variant="mark" size={64} />
          </motion.div>
          <h1 className="text-xl font-bold text-foreground tracking-tight font-heading" style={{ letterSpacing: '-0.03em' }}>
            IB <span className="text-primary">AI</span> Studio Lab
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            {mode === 'login' && 'Sign in to your account'}
            {mode === 'recovery' && 'CEO recovery access'}
            {mode === 'set-password' && 'Set a new password'}
          </p>
        </div>

        <div className="glass-card-premium p-6">
          <AnimatePresence mode="wait">

            {/* ── Normal login ── */}
            {mode === 'login' && (
              <motion.form
                key="login"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onSubmit={handleSubmit}
                className="space-y-4"
              >
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                    Username
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    data-testid="input-username"
                    autoComplete="username"
                    autoFocus
                    disabled={reconnecting}
                    className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all disabled:opacity-50"
                    placeholder="Your username"
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
                    autoComplete="current-password"
                    disabled={reconnecting}
                    className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all disabled:opacity-50"
                    placeholder="Your password"
                  />
                </div>

                {/* Auth errors — wrong password, validation, unexpected */}
                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="flex items-center gap-2 text-destructive text-xs bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5">
                        <AlertCircle size={12} className="shrink-0" />
                        {error}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Reconnecting banner — shown during connection-error retry loop */}
                <AnimatePresence>
                  {reconnecting && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="flex items-center gap-2 text-amber-400 text-xs bg-amber-400/10 border border-amber-400/20 rounded-xl px-3 py-2.5">
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                          className="w-3 h-3 border-2 border-amber-400/30 border-t-amber-400 rounded-full shrink-0"
                        />
                        Reconnecting… (attempt {reconnectAttempt} of {RECONNECT_MAX_ATTEMPTS})
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Permanent failure banner — shown after retry loop exhausts */}
                <AnimatePresence>
                  {reconnectFailed && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="flex flex-col gap-2.5 text-xs bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5">
                        <div className="flex items-center gap-2 text-destructive">
                          <WifiOff size={12} className="shrink-0" />
                          Could not reach the server. It may be restarting — please wait a moment and try again.
                        </div>
                        <button
                          type="button"
                          onClick={handleRetry}
                          className="flex items-center justify-center gap-1.5 w-full bg-destructive/20 hover:bg-destructive/30 text-destructive rounded-lg py-1.5 text-xs font-medium transition-colors"
                        >
                          <RefreshCw size={11} />
                          Retry
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button
                  type="submit"
                  disabled={loading || reconnecting}
                  data-testid="button-login"
                  className="w-full bg-primary text-primary-foreground rounded-xl py-2.5 text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed mt-2 shadow-lg shadow-primary/20"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                        className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full"
                      />
                      Signing in...
                    </span>
                  ) : reconnecting ? (
                    <span className="flex items-center justify-center gap-2">
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                        className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full"
                      />
                      Reconnecting...
                    </span>
                  ) : 'Sign In'}
                </button>

                <button
                  type="button"
                  onClick={() => { setMode('recovery'); setError(''); }}
                  disabled={reconnecting}
                  className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <KeyRound size={11} />
                  CEO recovery access
                </button>
              </motion.form>
            )}

            {/* ── CEO Recovery ── */}
            {mode === 'recovery' && (
              <motion.form
                key="recovery"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onSubmit={handleRecovery}
                className="space-y-4"
              >
                <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-xl px-3 py-2.5">
                  <KeyRound size={12} className="shrink-0" />
                  Recovery key required. Normal password is bypassed.
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                    CEO Username
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    autoFocus
                    className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all"
                    placeholder="CEO username"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                    Recovery Key
                  </label>
                  <input
                    type="password"
                    value={recoveryKey}
                    onChange={e => setRecoveryKey(e.target.value)}
                    autoComplete="off"
                    className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all"
                    placeholder="Server recovery key"
                  />
                </div>

                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="flex items-center gap-2 text-destructive text-xs bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5">
                        <AlertCircle size={12} className="shrink-0" />
                        {error}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-amber-500 text-white rounded-xl py-2.5 text-sm font-medium hover:opacity-90 transition-all disabled:opacity-60 disabled:cursor-not-allowed shadow-lg"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                        className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full"
                      />
                      Verifying…
                    </span>
                  ) : 'Access with recovery key'}
                </button>

                <button
                  type="button"
                  onClick={() => { setMode('login'); setError(''); }}
                  className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1.5"
                >
                  Back to normal login
                </button>
              </motion.form>
            )}

            {/* ── Set new password (post-recovery or first-login) ── */}
            {mode === 'set-password' && (
              <motion.form
                key="set-password"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onSubmit={handleSetPassword}
                className="space-y-4"
              >
                <div className="flex items-center gap-2 text-xs text-primary/80 bg-primary/10 border border-primary/20 rounded-xl px-3 py-2.5">
                  <Lock size={12} className="shrink-0" />
                  Recovery login successful. Set a permanent password to continue.
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                    New Password
                  </label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    autoFocus
                    autoComplete="new-password"
                    className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all"
                    placeholder="At least 8 characters"
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
                    autoComplete="new-password"
                    className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all"
                    placeholder="Repeat password"
                  />
                </div>

                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="flex items-center gap-2 text-destructive text-xs bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5">
                        <AlertCircle size={12} className="shrink-0" />
                        {error}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence>
                  {success && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="flex items-center gap-2 text-emerald-400 text-xs bg-emerald-400/10 border border-emerald-400/20 rounded-xl px-3 py-2.5">
                        <CheckCircle size={12} className="shrink-0" />
                        {success}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-primary text-primary-foreground rounded-xl py-2.5 text-sm font-medium hover:opacity-90 transition-all disabled:opacity-60 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                        className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full"
                      />
                      Saving…
                    </span>
                  ) : 'Set password & continue'}
                </button>

                <button
                  type="button"
                  onClick={() => setLocation('/chat')}
                  className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1.5"
                >
                  Skip for now
                </button>
              </motion.form>
            )}

          </AnimatePresence>
        </div>

      </motion.div>
    </div>
  );
}
