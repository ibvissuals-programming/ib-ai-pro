/**
 * WorkflowBanner — non-blocking workflow launch confirmation
 *
 * Renders a small emerald banner that auto-dismisses after `duration` ms.
 * Used by ImageTools, VoiceStudio, VideoStudio when launched from WorkflowLauncher.
 * No backend calls, no state loops, additive only.
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, X } from 'lucide-react';

export function WorkflowBanner({ label, sublabel, duration = 2500 }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(t);
  }, [duration]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
          className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-400/25 text-emerald-400"
        >
          <CheckCircle size={13} className="shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-semibold">{label}</span>
            {sublabel && (
              <span className="text-[11px] text-emerald-400/70 ml-2 truncate">{sublabel}</span>
            )}
          </div>
          <button
            onClick={() => setVisible(false)}
            className="p-0.5 rounded-md hover:bg-emerald-400/10 transition-colors shrink-0"
            aria-label="Dismiss"
          >
            <X size={11} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
