/**
 * VideoStudio.jsx — IB AI Assistant
 *
 * Image-to-video studio. Full UI for all four video modes.
 * Backend infrastructure is live; provider activation pending.
 * Shows "Coming Soon" state with full input/mode selection ready.
 */
import { useState, useRef } from 'react';
import { Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Video, Upload, X, Sparkles,
  AlertCircle, Sun, Moon, Clock, Zap,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

// ── Video mode definitions ─────────────────────────────────────────────────────
const VIDEO_MODES = [
  {
    id:          'cinematic_motion',
    label:       'Cinematic Motion',
    description: 'Slow cinematic camera movement with depth-of-field emphasis',
    emoji:       '🎬',
    color:       'text-violet-400',
    bg:          'bg-violet-500/10 border-violet-500/25',
    activeBg:    'bg-violet-500/20 border-violet-400/50',
  },
  {
    id:          'zoom_parallax',
    label:       'Zoom & Parallax',
    description: 'Ken Burns zoom and parallax effect with depth-aware layers',
    emoji:       '🔭',
    color:       'text-blue-400',
    bg:          'bg-blue-500/10 border-blue-500/25',
    activeBg:    'bg-blue-500/20 border-blue-400/50',
  },
  {
    id:          'social_motion',
    label:       'Social Motion',
    description: 'Dynamic fast-cut motion optimized for social media engagement',
    emoji:       '⚡',
    color:       'text-orange-400',
    bg:          'bg-orange-500/10 border-orange-500/25',
    activeBg:    'bg-orange-500/20 border-orange-400/50',
  },
  {
    id:          'subtle_animation',
    label:       'Subtle Animation',
    description: 'Gentle light movement and subtle ambient animation',
    emoji:       '🌊',
    color:       'text-teal-400',
    bg:          'bg-teal-500/10 border-teal-500/25',
    activeBg:    'bg-teal-500/20 border-teal-400/50',
  },
];

const PROMPT_EXAMPLES = [
  'Camera slowly pushes in with dramatic lens flare',
  'Gentle parallax with bokeh light drift in background',
  'Fast dynamic cuts with energy burst transitions',
  'Subtle breathing motion with warm ambient glow',
];

// ── Upload zone ────────────────────────────────────────────────────────────────
function UploadZone({ image, onImage, onClear }) {
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const readFile = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = (e) => onImage(e.target.result);
    reader.readAsDataURL(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    readFile(e.dataTransfer.files?.[0]);
  };

  if (image) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative rounded-xl overflow-hidden border border-border/60"
      >
        <img src={image} alt="Source" className="w-full max-h-64 object-cover bg-black/10" />
        <button
          onClick={onClear}
          className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 backdrop-blur text-white hover:bg-black/80 transition-colors"
        >
          <X size={13} />
        </button>
        <div className="absolute bottom-2 left-2 text-[10px] px-2 py-1 rounded-lg bg-black/60 backdrop-blur text-white font-medium">
          Source image ready
        </div>
      </motion.div>
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
      className={`relative rounded-xl border-2 border-dashed transition-all cursor-pointer py-12 flex flex-col items-center gap-3 ${
        dragOver
          ? 'border-primary/60 bg-primary/5'
          : 'border-border/40 hover:border-primary/40 hover:bg-primary/3'
      }`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => readFile(e.target.files?.[0])}
      />
      <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center">
        <Upload size={16} className="text-muted-foreground" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">Upload source image</p>
        <p className="text-xs text-muted-foreground mt-1">JPG, PNG, WebP · max 10 MB</p>
      </div>
    </div>
  );
}

// ── Coming soon notice ─────────────────────────────────────────────────────────
function ComingSoonBanner() {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-amber-500/8 border border-amber-400/25"
    >
      <Clock size={14} className="text-amber-400 shrink-0 mt-0.5" />
      <div className="space-y-0.5">
        <p className="text-xs font-semibold text-amber-400">Video Generation — Coming Soon</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          The full pipeline (queue, job tracking, file storage) is built and ready.
          We're connecting the video provider now. Your settings will be saved when it activates.
        </p>
      </div>
    </motion.div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function VideoStudio() {
  const { theme, toggleTheme } = useTheme();
  const [image, setImage]         = useState(null);
  const [prompt, setPrompt]       = useState('');
  const [mode, setMode]           = useState('cinematic_motion');
  const [, setError]              = useState(null);

  const activeMode = VIDEO_MODES.find(m => m.id === mode) ?? VIDEO_MODES[0];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header
        className="flex items-center justify-between px-4 py-3 border-b border-border/50 glass-panel sticky top-0 z-10"
        style={{ borderRadius: 0 }}
      >
        <div className="flex items-center gap-3">
          <Link to="/chat" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded-lg hover:bg-secondary">
            <ArrowLeft size={13} />
            <span className="hidden sm:block">Back to Chat</span>
          </Link>
          <div className="w-px h-4 bg-border/50" />
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-primary flex items-center justify-center">
              <Video size={11} className="text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground tracking-tight">Video Studio</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-400/20 font-medium">
              Soon
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex justify-center px-4 py-8">
        <div className="w-full max-w-2xl space-y-6">
          <div>
            <h1 className="text-xl font-bold text-foreground tracking-tight">AI Video Studio</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Transform your images into cinematic video sequences with AI-powered motion.
            </p>
          </div>

          <ComingSoonBanner />

          <div className="glass-card p-6 rounded-2xl space-y-5">
            {/* Upload zone */}
            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                Source Image
              </label>
              <UploadZone
                image={image}
                onImage={setImage}
                onClear={() => { setImage(null); setError(null); }}
              />
            </div>

            {/* Prompt input */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                  Motion Instruction
                </label>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value.slice(0, 500))}
                placeholder="Describe the motion or camera movement you want…"
                rows={3}
                className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all resize-none leading-relaxed"
              />
              <div className="flex flex-wrap gap-1.5">
                {PROMPT_EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => setPrompt(ex)}
                    className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all"
                  >
                    {ex.length > 36 ? ex.slice(0, 36) + '…' : ex}
                  </button>
                ))}
              </div>
            </div>

            {/* Mode picker */}
            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                Motion Style
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {VIDEO_MODES.map((vm) => {
                  const active = mode === vm.id;
                  return (
                    <button
                      key={vm.id}
                      onClick={() => setMode(vm.id)}
                      className={`flex items-center gap-3 px-3.5 py-3 rounded-xl border text-left transition-all ${
                        active ? `${vm.activeBg} shadow-sm` : `${vm.bg} hover:opacity-90`
                      }`}
                    >
                      <span className="text-xl shrink-0">{vm.emoji}</span>
                      <div className="min-w-0">
                        <p className={`text-xs font-semibold ${active ? vm.color : 'text-foreground/80'}`}>
                          {vm.label}
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-tight mt-0.5 line-clamp-2">
                          {vm.description}
                        </p>
                      </div>
                      {active && (
                        <div className={`ml-auto w-2 h-2 rounded-full ${vm.color.replace('text-', 'bg-')} shrink-0`} />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Generate button — disabled with coming soon label */}
            <div className="space-y-2">
              <button
                disabled
                className="flex items-center gap-2 px-5 py-2.5 bg-primary/40 text-primary-foreground/60 rounded-xl text-sm font-medium cursor-not-allowed shadow-lg shadow-primary/10"
              >
                <Zap size={14} />
                Generate Video
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/30 text-amber-300 font-semibold uppercase tracking-wide">
                  Soon
                </span>
              </button>
              <p className="text-[11px] text-muted-foreground">
                Selected mode: <span className={`font-medium ${activeMode.color}`}>{activeMode.label}</span>
                {image ? ' · Image ready' : ' · Upload an image to get started'}
              </p>
            </div>

            {/* Capability preview */}
            <div className="rounded-xl bg-secondary/30 border border-border/30 p-4 space-y-3">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                What's being built
              </p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['4-second clips',        '720p HD output'],
                  ['Async job queue',       'Resume after refresh'],
                  ['4 motion styles',       'Download MP4'],
                  ['2 credits per video',   'CEO = unlimited'],
                ].map(([a, b], i) => (
                  <div key={i} className="space-y-0.5">
                    <p className="text-[11px] font-medium text-foreground/80">{a}</p>
                    <p className="text-[11px] text-muted-foreground">{b}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <p className="text-center text-xs text-muted-foreground/50">
            Video infrastructure complete · Provider connection in progress · 2 credits per video
          </p>
        </div>
      </main>
    </div>
  );
}
