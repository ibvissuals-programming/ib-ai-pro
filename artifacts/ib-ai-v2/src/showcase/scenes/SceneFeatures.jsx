import { motion } from 'framer-motion';
import {
  MessageSquare, Camera, Mic, Film, Sparkles,
  Zap, Shield, Layers, Globe, BarChart2, Clock, Star,
} from 'lucide-react';
import { IbLogo } from '../../components/IbLogo';

const FEATURES = [
  {
    icon: MessageSquare,
    title: 'Smart Chat AI',
    desc: 'Context-aware conversations powered by Groq Llama with Gemini fallback.',
    color: '#3b82f6',
    bg: 'rgba(59,130,246,0.08)',
    border: 'rgba(59,130,246,0.18)',
  },
  {
    icon: Camera,
    title: 'Image Generation',
    desc: 'Create stunning images from text with Gemini 2.5 Flash image synthesis.',
    color: '#a855f7',
    bg: 'rgba(168,85,247,0.08)',
    border: 'rgba(168,85,247,0.18)',
  },
  {
    icon: Film,
    title: 'Cinematic Engine',
    desc: 'Transform any image into production-ready cinematic prompts instantly.',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.18)',
  },
  {
    icon: Mic,
    title: 'Voice Studio',
    desc: 'Convert text to natural speech with multiple voices and styles.',
    color: '#10b981',
    bg: 'rgba(16,185,129,0.08)',
    border: 'rgba(16,185,129,0.18)',
  },
  {
    icon: Zap,
    title: 'Instant Results',
    desc: 'Sub-second responses with streaming output for the fastest creative flow.',
    color: '#f97316',
    bg: 'rgba(249,115,22,0.08)',
    border: 'rgba(249,115,22,0.18)',
  },
  {
    icon: Shield,
    title: 'Secure & Private',
    desc: 'JWT-authenticated sessions. Your data never trains any AI model.',
    color: '#06b6d4',
    bg: 'rgba(6,182,212,0.08)',
    border: 'rgba(6,182,212,0.18)',
  },
];

const STATS = [
  { icon: Globe,    value: '99.9%', label: 'Uptime'       },
  { icon: Clock,    value: '<1s',   label: 'Response'     },
  { icon: Layers,   value: '4',     label: 'AI Providers' },
  { icon: Star,     value: '∞',     label: 'Generations'  },
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.2 } },
};
const item = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  show:   { opacity: 1, y: 0,  scale: 1, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
};

export function SceneFeatures() {
  return (
    <div className="flex flex-col min-h-screen overflow-auto pt-14 px-6 pb-[110px]">

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center text-center gap-3 mb-10"
      >
        <IbLogo variant="wordmark" size={36} />
        <h2 className="text-3xl font-bold tracking-tight text-foreground mt-2" style={{ letterSpacing: '-0.03em' }}>
          Everything you need to{' '}
          <span className="text-primary">create faster</span>
        </h2>
        <p className="text-sm text-muted-foreground max-w-md">
          A complete AI creative suite — chat, generate, enhance, and produce in one place.
        </p>
      </motion.div>

      {/* Stats row */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.15 }}
        className="flex justify-center gap-4 mb-10 flex-wrap"
      >
        {STATS.map(({ icon: Icon, value, label }) => (
          <div
            key={label}
            className="glass-card flex flex-col items-center px-5 py-3 gap-1 min-w-[90px]"
          >
            <Icon size={13} className="text-primary mb-0.5" />
            <span className="text-lg font-bold text-foreground tracking-tight">{value}</span>
            <span className="text-[10px] text-muted-foreground">{label}</span>
          </div>
        ))}
      </motion.div>

      {/* Feature grid */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto w-full"
      >
        {FEATURES.map(({ icon: Icon, title, desc, color, bg, border }) => (
          <motion.div
            key={title}
            variants={item}
            className="glass-card p-4 flex flex-col gap-2.5"
            style={{ borderColor: border }}
            whileHover={{ y: -2, transition: { duration: 0.2 } }}
          >
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: bg, border: `1px solid ${border}` }}
            >
              <Icon size={16} style={{ color }} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-1">{title}</h3>
              <p className="text-[12px] text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* Bottom sparkle */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        className="flex justify-center mt-10"
      >
        <div className="inline-flex items-center gap-2 text-xs text-muted-foreground/50">
          <BarChart2 size={11} />
          All features available on free plan
        </div>
      </motion.div>
    </div>
  );
}
