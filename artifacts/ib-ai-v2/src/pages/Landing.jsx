import { useRef } from 'react';
import { Link } from 'wouter';
import { motion, useInView } from 'framer-motion';
import {
  Camera, Film, Zap, Layers, Upload, Cpu, Sparkles,
  ArrowRight, Check, ChevronRight, Play,
} from 'lucide-react';

// ── Animation helpers ─────────────────────────────────────────────────────────

function FadeIn({ children, delay = 0, className = '' }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ── Navbar ────────────────────────────────────────────────────────────────────

function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center">
          <Cpu size={13} className="text-primary-foreground" />
        </div>
        <span className="font-semibold text-sm tracking-tight text-foreground">
          IB AI <span className="text-primary">Pro</span>
        </span>
      </div>

      <div className="hidden sm:flex items-center gap-6">
        <a href="#features" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Features</a>
        <a href="#pricing" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Pricing</a>
      </div>

      <div className="flex items-center gap-2">
        <Link
          to="/login"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg hover:bg-secondary"
        >
          Sign In
        </Link>
        <Link
          to="/signup"
          className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-lg hover:bg-primary/90 transition-colors font-medium"
        >
          Start Free
        </Link>
      </div>
    </nav>
  );
}

// ── Hero ──────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative flex flex-col items-center justify-center min-h-screen text-center px-6 pt-20 pb-16 overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-primary/8 rounded-full blur-[120px]" />
        <div className="absolute top-1/3 left-1/4 w-[300px] h-[300px] bg-purple-500/5 rounded-full blur-[100px]" />
      </div>

      {/* Badge */}
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-6"
      >
        <Sparkles size={11} />
        Powered by Gemini 2.5 Flash
      </motion.div>

      {/* Title */}
      <motion.h1
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1 }}
        className="text-4xl sm:text-5xl lg:text-6xl font-bold text-foreground max-w-4xl leading-tight tracking-tight"
      >
        Turn Any Image Into{' '}
        <span className="bg-gradient-to-r from-primary via-purple-400 to-primary bg-clip-text text-transparent">
          Cinematic Content
        </span>{' '}
        Instantly
      </motion.h1>

      {/* Subtitle */}
      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2 }}
        className="mt-5 text-base sm:text-lg text-muted-foreground max-w-xl leading-relaxed"
      >
        AI-powered creative studio for images, videos, and viral content.
        Upload any image and get professional cinematic prompts in seconds.
      </motion.p>

      {/* CTAs */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.3 }}
        className="mt-8 flex flex-wrap items-center justify-center gap-3"
      >
        <Link
          to="/signup"
          className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-xl font-medium text-sm hover:bg-primary/90 transition-all shadow-lg shadow-primary/20"
        >
          Start Free
          <ArrowRight size={15} />
        </Link>
        <a
          href="#demo"
          className="flex items-center gap-2 px-6 py-3 border border-border text-foreground rounded-xl font-medium text-sm hover:bg-secondary transition-all"
        >
          <Play size={13} />
          See How It Works
        </a>
      </motion.div>

      {/* Social proof */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.5 }}
        className="mt-6 text-xs text-muted-foreground/60"
      >
        Free to start · No credit card required · 5 free analyses daily
      </motion.p>
    </section>
  );
}

// ── Demo Flow ─────────────────────────────────────────────────────────────────

function DemoFlow() {
  const steps = [
    {
      icon: Upload,
      title: 'Upload Any Image',
      desc: 'Drop in a photo, product shot, portrait, or scene. JPEG, PNG, WebP, GIF supported.',
      color: 'text-blue-400',
      bg: 'bg-blue-500/10 border-blue-500/20',
    },
    {
      icon: Cpu,
      title: 'AI Analyzes Instantly',
      desc: 'Gemini vision reads mood, composition, lighting, and creative potential in seconds.',
      color: 'text-primary',
      bg: 'bg-primary/10 border-primary/20',
    },
    {
      icon: Sparkles,
      title: 'Get Creative Outputs',
      desc: 'Receive cinematic prompts, video direction, viral formats, and luxury brand aesthetics.',
      color: 'text-purple-400',
      bg: 'bg-purple-500/10 border-purple-500/20',
    },
  ];

  return (
    <section id="demo" className="py-20 px-6">
      <div className="max-w-5xl mx-auto">
        <FadeIn className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground">How It Works</h2>
          <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
            From upload to professional creative brief in under 10 seconds.
          </p>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 relative">
          {/* Connector lines (desktop) */}
          <div className="hidden sm:block absolute top-10 left-[calc(33.33%+8px)] right-[calc(33.33%+8px)] h-px bg-gradient-to-r from-border via-primary/30 to-border" />

          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <FadeIn key={step.title} delay={i * 0.1}>
                <div className={`relative flex flex-col items-center text-center p-6 rounded-2xl border ${step.bg}`}>
                  <div className={`w-12 h-12 rounded-xl border ${step.bg} flex items-center justify-center mb-4 ${step.color}`}>
                    <Icon size={22} />
                  </div>
                  <div className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-card border border-border flex items-center justify-center text-xs font-bold text-muted-foreground">
                    {i + 1}
                  </div>
                  <h3 className="font-semibold text-sm text-foreground mb-2">{step.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              </FadeIn>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── Features ──────────────────────────────────────────────────────────────────

function Features() {
  const features = [
    {
      icon: Camera,
      title: 'Cinematic Image Prompts',
      desc: 'Generate camera angles, lighting setups, and color grades that transform any photo into a cinematic production brief.',
    },
    {
      icon: Film,
      title: 'Video Direction AI',
      desc: 'Full professional video direction: camera movement, transitions, pacing, mood, and format — ready to hand to any editor.',
    },
    {
      icon: Zap,
      title: 'Viral Content Generator',
      desc: 'Platform-optimized creative formats — TikTok vertical, luxury brand, editorial aesthetic, and viral hook strategies.',
    },
    {
      icon: Layers,
      title: 'Multi-Mode Creative Engine',
      desc: 'Switch between cinematic, luxury, wallpaper, Canva-ready, and social formats. One image, infinite creative directions.',
    },
  ];

  return (
    <section id="features" className="py-20 px-6 bg-secondary/30">
      <div className="max-w-5xl mx-auto">
        <FadeIn className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground">The Full Creative Suite</h2>
          <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
            IB AI Pro is not a chatbot. It's a professional creative engine.
          </p>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {features.map((f, i) => {
            const Icon = f.icon;
            return (
              <FadeIn key={f.title} delay={i * 0.08}>
                <div className="flex gap-4 p-5 rounded-xl border border-border bg-card hover:border-primary/30 transition-colors">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <Icon size={18} className="text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-foreground mb-1">{f.title}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
                  </div>
                </div>
              </FadeIn>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── Pricing ───────────────────────────────────────────────────────────────────

function Pricing() {
  const plans = [
    {
      name: 'Free',
      price: '$0',
      period: 'forever',
      desc: 'Try the platform, no commitment.',
      features: ['5 credits per day', '2 image analyses daily', 'Unlimited AI chat', 'Basic creative prompts'],
      cta: 'Get Started Free',
      ctaLink: '/signup',
      ctaCls: 'border border-border text-foreground hover:bg-secondary',
    },
    {
      name: 'Pro',
      price: '$9',
      period: '/month',
      desc: 'For creators who ship daily.',
      features: ['100 credits per day', 'Unlimited image analyses', 'All creative modes', 'Video direction AI', 'Priority generation'],
      cta: 'Start Pro',
      ctaLink: '/signup',
      ctaCls: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20',
      featured: true,
    },
    {
      name: 'Max',
      price: '$29',
      period: '/month',
      desc: 'Studios and power users.',
      features: ['Unlimited credits', 'Unlimited everything', 'Fastest generation', 'Dedicated support', 'Early feature access'],
      cta: 'Start Max',
      ctaLink: '/signup',
      ctaCls: 'border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10',
    },
  ];

  return (
    <section id="pricing" className="py-20 px-6">
      <div className="max-w-5xl mx-auto">
        <FadeIn className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground">Simple, Transparent Pricing</h2>
          <p className="text-sm text-muted-foreground mt-2">Start free. Upgrade when you're ready.</p>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          {plans.map((plan, i) => (
            <FadeIn key={plan.name} delay={i * 0.08}>
              <div className={`relative flex flex-col rounded-2xl border p-6 h-full ${
                plan.featured
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border bg-card'
              }`}>
                {plan.featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-primary text-primary-foreground text-xs font-medium whitespace-nowrap">
                    Most Popular
                  </div>
                )}

                <div className="mb-4">
                  <h3 className="font-bold text-foreground text-base">{plan.name}</h3>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-3xl font-bold text-foreground">{plan.price}</span>
                    <span className="text-sm text-muted-foreground">{plan.period}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{plan.desc}</p>
                </div>

                <ul className="space-y-2.5 mb-6 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <Check size={12} className="text-primary mt-0.5 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>

                <Link
                  to={plan.ctaLink}
                  className={`w-full flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl text-sm font-medium transition-all ${plan.ctaCls}`}
                >
                  {plan.cta}
                  <ChevronRight size={14} />
                </Link>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Final CTA ─────────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className="py-20 px-6">
      <FadeIn>
        <div className="max-w-2xl mx-auto text-center">
          <div className="relative p-10 rounded-2xl border border-primary/20 bg-primary/5 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-purple-500/5 pointer-events-none" />
            <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-3">
              Start Creating With IB AI Pro
            </h2>
            <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
              Join creators turning ordinary images into cinematic content every day.
            </p>
            <Link
              to="/signup"
              className="inline-flex items-center gap-2 px-8 py-3 bg-primary text-primary-foreground rounded-xl font-medium text-sm hover:bg-primary/90 transition-all shadow-lg shadow-primary/25"
            >
              Get Started — It's Free
              <ArrowRight size={15} />
            </Link>
            <p className="mt-4 text-xs text-muted-foreground/60">
              No credit card required · 5 free analyses daily
            </p>
          </div>
        </div>
      </FadeIn>
    </section>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-border px-6 py-8">
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-md bg-primary flex items-center justify-center">
            <Cpu size={10} className="text-primary-foreground" />
          </div>
          <span className="text-xs font-semibold text-foreground">
            IB AI <span className="text-primary">Pro</span>
          </span>
        </div>
        <p className="text-xs text-muted-foreground/60">
          © {new Date().getFullYear()} IB AI Pro. All rights reserved.
        </p>
        <div className="flex items-center gap-4">
          <Link to="/login" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Sign In
          </Link>
          <Link to="/signup" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Sign Up
          </Link>
        </div>
      </div>
    </footer>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <Hero />
      <DemoFlow />
      <Features />
      <Pricing />
      <FinalCta />
      <Footer />
    </div>
  );
}
