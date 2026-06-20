import { motion } from 'framer-motion';
import { ImagePlus, Wand2, Lightbulb, MessageCircle, Camera, Palette, Sparkles, Zap } from 'lucide-react';
import { IbLogo } from './IbLogo';

const WELCOME_ACTIONS = [
  {
    label: 'Create an Image',
    prompt: 'Create a luxury cinematic portrait with dramatic golden lighting',
    icon: ImagePlus,
    gradient: 'from-blue-500/15 to-violet-500/8 hover:from-blue-500/25 hover:to-violet-500/15',
    border: 'border-blue-500/20 hover:border-blue-400/40',
    iconBg: 'bg-blue-500/10',
    iconColor: 'text-blue-400',
  },
  {
    label: 'Improve a Prompt',
    prompt: 'Improve this AI image prompt for better results: "a dog in a park"',
    icon: Wand2,
    gradient: 'from-violet-500/15 to-fuchsia-500/8 hover:from-violet-500/25 hover:to-fuchsia-500/15',
    border: 'border-violet-500/20 hover:border-violet-400/40',
    iconBg: 'bg-violet-500/10',
    iconColor: 'text-violet-400',
  },
  {
    label: 'Brainstorm an Idea',
    prompt: 'Brainstorm 5 creative and viral content ideas that combine AI and visual storytelling',
    icon: Lightbulb,
    gradient: 'from-amber-500/15 to-orange-500/8 hover:from-amber-500/25 hover:to-orange-500/15',
    border: 'border-amber-500/20 hover:border-amber-400/40',
    iconBg: 'bg-amber-500/10',
    iconColor: 'text-amber-400',
  },
  {
    label: 'Ask Anything',
    prompt: 'What are the most creative and impressive things you can help me build today?',
    icon: MessageCircle,
    gradient: 'from-emerald-500/15 to-teal-500/8 hover:from-emerald-500/25 hover:to-teal-500/15',
    border: 'border-emerald-500/20 hover:border-emerald-400/40',
    iconBg: 'bg-emerald-500/10',
    iconColor: 'text-emerald-400',
  },
];

const QUICK_CARDS = [
  { text: 'Create a luxury cinematic portrait', icon: Camera },
  { text: 'Design a futuristic logo concept', icon: Palette },
  { text: 'Write a viral TikTok idea about AI', icon: Sparkles },
  { text: 'Improve this AI prompt: "sunset over mountains"', icon: Zap },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.065, delayChildren: 0.05 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
};

export function OnboardingPanel({ onSend }) {
  return (
    <motion.div
      key="onboarding"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="flex flex-col items-center justify-start h-full text-center px-4 sm:px-6 py-8 overflow-y-auto"
      style={{
        scrollbarWidth: 'thin',
        scrollbarColor: 'hsl(217 33% 20%) transparent',
        willChange: 'transform',
      }}
    >
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="flex flex-col items-center w-full max-w-sm"
      >
        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, scale: 0.85, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="mb-5 mt-2"
        >
          <IbLogo variant="mark" size={64} />
        </motion.div>

        {/* Heading */}
        <motion.h2
          variants={itemVariants}
          className="text-xl font-bold text-foreground mb-2"
          style={{ letterSpacing: '-0.025em', fontFamily: 'Inter, sans-serif' }}
        >
          Welcome to IB <span className="text-primary">AI</span> Studio Lab
        </motion.h2>

        {/* Subtitle */}
        <motion.p
          variants={itemVariants}
          className="text-sm text-muted-foreground leading-relaxed mb-7 max-w-[280px]"
        >
          Create images, generate prompts, explore ideas, and build with AI.
        </motion.p>

        {/* 4 action buttons — 2×2 grid */}
        <motion.div
          variants={itemVariants}
          className="grid grid-cols-2 gap-2.5 w-full mb-7"
        >
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
        </motion.div>

        {/* Divider */}
        <motion.div
          variants={itemVariants}
          className="flex items-center gap-3 w-full mb-4"
        >
          <div className="flex-1 h-px bg-border/50" />
          <span className="text-[11px] text-muted-foreground/55 font-medium whitespace-nowrap tracking-wide">
            or try a quick prompt
          </span>
          <div className="flex-1 h-px bg-border/50" />
        </motion.div>

        {/* Quick-start cards */}
        <motion.div
          variants={itemVariants}
          className="flex flex-col gap-2 w-full"
        >
          {QUICK_CARDS.map(({ text, icon: Icon }, i) => (
            <motion.button
              key={text}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: 0.42 + i * 0.06, ease: 'easeOut' }}
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
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
