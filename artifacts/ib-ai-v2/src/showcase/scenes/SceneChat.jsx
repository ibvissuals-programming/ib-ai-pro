import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare, Plus, Sparkles, ArrowUp, MoreHorizontal,
  Camera, Mic, Film, BookOpen,
} from 'lucide-react';
import { IbLogo } from '../../components/IbLogo';
import { TypewriterText } from '../components/TypewriterText';

const USER_MSG  = 'Give me 5 viral hooks for my cake business';
const AI_REPLY  =
`Here are 5 viral hooks for your cake business:

1. **Curiosity:** Why do 90% of cake businesses fail in year one?
2. **Shock:** The average home baker undercharges by $800 every month.
3. **Relatability:** You spent all weekend baking and made nothing.
4. **Aspiration:** Your cake business can replace your 9-to-5 in 90 days.
5. **Controversy:** Pretty cakes never outsell ugly ones priced right.`;

const SIDEBAR_ITEMS = [
  'Hook strategy for cake business',
  'Viral content calendar ideas',
  'Price positioning guide',
  'Instagram caption prompts',
];

const NAV_ITEMS = [
  { icon: MessageSquare, label: 'Chat',   active: true  },
  { icon: Camera,        label: 'Images', active: false },
  { icon: Film,          label: 'Video',  active: false },
  { icon: Mic,           label: 'Voice',  active: false },
  { icon: BookOpen,      label: 'Library',active: false },
];

export function SceneChat() {
  const [phase, setPhase] = useState('user');   // user | typing | reply

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('typing'), 1400);
    const t2 = setTimeout(() => setPhase('reply'),  2800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden text-foreground">

      {/* ── Sidebar ── */}
      <motion.div
        initial={{ x: -60, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="hidden md:flex flex-col w-56 shrink-0 border-r border-border/50 glass-panel"
        style={{ borderRadius: 0 }}
      >
        {/* Logo */}
        <div className="px-4 py-4 border-b border-border/40">
          <IbLogo variant="compact" />
        </div>

        {/* Nav */}
        <div className="px-2 pt-3 pb-2 space-y-0.5">
          {NAV_ITEMS.map(({ icon: Icon, label, active }) => (
            <div
              key={label}
              className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-xs cursor-default transition-colors ${
                active
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-secondary/50'
              }`}
            >
              <Icon size={13} />
              {label}
            </div>
          ))}
        </div>

        <div className="px-3 py-2 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">Chats</span>
          <Plus size={12} className="text-muted-foreground/50" />
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-hidden px-2 space-y-0.5">
          {SIDEBAR_ITEMS.map((item, i) => (
            <motion.div
              key={item}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 + i * 0.08 }}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] cursor-default truncate ${
                i === 0
                  ? 'bg-secondary/80 text-foreground font-medium'
                  : 'text-muted-foreground'
              }`}
            >
              {item}
            </motion.div>
          ))}
        </div>

        {/* User badge */}
        <div className="border-t border-border/40 p-3 flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-primary text-[10px] font-bold shrink-0">
            U
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-medium text-foreground truncate">user</div>
            <div className="text-[9px] text-muted-foreground">Free plan</div>
          </div>
          <MoreHorizontal size={12} className="text-muted-foreground/50 shrink-0" />
        </div>
      </motion.div>

      {/* ── Main ── */}
      <div className="flex flex-col flex-1 min-w-0">

        {/* Header */}
        <motion.header
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="flex items-center justify-between px-4 py-3 border-b border-border/50 glass-panel shrink-0"
          style={{ borderRadius: 0 }}
        >
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-primary" />
            <span className="text-sm font-semibold text-foreground">IB AI Assistant</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">Chat</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[10px] text-muted-foreground">Groq · Llama</span>
          </div>
        </motion.header>

        {/* Messages */}
        <div className="flex-1 overflow-hidden flex flex-col justify-end px-4 py-6 gap-4">

          {/* User bubble */}
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="flex justify-end"
          >
            <div
              className="max-w-xs px-4 py-2.5 rounded-2xl rounded-br-md text-sm text-white font-medium bubble-user"
            >
              {USER_MSG}
            </div>
          </motion.div>

          {/* AI response */}
          <AnimatePresence mode="wait">
            {phase === 'typing' && (
              <motion.div
                key="typing"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-start gap-2.5"
              >
                <div className="w-7 h-7 rounded-xl bg-primary/15 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                  <Sparkles size={12} className="text-primary" />
                </div>
                <div className="glass-card px-3.5 py-2.5 rounded-2xl rounded-tl-md">
                  <div className="flex gap-1 items-center h-4">
                    {[0, 1, 2].map(i => (
                      <motion.div
                        key={i}
                        className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50"
                        animate={{ y: [0, -4, 0] }}
                        transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
                      />
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {phase === 'reply' && (
              <motion.div
                key="reply"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
                className="flex items-start gap-2.5"
              >
                <div className="w-7 h-7 rounded-xl bg-primary/15 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                  <Sparkles size={12} className="text-primary" />
                </div>
                <div className="glass-card px-3.5 py-2.5 rounded-2xl rounded-tl-md max-w-lg">
                  <TypewriterText
                    text={AI_REPLY}
                    speed={22}
                    delay={100}
                    className="text-sm text-foreground/90 leading-relaxed"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Input bar */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="px-4 pb-4 shrink-0"
        >
          <div className="glass-input flex items-center gap-2 px-4 py-2.5">
            <span className="flex-1 text-sm text-muted-foreground/40">Ask anything…</span>
            <div className="p-1.5 rounded-lg bg-secondary/60">
              <ArrowUp size={14} className="text-muted-foreground/40" />
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
