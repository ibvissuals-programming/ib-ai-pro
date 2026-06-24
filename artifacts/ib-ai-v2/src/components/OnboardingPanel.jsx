import { memo, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ImagePlus, Wand2, Lightbulb, MessageCircle, Video, TrendingUp, Clapperboard, Flame, Zap, ArrowRight, X } from 'lucide-react';
import { IbLogo } from './IbLogo';

const WELCOME_ACTIONS = [
  {
    label: 'Create an Image',
    prompt: 'Create a scroll-stopping, cinematic AI image for a TikTok or Instagram Reel — dramatic lighting, bold colors, high contrast. The concept: a glowing transformation reveal with a before/after split. Make it feel like a viral thumbnail.',
    icon: ImagePlus,
    gradient: 'from-blue-500/15 to-violet-500/8 hover:from-blue-500/25 hover:to-violet-500/15',
    border: 'border-blue-500/20 hover:border-blue-400/40',
    iconBg: 'bg-blue-500/10',
    iconColor: 'text-blue-400',
  },
  {
    label: 'Improve a Prompt',
    prompt: 'Improve this AI image prompt so it produces a cinematic, scroll-stopping visual for a short-form video thumbnail: "glowing portrait of a confident woman with dramatic light". Make it ultra-specific — lighting, color palette, mood, composition, and camera angle.',
    icon: Wand2,
    gradient: 'from-violet-500/15 to-fuchsia-500/8 hover:from-violet-500/25 hover:to-fuchsia-500/15',
    border: 'border-violet-500/20 hover:border-violet-400/40',
    iconBg: 'bg-violet-500/10',
    iconColor: 'text-violet-400',
  },
  {
    label: 'Brainstorm an Idea',
    prompt: 'Give me 5 viral TikTok and Instagram Reels content ideas for a before/after transformation series. For each idea include: the hook (first 3 seconds), the reveal angle, the visual treatment, and the suggested caption style. Make them feel native to current trends.',
    icon: Lightbulb,
    gradient: 'from-amber-500/15 to-orange-500/8 hover:from-amber-500/25 hover:to-orange-500/15',
    border: 'border-amber-500/20 hover:border-amber-400/40',
    iconBg: 'bg-amber-500/10',
    iconColor: 'text-amber-400',
  },
  {
    label: 'Ask Anything',
    prompt: 'What are the highest-performing content formats on TikTok and Instagram Reels right now, and how can I use AI-generated images to make them go viral faster?',
    icon: MessageCircle,
    gradient: 'from-emerald-500/15 to-teal-500/8 hover:from-emerald-500/25 hover:to-teal-500/15',
    border: 'border-emerald-500/20 hover:border-emerald-400/40',
    iconBg: 'bg-emerald-500/10',
    iconColor: 'text-emerald-400',
  },
];

const QUICK_CARDS = [
  { text: 'Write 5 scroll-stopping hooks for a glow-up reveal video', icon: Flame },
  { text: 'Caption ideas for a cinematic AI portrait post', icon: Clapperboard },
  { text: 'Content ideas for a 7-day transformation series', icon: Video },
  { text: "What's trending on TikTok for AI-generated content?", icon: TrendingUp },
];

/**
 * Builds the structured Hook Generator prompt.
 * The AI must produce exactly 5 hooks, one per emotional angle,
 * each labeled and explained — never generic, always topic-specific.
 *
 * @param {string} topic
 * @returns {string}
 */
function buildHookPrompt(topic) {
  return `Generate 5 powerful video hooks for this topic: "${topic}"

STEP 1 — SPECIFICITY ANCHOR (complete this before writing any hooks):
Identify the ONE most concrete, specific angle for "${topic}" — a real transformation detail, a counterintuitive outcome, a specific number or timeframe, or a defining moment that makes this topic distinct from everything else. It must be something that CANNOT apply to another topic.

Write it out like this:
**Specificity Anchor:** [1–2 sentences describing the specific angle you will anchor all 5 hooks to]

STEP 2 — GENERATE THE 5 HOOKS (all anchored to your specificity anchor above):

Format each hook exactly like this — no deviations:

**1. 🤔 Curiosity Hook**
[hook text — open a question, tease a mystery, or make them wonder "how?" — anchored to your specific angle]
*Why it works: [one sentence explaining the psychological trigger]*

**2. 😱 Shock / Surprise Hook**
[hook text — deliver an unexpected fact, counterintuitive truth, or stunning claim — specific to your anchor]
*Why it works: [one sentence]*

**3. 🤝 Relatability Hook**
[hook text — mirror a pain point or shared experience — specific to your anchor, NOT a generic "you know that feeling" opener]
*Why it works: [one sentence]*

**4. ✨ Aspiration Hook**
[hook text — paint the dream outcome or transformation — grounded in your specific anchor]
*Why it works: [one sentence]*

**5. 🔥 Controversy / Debate Hook**
[hook text — challenge a popular belief or make a bold claim — specific to your anchor]
*Why it works: [one sentence]*

Rules:
- Each hook must be written for the FIRST 3 SECONDS of a short-form video — direct, punchy, no warm-up
- Every hook must reference your Specificity Anchor — if a hook could apply to a different topic, rewrite it
- The five hooks must feel genuinely different in tone and angle, not just reworded versions of each other
- Keep hook text under 15 words
- NO generic openers like "Have you ever..." or "Imagine waking up..." — those phrases are banned`;
}

/**
 * OnboardingPanel — the welcome screen shown when a chat has no messages yet.
 *
 * Wrapped in React.memo so that parent re-renders (from verifySession, credit
 * polling, etc.) never reach this component while its stagger animations are
 * playing. The onSend prop is safe to memoize against because ChatApp provides
 * a ref-backed stable handleSuggest that never changes reference.
 */
export const OnboardingPanel = memo(function OnboardingPanel({ onSend }) {
  const [hookInputOpen, setHookInputOpen] = useState(false);
  const [topic, setTopic] = useState('');
  const inputRef = useRef(null);

  const openHookInput = () => {
    setHookInputOpen(true);
    // Focus after the AnimatePresence enter animation starts
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  const closeHookInput = () => {
    setHookInputOpen(false);
    setTopic('');
  };

  const handleGenerate = () => {
    const trimmed = topic.trim();
    if (!trimmed) return;
    onSend(buildHookPrompt(trimmed));
    closeHookInput();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
    if (e.key === 'Escape') closeHookInput();
  };

  return (
    <div
      className="flex flex-col items-center justify-start h-full text-center px-4 sm:px-6 py-8 overflow-y-auto"
      style={{
        scrollbarWidth: 'thin',
        scrollbarColor: 'hsl(217 33% 20%) transparent',
      }}
    >
      <div className="flex flex-col items-center w-full max-w-sm">

        {/* Logo — subtle scale-in */}
        <motion.div
          initial={{ opacity: 0, scale: 0.85, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="mb-5 mt-2"
        >
          <IbLogo variant="mark" size={64} />
        </motion.div>

        {/* Heading — quick fade-up */}
        <motion.h2
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
          className="text-xl font-bold text-foreground mb-2"
          style={{ letterSpacing: '-0.025em', fontFamily: 'Inter, sans-serif' }}
        >
          Welcome to IB <span className="text-primary">AI</span> Studio Lab
        </motion.h2>

        {/* Subtitle — quick fade-up */}
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.13, ease: [0.22, 1, 0.36, 1] }}
          className="text-sm text-muted-foreground leading-relaxed mb-6 max-w-[280px]"
        >
          Create viral content, write hooks, generate visuals, and build your short-form video strategy with AI.
        </motion.p>

        {/* 4 action buttons — 2×2 grid — immediately visible, no delay */}
        <div className="grid grid-cols-2 gap-2.5 w-full mb-2.5">
          {WELCOME_ACTIONS.map(({ label, prompt, icon: Icon, gradient, border, iconBg, iconColor }) => (
            <button
              key={label}
              onClick={() => onSend(prompt)}
              className={`
                flex flex-col items-start gap-2.5 p-3.5 rounded-2xl border
                bg-gradient-to-br ${gradient} ${border}
                text-left transition-all duration-200
                active:scale-[0.96] cursor-pointer
              `}
            >
              <span className={`p-1.5 rounded-lg ${iconBg} ${iconColor}`}>
                <Icon size={14} />
              </span>
              <span
                className="text-xs font-semibold text-foreground leading-snug"
                style={{ fontFamily: 'Inter, sans-serif' }}
              >
                {label}
              </span>
            </button>
          ))}
        </div>

        {/* ── Generate Hooks — full-width featured button ── */}
        <div className="w-full mb-6">
          <AnimatePresence mode="wait" initial={false}>
            {!hookInputOpen ? (
              <motion.button
                key="hook-closed"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16 }}
                onClick={openHookInput}
                className="
                  w-full flex items-center gap-3 p-3.5 rounded-2xl border
                  bg-gradient-to-br from-rose-500/15 to-pink-500/8
                  hover:from-rose-500/22 hover:to-pink-500/14
                  border-rose-500/20 hover:border-rose-400/40
                  text-left transition-all duration-200 active:scale-[0.97] cursor-pointer
                "
              >
                <span className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400 shrink-0">
                  <Zap size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <div
                    className="text-xs font-semibold text-foreground"
                    style={{ fontFamily: 'Inter, sans-serif' }}
                  >
                    Generate Hooks
                  </div>
                  <div className="text-[10px] text-muted-foreground/55 mt-0.5 leading-tight">
                    5 angles: curiosity · shock · relatability · aspiration · controversy
                  </div>
                </div>
                <ArrowRight size={13} className="text-rose-400/50 shrink-0" />
              </motion.button>
            ) : (
              <motion.div
                key="hook-open"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="w-full rounded-2xl border border-rose-500/30 bg-gradient-to-br from-rose-500/10 to-pink-500/5 p-4"
              >
                {/* Header row */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400">
                    <Zap size={12} />
                  </span>
                  <span
                    className="text-xs font-semibold text-foreground"
                    style={{ fontFamily: 'Inter, sans-serif' }}
                  >
                    Hook Generator
                  </span>
                  <button
                    onClick={closeHookInput}
                    className="ml-auto text-muted-foreground/35 hover:text-muted-foreground/65 transition-colors"
                    aria-label="Close hook generator"
                  >
                    <X size={13} />
                  </button>
                </div>

                {/* Topic input */}
                <input
                  ref={inputRef}
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. wig revamping before/after"
                  maxLength={120}
                  className="
                    w-full bg-background/60 border border-border/50 rounded-xl
                    px-3.5 py-2.5 text-sm text-foreground
                    placeholder:text-muted-foreground/40
                    focus:outline-none focus:border-rose-400/50 focus:ring-1 focus:ring-rose-400/20
                    transition-colors mb-3
                  "
                />

                {/* Generate button */}
                <button
                  onClick={handleGenerate}
                  disabled={!topic.trim()}
                  className="
                    w-full py-2 rounded-xl
                    bg-rose-500/20 hover:bg-rose-500/30
                    disabled:opacity-40 disabled:cursor-not-allowed
                    text-rose-300 text-xs font-semibold
                    transition-all duration-150 active:scale-[0.97]
                    flex items-center justify-center gap-1.5
                  "
                >
                  <Zap size={11} />
                  Generate 5 Hooks
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Divider */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.2 }}
          className="flex items-center gap-3 w-full mb-4"
        >
          <div className="flex-1 h-px bg-border/50" />
          <span className="text-[11px] text-muted-foreground/55 font-medium whitespace-nowrap tracking-wide">
            or try a quick prompt
          </span>
          <div className="flex-1 h-px bg-border/50" />
        </motion.div>

        {/* Quick-start cards */}
        <div className="flex flex-col gap-2 w-full">
          {QUICK_CARDS.map(({ text, icon: Icon }, i) => (
            <motion.button
              key={text}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: 0.25 + i * 0.06, ease: 'easeOut' }}
              whileHover={{ x: 2 }}
              onClick={() => onSend(text)}
              className="
                flex items-center gap-3 px-3.5 py-2.5 rounded-xl
                border border-border/40 bg-secondary/20
                hover:bg-secondary/50 hover:border-primary/25
                transition-all duration-150 text-left
                active:scale-[0.97] group cursor-pointer
              "
            >
              <div className="w-5 h-5 rounded-md bg-secondary flex items-center justify-center shrink-0 group-hover:bg-primary/10 transition-colors">
                <Icon
                  size={11}
                  className="text-muted-foreground/50 group-hover:text-primary/70 transition-colors"
                />
              </div>
              <span className="text-xs text-muted-foreground/70 group-hover:text-foreground/80 transition-colors leading-relaxed">
                {text}
              </span>
            </motion.button>
          ))}
        </div>

      </div>
    </div>
  );
});
