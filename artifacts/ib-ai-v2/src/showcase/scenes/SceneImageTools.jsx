import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Sparkles, Wand2, Download, ImageIcon,
  Loader2, Zap,
} from 'lucide-react';
import { IbLogo } from '../../components/IbLogo';
import { TypewriterText } from '../components/TypewriterText';

const PROMPT_TEXT = 'A cinematic close-up of a luxury cake, dark studio lighting, bokeh background, 8K editorial photography';

const CAPABILITIES = [
  { icon: Wand2,     label: 'AI Generate',   color: 'text-primary'    },
  { icon: Sparkles,  label: 'Enhance',        color: 'text-purple-400' },
  { icon: Zap,       label: 'Cinematic',      color: 'text-amber-400'  },
  { icon: ImageIcon, label: 'Edit & Upscale', color: 'text-emerald-400'},
];

export function SceneImageTools() {
  const [phase, setPhase] = useState('idle');   // idle | typing | generating | result

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('typing'),     600);
    const t2 = setTimeout(() => setPhase('generating'), 3200);
    const t3 = setTimeout(() => setPhase('result'),     5400);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">

      {/* Header */}
      <motion.header
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="flex items-center justify-between px-5 py-3.5 border-b border-border/50 glass-panel shrink-0"
        style={{ borderRadius: 0 }}
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg border border-border/50 text-muted-foreground">
            <ArrowLeft size={14} />
          </div>
          <IbLogo variant="compact" />
          <span className="text-muted-foreground/40 text-sm">/</span>
          <span className="text-sm font-semibold text-foreground">Image Tools</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="text-[10px] text-muted-foreground">Gemini 2.5</span>
        </div>
      </motion.header>

      <div className="flex flex-1 overflow-hidden">

        {/* Left — capabilities */}
        <motion.aside
          initial={{ x: -30, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ duration: 0.45, delay: 0.15 }}
          className="hidden md:flex flex-col w-48 shrink-0 border-r border-border/40 p-3 gap-1"
        >
          <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest px-2 mb-1">Tools</p>
          {CAPABILITIES.map(({ icon: Icon, label, color }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.25 + i * 0.07 }}
              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs cursor-default transition-colors ${
                i === 0 ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground'
              }`}
            >
              <Icon size={13} className={i === 0 ? 'text-primary' : color} />
              {label}
            </motion.div>
          ))}
        </motion.aside>

        {/* Main workspace */}
        <div className="flex-1 flex flex-col gap-5 pt-5 px-5 pb-[110px] overflow-hidden">

          {/* Prompt input */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.2 }}
            className="glass-card p-4 flex flex-col gap-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <Wand2 size={13} className="text-primary" />
              <span className="text-xs font-semibold text-foreground">AI Image Generation</span>
            </div>

            <div className="glass-input px-3.5 py-2.5 min-h-[56px] text-sm text-foreground/80 leading-relaxed">
              {phase === 'idle' && (
                <span className="text-muted-foreground/40">Describe the image you want to create…</span>
              )}
              {(phase === 'typing' || phase === 'generating' || phase === 'result') && (
                <TypewriterText
                  text={PROMPT_TEXT}
                  speed={30}
                  cursor={phase === 'typing'}
                />
              )}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                {['Realistic', 'Cinematic', 'Studio'].map((t, i) => (
                  <span
                    key={t}
                    className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors cursor-default ${
                      i === 1
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border/40 text-muted-foreground/60'
                    }`}
                  >
                    {t}
                  </span>
                ))}
              </div>
              <motion.button
                animate={phase === 'generating' ? { scale: [1, 0.96, 1] } : {}}
                transition={{ duration: 0.3, repeat: phase === 'generating' ? Infinity : 0, repeatDelay: 0.8 }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  phase === 'generating'
                    ? 'bg-primary/50 text-white cursor-not-allowed'
                    : 'bg-primary text-white hover:bg-primary/90'
                }`}
              >
                {phase === 'generating'
                  ? <><Loader2 size={11} className="animate-spin" />Generating…</>
                  : <><Sparkles size={11} />Generate</>}
              </motion.button>
            </div>
          </motion.div>

          {/* Result area */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.35 }}
            className="flex-1 glass-card p-4 flex flex-col gap-3 overflow-hidden"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ImageIcon size={13} className="text-muted-foreground" />
                <span className="text-xs font-semibold text-foreground">Output</span>
              </div>
              <AnimatePresence>
                {phase === 'result' && (
                  <motion.button
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex items-center gap-1 text-[10px] text-primary border border-primary/30 px-2 py-1 rounded-lg"
                  >
                    <Download size={10} />
                    Download
                  </motion.button>
                )}
              </AnimatePresence>
            </div>

            {/* Image placeholder / result */}
            <div className="flex-1 rounded-xl overflow-hidden relative min-h-0" style={{ minHeight: 140 }}>
              <AnimatePresence mode="wait">
                {phase === 'idle' || phase === 'typing' ? (
                  <motion.div
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border/30 rounded-xl"
                  >
                    <ImageIcon size={28} className="text-muted-foreground/20" />
                    <p className="text-xs text-muted-foreground/40">Generated image appears here</p>
                  </motion.div>
                ) : phase === 'generating' ? (
                  <motion.div
                    key="generating"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 rounded-xl overflow-hidden"
                  >
                    <div className="absolute inset-0 skeleton rounded-xl" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                      >
                        <Sparkles size={28} className="text-primary/60" />
                      </motion.div>
                      <p className="text-xs text-primary/70 font-medium">Generating your image…</p>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="result"
                    initial={{ opacity: 0, scale: 1.04 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                    className="absolute inset-0 rounded-xl overflow-hidden"
                  >
                    {/* Fake generated image — dark gradient scene */}
                    <div
                      className="absolute inset-0"
                      style={{
                        background: 'linear-gradient(135deg, #0a0512 0%, #0d0a1e 30%, #070d1a 60%, #0a0810 100%)',
                      }}
                    />
                    {/* Lighting effect */}
                    <div
                      className="absolute inset-0"
                      style={{
                        background: 'radial-gradient(ellipse 55% 45% at 50% 60%, rgba(99,102,241,0.18) 0%, transparent 70%)',
                      }}
                    />
                    <div
                      className="absolute inset-0"
                      style={{
                        background: 'radial-gradient(ellipse 40% 30% at 50% 55%, rgba(167,139,250,0.12) 0%, transparent 65%)',
                      }}
                    />
                    {/* Silhouette cake shape */}
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 flex flex-col items-center">
                      <div className="w-24 h-10 rounded-t-full"
                        style={{ background: 'linear-gradient(180deg,#3b2d5e 0%,#1e1633 100%)' }} />
                      <div className="w-32 h-10 rounded-t-sm -mt-1"
                        style={{ background: 'linear-gradient(180deg,#2d2050 0%,#150f2e 100%)' }} />
                      <div className="w-40 h-10 rounded-t-sm -mt-1"
                        style={{ background: 'linear-gradient(180deg,#241a44 0%,#0f0a20 100%)' }} />
                    </div>
                    {/* Bokeh dots */}
                    {[
                      { top: '15%', left: '20%', size: 16, opacity: 0.18 },
                      { top: '30%', left: '75%', size: 24, opacity: 0.12 },
                      { top: '60%', left: '10%', size: 12, opacity: 0.10 },
                      { top: '20%', left: '60%', size: 10, opacity: 0.15 },
                    ].map((b, i) => (
                      <div
                        key={i}
                        className="absolute rounded-full"
                        style={{
                          top: b.top, left: b.left,
                          width: b.size, height: b.size,
                          background: `rgba(139,92,246,${b.opacity})`,
                          filter: `blur(${b.size * 0.6}px)`,
                        }}
                      />
                    ))}
                    {/* Quality badge */}
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.5 }}
                      className="absolute top-3 right-3 flex items-center gap-1 bg-black/50 backdrop-blur-sm border border-white/10 px-2 py-1 rounded-full"
                    >
                      <Sparkles size={9} className="text-primary" />
                      <span className="text-[9px] text-white/80">AI Generated</span>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
