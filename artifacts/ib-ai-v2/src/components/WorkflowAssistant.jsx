/**
 * WorkflowAssistant.jsx — AI Workflow Assistant
 *
 * Non-intrusive suggestion layer shown after upload or on tool load.
 * Zero provider calls — all suggestions are heuristic-based.
 * Dismissible. Shows at most 2 suggestions at a time.
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X, ArrowRight } from 'lucide-react';

// ── Suggestion rules ──────────────────────────────────────────────────────────

const SUGGESTIONS = {
  image: {
    portrait:  { label: 'Luxury Portrait Pipeline',  mode: 'luxury',  voice: 'cinematic_narration', emoji: '💎', hint: 'Perfect for professional portrait editing with premium color grade.' },
    product:   { label: 'Social Ad Workflow',         mode: 'social',  voice: 'energetic_social',   emoji: '📱', hint: 'Mobile-optimized edits + energetic voiceover for product content.' },
    cinematic: { label: 'Cinematic Creative Reel',    mode: 'cinematic', voice: 'cinematic_narration', emoji: '🎬', hint: 'Filmic grade + dramatic narration for editorial and reel content.' },
    default:   { label: 'Polish + Publish',           mode: 'polish',  voice: 'neutral_assistant',  emoji: '✨', hint: 'Natural cleanup, balanced lighting, then publish-ready.' },
  },
  voice: {
    default:   { label: 'Cinematic Narration Setup', voiceStyle: 'cinematic_narration', emoji: '🎙️', hint: 'Deep dramatic voice for trailers, intros, and story content.' },
    social:    { label: 'Energetic Social Promo',    voiceStyle: 'energetic_social',   emoji: '⚡', hint: 'High-energy voice optimized for social media promotions.' },
  },
  video: {
    default:   { label: 'Luxury Showcase Motion',    videoMode: 'subtle_animation', emoji: '✨', hint: 'Subtle premium motion for product and lifestyle content.' },
    social:    { label: 'Social Zoom Reel',           videoMode: 'social_motion',    emoji: '📱', hint: 'Fast dynamic zoom for Instagram and TikTok reels.' },
  },
};

function getSuggestions(tool, context) {
  const pool = SUGGESTIONS[tool];
  if (!pool) return [];

  if (tool === 'image') {
    const hint = context?.imageHint ?? 'default';
    const primary = pool[hint] ?? pool.default;
    const secondary = hint !== 'cinematic' ? pool.cinematic : pool.product;
    return [primary, secondary].filter(Boolean).slice(0, 2);
  }
  if (tool === 'voice') {
    return [pool.default, pool.social];
  }
  if (tool === 'video') {
    return [pool.default, pool.social];
  }
  return [];
}

// ── Suggestion card ───────────────────────────────────────────────────────────

function SuggestionCard({ suggestion, onApply, tool }) {
  return (
    <motion.button
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={{ scale: 1.01 }}
      onClick={() => onApply(suggestion)}
      className="flex items-start gap-3 w-full text-left px-3.5 py-3 rounded-xl border border-primary/20 bg-primary/5 hover:bg-primary/10 hover:border-primary/35 transition-all group"
    >
      <span className="text-xl shrink-0 mt-0.5">{suggestion.emoji}</span>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-foreground leading-tight">{suggestion.label}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{suggestion.hint}</p>
      </div>
      <ArrowRight size={13} className="shrink-0 mt-1 text-muted-foreground group-hover:text-primary transition-colors" />
    </motion.button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function WorkflowAssistant({ tool, context, onApply, className = '' }) {
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setDismissed(false);
    const t = setTimeout(() => setVisible(true), 400);
    return () => clearTimeout(t);
  }, [tool, context?.imageHint]);

  const suggestions = getSuggestions(tool, context);

  if (!visible || dismissed || suggestions.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className={`overflow-hidden ${className}`}
      >
        <div className="rounded-2xl border border-border/50 bg-card/60 p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Sparkles size={11} className="text-primary" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                Suggested Workflows
              </span>
            </div>
            <button
              onClick={() => setDismissed(true)}
              className="p-1 rounded-lg text-muted-foreground/50 hover:text-muted-foreground hover:bg-secondary transition-colors"
            >
              <X size={11} />
            </button>
          </div>
          <div className="space-y-1.5">
            {suggestions.map((s, i) => (
              <SuggestionCard
                key={i}
                suggestion={s}
                tool={tool}
                onApply={(sug) => { setDismissed(true); onApply?.(sug); }}
              />
            ))}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
