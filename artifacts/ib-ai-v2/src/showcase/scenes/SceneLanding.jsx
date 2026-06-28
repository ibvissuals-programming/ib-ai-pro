import { motion } from 'framer-motion';
import { Sparkles, ArrowRight, Camera, MessageSquare, Mic, Zap } from 'lucide-react';
import { IbLogo } from '../../components/IbLogo';

const FEATURES = [
  { icon: MessageSquare, label: 'Smart Chat AI' },
  { icon: Camera,        label: 'Image Generation' },
  { icon: Mic,           label: 'Voice Studio' },
  { icon: Zap,           label: 'Cinematic Engine' },
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.3 } },
};
const item = {
  hidden: { opacity: 0, y: 28 },
  show:   { opacity: 1, y: 0,  transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};

export function SceneLanding() {
  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen text-center px-6 overflow-hidden">

      {/* Background glows */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          className="absolute top-1/4 left-1/2 -translate-x-1/2 rounded-full"
          style={{ width: 800, height: 500, background: 'hsl(217 91% 60% / 0.07)', filter: 'blur(120px)' }}
          animate={{ scale: [1, 1.08, 1], opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute bottom-1/4 left-1/4 rounded-full"
          style={{ width: 320, height: 320, background: 'hsl(270 60% 60% / 0.05)', filter: 'blur(90px)' }}
          animate={{ scale: [1, 1.12, 1] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
        />
      </div>

      <motion.div variants={container} initial="hidden" animate="show" className="flex flex-col items-center gap-6 max-w-2xl">

        {/* Logo */}
        <motion.div variants={item}>
          <IbLogo variant="wordmark" size={48} />
        </motion.div>

        {/* Badge */}
        <motion.div
          variants={item}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium"
        >
          <Sparkles size={11} />
          Powered by Gemini 2.5 Flash
        </motion.div>

        {/* Headline */}
        <motion.h1
          variants={item}
          className="text-5xl sm:text-6xl font-bold tracking-tight text-foreground leading-[1.1]"
          style={{ fontFamily: 'Inter, sans-serif' }}
        >
          Turn Any Image Into{' '}
          <span className="text-primary">Cinematic</span>{' '}
          <span style={{ color: 'hsl(270 70% 65%)' }}>Content</span>{' '}
          Instantly
        </motion.h1>

        {/* Subtitle */}
        <motion.p
          variants={item}
          className="text-base text-muted-foreground max-w-lg leading-relaxed"
        >
          An AI assistant built for creative work — chat, analyze images, and
          generate production-ready prompts for editing, video, and content.
        </motion.p>

        {/* Feature pills */}
        <motion.div variants={item} className="flex flex-wrap justify-center gap-2 mt-2">
          {FEATURES.map(({ icon: Icon, label }) => (
            <span
              key={label}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                         bg-secondary/60 text-muted-foreground border border-border/60"
            >
              <Icon size={11} className="text-primary" />
              {label}
            </span>
          ))}
        </motion.div>

        {/* CTA buttons */}
        <motion.div variants={item} className="flex items-center gap-3 mt-2">
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.97 }}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold shadow-lg shadow-primary/25"
          >
            Get Started
            <ArrowRight size={14} />
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.97 }}
            className="px-5 py-2.5 rounded-xl border border-border/60 text-sm text-muted-foreground hover:text-foreground bg-secondary/40"
          >
            See How It Works
          </motion.button>
        </motion.div>

        {/* Trust line */}
        <motion.p variants={item} className="text-xs text-muted-foreground/50 mt-2">
          Free to start · No payment required · No credit card needed
        </motion.p>
      </motion.div>
    </div>
  );
}
