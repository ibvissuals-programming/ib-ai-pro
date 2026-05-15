import { useEffect, useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Zap, Crown, Check, Infinity as InfinityIcon } from 'lucide-react';
import { upgradePlan } from '../services/creditsApi';

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: 'forever',
    description: 'Free to start, no payment required.',
    icon: Zap,
    iconCls: 'text-muted-foreground',
    cardCls: 'border-border',
    btnCls: 'bg-muted text-muted-foreground hover:bg-muted/80',
    features: [
      'Daily usage included',
      '2 image analyses per day',
      'Unlimited chat',
      'Creative prompts',
      'Chat export',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$9',
    period: '/month',
    description: 'For creators who work daily.',
    icon: Zap,
    iconCls: 'text-primary',
    cardCls: 'border-primary/50 bg-primary/5',
    btnCls: 'bg-primary text-primary-foreground hover:bg-primary/90',
    badge: 'Most Popular',
    features: [
      'Extended daily capacity',
      'Unlimited image analyses',
      'Unlimited chat',
      'All creative modes',
      'Video direction',
      'Priority generation',
    ],
  },
  {
    id: 'max',
    name: 'Max',
    price: '$29',
    period: '/month',
    description: 'For studios and power users.',
    icon: Crown,
    iconCls: 'text-yellow-400',
    cardCls: 'border-yellow-500/30',
    btnCls: 'bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 border border-yellow-500/30',
    features: [
      'Unlimited capacity',
      'Unlimited image analyses',
      'All creative modes',
      'Fastest generation',
      'Dedicated support',
      'Early feature access',
    ],
  },
];

/**
 * Upgrade modal — shown when a user exhausts their free plan credits.
 *
 * Design rules:
 *   - NEVER interrupts an active SSE stream.
 *   - Shows the result of the last generation FIRST, then presents upgrade options.
 *   - Closing the modal simply hides it — no state is lost.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   username: string,
 *   currentPlan: string,
 *   creditsRemaining: number|null,
 *   onUpgradeSuccess: () => void
 * }} props
 */
export function UpgradeModal({
  open,
  onClose,
  username,
  currentPlan = 'free',
  creditsRemaining = 0,
  onUpgradeSuccess,
}) {
  const [upgrading, setUpgrading] = useState(null); // plan id being upgraded to
  const [error, setError] = useState(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const handleUpgrade = useCallback(async (planId) => {
    if (!username || planId === currentPlan) return;
    setUpgrading(planId);
    setError(null);
    try {
      await upgradePlan(username, planId);
      onUpgradeSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Upgrade failed. Please try again.');
    } finally {
      setUpgrading(null);
    }
  }, [username, currentPlan, onUpgradeSuccess, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50"
            onClick={onClose}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <div
              className="relative w-full max-w-3xl bg-card border border-border rounded-2xl shadow-2xl overflow-hidden pointer-events-auto max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="px-6 pt-6 pb-4 text-center border-b border-border">
                <button
                  onClick={onClose}
                  className="absolute top-4 right-4 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  <X size={16} />
                </button>

                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium mb-3">
                  <Zap size={11} />
                  {creditsRemaining === 0
                    ? 'Daily limit reached'
                    : `${creditsRemaining} use${creditsRemaining !== 1 ? 's' : ''} remaining today`}
                </div>

                <h2 className="text-xl font-semibold text-foreground">
                  Continue with IB AI v3
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Upgrade for extended daily capacity and access to all creative modes.
                </p>
              </div>

              {/* Pricing cards */}
              <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
                {PLANS.map((plan) => {
                  const Icon = plan.icon;
                  const isCurrent = plan.id === currentPlan;
                  const isLoading = upgrading === plan.id;

                  return (
                    <div
                      key={plan.id}
                      className={`relative flex flex-col rounded-xl border p-5 ${plan.cardCls}`}
                    >
                      {plan.badge && (
                        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-primary text-primary-foreground text-xs font-medium whitespace-nowrap">
                          {plan.badge}
                        </div>
                      )}

                      <div className="flex items-center gap-2 mb-3">
                        <Icon size={16} className={plan.iconCls} />
                        <span className="font-semibold text-sm text-foreground">{plan.name}</span>
                        {isCurrent && (
                          <span className="ml-auto text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                            Current
                          </span>
                        )}
                      </div>

                      <div className="mb-1">
                        <span className="text-2xl font-bold text-foreground">{plan.price}</span>
                        <span className="text-sm text-muted-foreground ml-1">{plan.period}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mb-4">{plan.description}</p>

                      <ul className="space-y-2 mb-5 flex-1">
                        {plan.features.map((f) => (
                          <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                            <Check size={12} className="text-primary mt-0.5 shrink-0" />
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>

                      <button
                        onClick={() => handleUpgrade(plan.id)}
                        disabled={isCurrent || !!upgrading}
                        className={`w-full py-2 px-4 rounded-lg text-xs font-medium transition-all ${plan.btnCls} ${
                          isCurrent ? 'opacity-50 cursor-default' : ''
                        } ${isLoading ? 'opacity-70 cursor-wait' : ''}`}
                      >
                        {isLoading
                          ? 'Upgrading…'
                          : isCurrent
                            ? 'Current Plan'
                            : plan.id === 'free'
                              ? 'Downgrade to Free'
                              : `Upgrade to ${plan.name}`}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Error */}
              {error && (
                <div className="px-6 pb-4 text-center">
                  <p className="text-xs text-destructive">{error}</p>
                </div>
              )}

              {/* Footer */}
              <div className="px-6 pb-5 text-center">
                <p className="text-xs text-muted-foreground/60">
                  Plans reset daily at midnight UTC. Cancel or change plan anytime.
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
