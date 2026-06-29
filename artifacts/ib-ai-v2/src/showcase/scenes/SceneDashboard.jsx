import { motion } from 'framer-motion';
import {
  Users, MessageSquare, Zap, Camera, Activity,
  CheckCircle2, TrendingUp, Cpu, Globe, Clock,
  BarChart2, Sparkles, Shield,
} from 'lucide-react';
import { IbLogo } from '../../components/IbLogo';

const METRICS = [
  { icon: Users,        label: 'Total Users',       value: '1,247',  delta: '+12%',  up: true,  color: '#3b82f6' },
  { icon: MessageSquare,label: 'Messages Today',     value: '8,934',  delta: '+34%',  up: true,  color: '#a855f7' },
  { icon: Camera,       label: 'Images Generated',  value: '2,109',  delta: '+8%',   up: true,  color: '#f59e0b' },
  { icon: Zap,          label: 'Avg Response',       value: '0.84s',  delta: '-12ms', up: true,  color: '#10b981' },
];

const PROVIDERS = [
  { name: 'Groq Llama',      status: 'operational', latency: '212ms', model: 'llama-3.1-8b' },
  { name: 'Gemini 2.5 Flash',status: 'operational', latency: '440ms', model: 'gemini-2.5-flash' },
  { name: 'Image Gen',       status: 'operational', latency: '3.2s',  model: 'imagen-3' },
  { name: 'TTS Engine',      status: 'operational', latency: '1.1s',  model: 'gemini-tts' },
];

const ACTIVITY = [
  { user: 'user_42a',   action: 'Generated image',     time: '2s ago',  icon: Camera        },
  { user: 'user_17f',   action: 'AI chat — 12 turns',  time: '8s ago',  icon: MessageSquare },
  { user: 'user_89c',   action: 'Voice synthesis',     time: '22s ago', icon: Zap           },
  { user: 'user_3b1',   action: 'Cinematic prompt',    time: '41s ago', icon: Sparkles      },
  { user: 'user_55e',   action: 'Image enhance',       time: '1m ago',  icon: Camera        },
];

const BAR_HEIGHTS = [35, 55, 42, 70, 58, 85, 65, 90, 72, 88, 78, 95];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.15 } },
};
const item = {
  hidden: { opacity: 0, y: 18, scale: 0.97 },
  show:   { opacity: 1, y: 0, scale: 1, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

export function SceneDashboard() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">

      {/* Header */}
      <motion.header
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="flex items-center justify-between px-5 py-3.5 border-b border-border/50 glass-panel shrink-0"
        style={{ borderRadius: 0 }}
      >
        <div className="flex items-center gap-3">
          <IbLogo variant="compact" />
          <span className="text-muted-foreground/40 text-sm">/</span>
          <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Shield size={13} className="text-primary" />
            CEO Dashboard
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-400/20">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[10px] text-emerald-400 font-medium">System Stable</span>
          </div>
          <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-primary text-[10px] font-bold">
            C
          </div>
        </div>
      </motion.header>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <motion.div variants={container} initial="hidden" animate="show" className="flex flex-col gap-4">

          {/* Metric cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {METRICS.map(({ icon: Icon, label, value, delta, up, color }) => (
              <motion.div key={label} variants={item} className="glass-card p-3.5">
                <div className="flex items-start justify-between mb-2">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                    style={{ background: `${color}15`, border: `1px solid ${color}25` }}>
                    <Icon size={14} style={{ color }} />
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    up ? 'text-emerald-400 bg-emerald-400/10' : 'text-rose-400 bg-rose-400/10'
                  }`}>
                    {delta}
                  </span>
                </div>
                <div className="text-lg font-bold text-foreground tracking-tight">{value}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
              </motion.div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

            {/* Message chart */}
            <motion.div variants={item} className="glass-card p-4 col-span-2">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <BarChart2 size={13} className="text-primary" />
                  <span className="text-xs font-semibold text-foreground">Message Volume — Last 12h</span>
                </div>
                <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                  <TrendingUp size={9} className="text-emerald-400" />
                  +34% vs yesterday
                </span>
              </div>
              <div className="flex items-end gap-1.5 h-20">
                {BAR_HEIGHTS.map((h, i) => (
                  <motion.div
                    key={i}
                    initial={{ height: 0 }}
                    animate={{ height: `${h}%` }}
                    transition={{ duration: 0.5, delay: 0.3 + i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                    className="flex-1 rounded-sm"
                    style={{
                      background: i === BAR_HEIGHTS.length - 1
                        ? 'hsl(var(--primary))'
                        : `hsl(217 91% 60% / ${0.2 + (h / 95) * 0.45})`,
                    }}
                  />
                ))}
              </div>
              <div className="flex justify-between mt-2">
                {['12h ago', '9h', '6h', '3h', 'Now'].map(t => (
                  <span key={t} className="text-[9px] text-muted-foreground/40">{t}</span>
                ))}
              </div>
            </motion.div>

            {/* Activity feed */}
            <motion.div variants={item} className="glass-card p-4 flex flex-col gap-2">
              <div className="flex items-center gap-2 mb-1">
                <Activity size={12} className="text-primary" />
                <span className="text-xs font-semibold text-foreground">Live Activity</span>
              </div>
              {ACTIVITY.map(({ user, action, time, icon: Icon }) => (
                <div key={user + time} className="flex items-center gap-2 py-1 border-b border-border/20 last:border-0">
                  <div className="w-5 h-5 rounded-full bg-secondary/60 flex items-center justify-center shrink-0">
                    <Icon size={9} className="text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-foreground/80 font-medium truncate">{user}</div>
                    <div className="text-[9px] text-muted-foreground truncate">{action}</div>
                  </div>
                  <div className="text-[9px] text-muted-foreground/50 shrink-0">{time}</div>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Provider status */}
          <motion.div variants={item} className="glass-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Cpu size={13} className="text-primary" />
              <span className="text-xs font-semibold text-foreground">AI Provider Status</span>
              <span className="ml-auto text-[10px] text-emerald-400">All Systems Operational</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {PROVIDERS.map(({ name, status, latency, model }) => (
                <div key={name} className="bg-secondary/20 border border-border/30 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
                    <span className="text-[11px] font-medium text-foreground truncate">{name}</span>
                  </div>
                  <div className="text-[9px] text-muted-foreground/60 font-mono truncate">{model}</div>
                  <div className="flex items-center gap-1 mt-1.5">
                    <Clock size={8} className="text-muted-foreground/40" />
                    <span className="text-[9px] text-muted-foreground">{latency}</span>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>

        </motion.div>
      </div>

      {/* Bottom glow */}
      <div className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 w-96 h-32"
        style={{ background: 'radial-gradient(ellipse, hsl(217 91% 60% / 0.06) 0%, transparent 70%)' }} />
    </div>
  );
}
