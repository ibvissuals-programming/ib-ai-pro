/**
 * canvasScenes/features.jsx
 *
 * Canvas-safe version of SceneFeatures — no framer-motion dependency.
 * Approximates the real scene's animation timing using cubicBezier easing
 * driven by requestAnimationFrame via useTween / useStaggeredTweens.
 *
 * Real scene animation contract (do not change without updating both):
 *   - Header block:  y -16→0, opacity 0→1, duration 500ms, delay 0ms
 *   - Stats row:     y 12→0,  opacity 0→1, duration 450ms, delay 150ms
 *   - Feature cards: stagger — delay = 200 + i*80ms per card,
 *                    duration 450ms, opacity 0→1, y 20→0, scale 0.97→1
 *   - Footer:        opacity 0→1, duration 300ms, delay 800ms
 *   - Easing:        cubic-bezier(0.22, 1, 0.36, 1) on all transitions
 */

import {
  MessageSquare, Camera, Film, Mic, Zap, Shield,
  Globe, Clock, Layers, Star, BarChart2,
} from 'lucide-react';
import { useTween, useStaggeredTweens } from './utils/useTween.js';

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
    desc: "JWT-authenticated sessions. Your data never trains any AI model.",
    color: '#06b6d4',
    bg: 'rgba(6,182,212,0.08)',
    border: 'rgba(6,182,212,0.18)',
  },
];

const STATS = [
  { icon: Globe,  value: '99.9%', label: 'Uptime'       },
  { icon: Clock,  value: '<1s',   label: 'Response'     },
  { icon: Layers, value: '4',     label: 'AI Providers' },
  { icon: Star,   value: '∞',     label: 'Generations'  },
];

export function CanvasSceneFeatures() {
  const headerTween = useTween(500, 0);
  const statsTween  = useTween(450, 150);
  const cardTweens  = useStaggeredTweens(6, 450, 80, 200);
  const footerTween = useTween(300, 800);

  return (
    <div className="flex flex-col min-h-screen overflow-auto py-14 px-6 bg-background text-foreground">

      {/* ── Header ── */}
      <div
        className="flex flex-col items-center text-center gap-3 mb-10"
        style={{
          opacity:   headerTween,
          transform: `translateY(${-16 * (1 - headerTween)}px)`,
        }}
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/20 flex items-center justify-center">
            <Zap size={16} className="text-primary" />
          </div>
          <span className="text-lg font-bold tracking-tight text-foreground">IB AI</span>
        </div>
        <h2
          className="text-3xl font-bold tracking-tight text-foreground mt-2"
          style={{ letterSpacing: '-0.03em' }}
        >
          Everything you need to{' '}
          <span className="text-primary">create faster</span>
        </h2>
        <p className="text-sm text-muted-foreground max-w-md">
          A complete AI creative suite — chat, generate, enhance, and produce in one place.
        </p>
      </div>

      {/* ── Stats row ── */}
      <div
        className="flex justify-center gap-4 mb-10 flex-wrap"
        style={{
          opacity:   statsTween,
          transform: `translateY(${12 * (1 - statsTween)}px)`,
        }}
      >
        {STATS.map(({ icon: Icon, value, label }) => (
          <div
            key={label}
            className="flex flex-col items-center px-5 py-3 gap-1 min-w-[90px] rounded-xl border border-border/40 bg-secondary/20"
          >
            <Icon size={13} className="text-primary mb-0.5" />
            <span className="text-lg font-bold text-foreground tracking-tight">{value}</span>
            <span className="text-[10px] text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      {/* ── Feature grid ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto w-full">
        {FEATURES.map(({ icon: Icon, title, desc, color, bg, border }, i) => (
          <div
            key={title}
            className="p-4 flex flex-col gap-2.5 rounded-xl border bg-secondary/10"
            style={{
              borderColor: border,
              opacity:     cardTweens[i],
              transform:   `translateY(${20 * (1 - cardTweens[i])}px) scale(${0.97 + 0.03 * cardTweens[i]})`,
            }}
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
          </div>
        ))}
      </div>

      {/* ── Footer ── */}
      <div
        className="flex justify-center mt-10"
        style={{ opacity: footerTween }}
      >
        <div className="inline-flex items-center gap-2 text-xs text-muted-foreground/50">
          <BarChart2 size={11} />
          All features available on free plan
        </div>
      </div>

    </div>
  );
}
