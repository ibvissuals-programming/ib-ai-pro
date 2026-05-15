import { motion } from 'framer-motion';
import { Zap, Crown, Infinity as InfinityIcon } from 'lucide-react';

const PLAN_LABELS = {
  free: { label: 'Free', cls: 'text-muted-foreground bg-muted' },
  pro: { label: 'Pro', cls: 'text-primary bg-primary/15' },
  max: { label: 'Max', cls: 'text-yellow-400 bg-yellow-500/15' },
};

function barColor(pct) {
  if (pct > 50) return 'bg-primary';
  if (pct > 20) return 'bg-amber-500';
  return 'bg-rose-500';
}

/**
 * Compact usage meter displayed at the bottom of the Sidebar.
 *
 * @param {{ credits: object|null, onUpgradeClick: () => void }} props
 */
export function CreditMeter({ credits, onUpgradeClick }) {
  if (!credits) return null;

  const { creditsRemaining, dailyLimit, plan } = credits;
  const isUnlimited = dailyLimit === null;
  const pct = isUnlimited
    ? 100
    : dailyLimit > 0
      ? Math.round((creditsRemaining / dailyLimit) * 100)
      : 0;

  const planInfo = PLAN_LABELS[plan] ?? PLAN_LABELS.free;
  const low = !isUnlimited && creditsRemaining <= 1;
  const empty = !isUnlimited && creditsRemaining === 0;

  function usageLabel() {
    if (isUnlimited) return null;
    if (empty) return <span className="text-rose-400">Limit reached</span>;
    if (low) return <span className="text-amber-400">Running low</span>;
    return null;
  }

  const label = usageLabel();

  return (
    <div className="px-4 py-3 border-t border-sidebar-border space-y-2">
      {/* Plan badge + optional status label */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {plan === 'max' ? (
            <Crown size={11} className="text-yellow-400" />
          ) : (
            <Zap size={11} className={low ? 'text-rose-500' : 'text-muted-foreground'} />
          )}
          <span className="text-xs text-muted-foreground">
            {isUnlimited ? (
              <span className="flex items-center gap-1">
                Unlimited <InfinityIcon size={10} />
              </span>
            ) : label ? (
              label
            ) : (
              <span className="text-muted-foreground/60">Daily usage</span>
            )}
          </span>
        </div>

        <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${planInfo.cls}`}>
          {planInfo.label}
        </span>
      </div>

      {/* Progress bar (hidden for unlimited plans) */}
      {!isUnlimited && (
        <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${barColor(pct)}`}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      )}

      {/* Upgrade nudge — only shown for free plan when usage is low */}
      {plan === 'free' && (low || empty) && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onClick={onUpgradeClick}
          className="w-full text-xs text-primary hover:text-primary/80 text-center transition-colors"
        >
          {empty ? 'Daily limit reached — Upgrade' : 'Running low — Upgrade'}
        </motion.button>
      )}
    </div>
  );
}
