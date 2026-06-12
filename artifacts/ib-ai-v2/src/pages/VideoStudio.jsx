/**
 * VideoStudio.jsx — IB AI Assistant
 *
 * Image-to-video studio powered by Gemini Veo.
 * Includes persistent video history and creator presets.
 *
 * States:
 *   idle            → shows the form (always available)
 *   submitting      → POST /api/video/generate, waiting for jobId
 *   polling         → GET /api/video/status/:jobId every 5 seconds
 *   completed       → shows video player
 *   failed          → shows error with retry option
 *   provider_not_configured → shows "Coming Soon" overlay
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Video, Upload, X, Sparkles,
  AlertCircle, Sun, Moon, Clock, Zap, Download,
  RefreshCw, CheckCircle, Film, History, Play, Layers,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import {
  startVideoGeneration,
  pollVideoStatus,
  getVideoUrl,
} from '../services/videoApi';
import { fetchVideoHistory } from '../services/historyApi';
import { WorkflowLauncher } from '../components/WorkflowLauncher';
import { WorkflowBanner } from '../components/WorkflowBanner';

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

// ── Creator presets ────────────────────────────────────────────────────────────
const VIDEO_PRESETS = [
  {
    id:     'cinematic',
    label:  'Cinematic',
    emoji:  '🎬',
    prompt: 'Slow cinematic camera pan, depth of field pull, dramatic lighting shift, film grain',
    mode:   'cinematic_motion',
  },
  {
    id:     'social_zoom',
    label:  'Social Zoom',
    emoji:  '📱',
    prompt: 'Fast dynamic zoom in, vibrant color pop, social media reel energy, punchy motion',
    mode:   'social_motion',
  },
  {
    id:     'parallax',
    label:  'Parallax Reel',
    emoji:  '🌀',
    prompt: 'Ken Burns effect, parallax depth layers, slow zoom with atmospheric perspective',
    mode:   'zoom_parallax',
  },
  {
    id:     'luxury',
    label:  'Luxury Showcase',
    emoji:  '✨',
    prompt: 'Gentle ambient light movement, luxury product reveal, subtle shimmer, premium slow motion',
    mode:   'subtle_animation',
  },
];

const PROMPT_EXAMPLES = [
  'Camera slowly pushes in with dramatic lens flare',
  'Gentle parallax with bokeh light drift in background',
  'Fast dynamic cuts with energy burst transitions',
  'Subtle breathing motion with warm ambient glow',
];

const POLL_INTERVAL_MS   = 5_000;
const MAX_POLL_DURATION_MS = 130_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function statusColor(status) {
  if (status === 'completed') return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
  if (status === 'failed')    return 'text-red-400 bg-red-400/10 border-red-400/20';
  if (status === 'provider_not_configured') return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
  return 'text-muted-foreground/60 bg-muted/20 border-border/20';
}

function statusLabel(status) {
  if (status === 'completed') return 'Ready';
  if (status === 'failed')    return 'Failed';
  if (status === 'provider_not_configured') return 'Provider Access Pending';
  return status;
}

// ── Upload zone ────────────────────────────────────────────────────────────────
function UploadZone({ image, onImage, onClear, disabled }) {
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
    if (!disabled) readFile(e.dataTransfer.files?.[0]);
  };

  if (image) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative rounded-xl overflow-hidden border border-border/60"
      >
        <img src={image} alt="Source" className="w-full max-h-64 object-cover bg-black/10" />
        {!disabled && (
          <button
            onClick={onClear}
            className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 backdrop-blur text-white hover:bg-black/80 transition-colors"
          >
            <X size={13} />
          </button>
        )}
        <div className="absolute bottom-2 left-2 text-[10px] px-2 py-1 rounded-lg bg-black/60 backdrop-blur text-white font-medium">
          Source image ready
        </div>
      </motion.div>
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && fileInputRef.current?.click()}
      className={`relative rounded-xl border-2 border-dashed transition-all py-12 flex flex-col items-center gap-3 ${
        disabled
          ? 'border-border/20 opacity-50 cursor-not-allowed'
          : dragOver
            ? 'border-primary/60 bg-primary/5 cursor-pointer'
            : 'border-border/40 hover:border-primary/40 hover:bg-primary/3 cursor-pointer'
      }`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => readFile(e.target.files?.[0])}
        disabled={disabled}
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

// ── Status banner ──────────────────────────────────────────────────────────────
function StatusBanner({ status, message, elapsed }) {
  if (status === 'provider_not_configured') {
    return (
      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-amber-500/8 border border-amber-400/25"
      >
        <Clock size={14} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-amber-400">Video Generation — API Access Required</p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            The full pipeline is active and ready. Veo video access requires special API key permissions.
            Your settings are saved — try again once Veo access is enabled.
          </p>
        </div>
      </motion.div>
    );
  }
  if (status === 'polling' || status === 'submitting') {
    const elapsedSec = Math.floor((elapsed ?? 0) / 1000);
    return (
      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-primary/8 border border-primary/25"
      >
        <RefreshCw size={14} className="text-primary shrink-0 mt-0.5 animate-spin" />
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-primary">
            {status === 'submitting' ? 'Starting generation…' : `Generating video… (${elapsedSec}s)`}
          </p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {message ?? 'Gemini Veo is processing your image. This takes 30–90 seconds.'}
          </p>
        </div>
      </motion.div>
    );
  }
  if (status === 'failed') {
    return (
      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-red-500/8 border border-red-400/25"
      >
        <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-red-400">Generation Failed</p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {message ?? 'The video could not be generated. Please try again.'}
          </p>
        </div>
      </motion.div>
    );
  }
  if (status === 'completed') {
    return (
      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-emerald-500/8 border border-emerald-400/25"
      >
        <CheckCircle size={14} className="text-emerald-400 shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-emerald-400">Video Ready</p>
          <p className="text-[11px] text-muted-foreground">Your video has been generated successfully.</p>
        </div>
      </motion.div>
    );
  }
  return null;
}

// ── Video player ───────────────────────────────────────────────────────────────
function VideoPlayer({ jobId, onReset }) {
  const videoUrl = getVideoUrl(jobId);
  return (
    <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} className="space-y-4">
      <div className="rounded-xl overflow-hidden border border-border/60 bg-black">
        <video src={videoUrl} controls autoPlay loop muted playsInline className="w-full max-h-72" />
      </div>
      <div className="flex items-center gap-2">
        <a
          href={videoUrl}
          download={`ib-video-${jobId}.mp4`}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-border/60 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
        >
          <Download size={12} />
          Download MP4
        </a>
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-border/60 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <Film size={12} />
          New Video
        </button>
      </div>
    </motion.div>
  );
}

// ── History card ───────────────────────────────────────────────────────────────
function HistoryCard({ entry }) {
  const mode = VIDEO_MODES.find(m => m.id === entry.mode) ?? VIDEO_MODES[0];
  const isReady = entry.status === 'completed';
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-3 px-3 py-3 rounded-xl border border-border/25 bg-secondary/20 hover:bg-secondary/30 transition-colors"
    >
      <div className={`w-8 h-8 rounded-lg ${mode.bg.split(' ')[0]} flex items-center justify-center shrink-0`}>
        <span className="text-sm">{mode.emoji}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground/80 leading-relaxed line-clamp-2">{entry.prompt}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded border ${statusColor(entry.status)}`}>
            {statusLabel(entry.status)}
          </span>
          <span className="text-[10px] text-muted-foreground">{mode.label}</span>
          {entry.timestamp && (
            <span className="text-[10px] text-muted-foreground/50">{formatRelative(entry.timestamp)}</span>
          )}
        </div>
      </div>
      {isReady && (
        <a
          href={getVideoUrl(entry.jobId)}
          download={`ib-video-${entry.jobId}.mp4`}
          className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          title="Download"
        >
          <Download size={12} />
        </a>
      )}
    </motion.div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function VideoStudio() {
  const { theme, toggleTheme } = useTheme();

  // ── Capture URL params once for banner display ────────────────────────────
  const [urlParams] = useState(() => new URLSearchParams(window.location.search));
  const hasWorkflow      = !!(urlParams.get('prompt') || urlParams.get('vmode'));
  const urlVModeId       = urlParams.get('vmode');
  const workflowModeLabel = urlVModeId
    ? (VIDEO_MODES.find(m => m.id === urlVModeId)?.label ?? urlVModeId.replace(/_/g, ' '))
    : null;

  const [image, setImage]         = useState(null);
  const [prompt, setPrompt]       = useState('');
  const [mode, setMode]           = useState('cinematic_motion');
  const [genState, setGenState]   = useState('idle');
  const [jobId, setJobId]         = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);
  const [error, setError]         = useState(null);
  const [startTime, setStartTime] = useState(null);
  const [elapsed, setElapsed]     = useState(0);
  const [history, setHistory]     = useState([]);
  const [historyLoading, setHLoad] = useState(true);

  const pollRef    = useRef(null);
  const elapsedRef = useRef(null);

  const activeMode = VIDEO_MODES.find(m => m.id === mode) ?? VIDEO_MODES[0];
  const isWorking  = genState === 'submitting' || genState === 'polling';
  const isDone     = genState === 'completed' || genState === 'failed' || genState === 'provider_not_configured';

  // ── Restore from URL params on mount (WorkflowLauncher session restore) ──
  useEffect(() => {
    const params   = new URLSearchParams(window.location.search);
    const urlPrompt = params.get('prompt');
    const urlVMode  = params.get('vmode');
    if (urlPrompt) setPrompt(urlPrompt);
    if (urlVMode && VIDEO_MODES.some(m => m.id === urlVMode)) setMode(urlVMode);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load persistent history on mount ─────────────────────────────────────
  useEffect(() => {
    fetchVideoHistory()
      .then(setHistory)
      .catch(() => {})
      .finally(() => setHLoad(false));
  }, []);

  // ── Elapsed timer ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (genState === 'polling' && startTime) {
      elapsedRef.current = setInterval(() => setElapsed(Date.now() - startTime), 1_000);
    } else {
      if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }
    }
    return () => { if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; } };
  }, [genState, startTime]);

  // ── Polling logic ─────────────────────────────────────────────────────────
  const startPolling = useCallback((id, pollingStart) => {
    const deadline = pollingStart + MAX_POLL_DURATION_MS;

    const poll = async () => {
      if (Date.now() > deadline) {
        setGenState('failed');
        setStatusMsg('Generation timed out. The video may still be processing — try refreshing later.');
        return;
      }
      try {
        const data = await pollVideoStatus(id);
        const st   = data.status;
        if (st === 'completed') {
          setGenState('completed');
          setStatusMsg('Video ready');
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          // Refresh history after completion
          setTimeout(() => fetchVideoHistory().then(setHistory).catch(() => {}), 1_000);
          return;
        }
        if (st === 'provider_not_configured') {
          setGenState('provider_not_configured');
          setStatusMsg(data.metadata?.message ?? null);
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setTimeout(() => fetchVideoHistory().then(setHistory).catch(() => {}), 1_000);
          return;
        }
        if (st === 'failed') {
          setGenState('failed');
          setStatusMsg(data.metadata?.message ?? 'Generation failed — please try again.');
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setTimeout(() => fetchVideoHistory().then(setHistory).catch(() => {}), 1_000);
          return;
        }
        setStatusMsg(data.metadata?.message ?? null);
      } catch (err) {
        console.warn('[VideoStudio] poll error:', err.message);
      }
    };

    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current)    { clearInterval(pollRef.current);    pollRef.current = null; }
      if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }
    };
  }, []);

  // ── Generate ──────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!image || !prompt.trim() || isWorking) return;
    setGenState('submitting');
    setError(null);
    setJobId(null);
    setStatusMsg(null);
    try {
      const data = await startVideoGeneration(image, prompt.trim(), mode);
      const id   = data.jobId ?? data.result?.jobId;
      if (!id) throw new Error('No job ID returned from server');
      const now = Date.now();
      setJobId(id);
      setStartTime(now);
      setElapsed(0);
      setGenState('polling');
      startPolling(id, now);
    } catch (err) {
      const msg = err.message ?? '';
      setGenState('failed');
      if (msg.includes('413')) {
        setError('Image is too large. Please use an image under 10 MB.');
      } else if (msg.includes('429') || msg.includes('rate')) {
        setError('Rate limit reached. Please wait a moment before generating again.');
      } else if (msg.includes('402') || msg.includes('credit')) {
        setError('Insufficient credits. Video generation costs 2 credits.');
      } else {
        setError(msg || 'Request failed — please try again.');
      }
      setStatusMsg(msg || 'Request failed — please try again.');
    }
  };

  // ── Reset ─────────────────────────────────────────────────────────────────
  const handleReset = () => {
    if (pollRef.current)    { clearInterval(pollRef.current);    pollRef.current = null; }
    if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }
    setGenState('idle');
    setJobId(null);
    setStatusMsg(null);
    setError(null);
    setStartTime(null);
    setElapsed(0);
  };

  const applyPreset = (preset) => {
    if (isWorking) return;
    setPrompt(preset.prompt);
    setMode(preset.mode);
  };

  const canGenerate = !!image && prompt.trim().length > 0 && !isWorking;

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
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/20 font-medium">
              Veo 2
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <WorkflowLauncher
            trigger={
              <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/60 text-xs text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-secondary/40 transition-all">
                <Layers size={12} />
                <span className="hidden sm:block">Workflows</span>
              </button>
            }
          />
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
              Transform your images into cinematic video sequences powered by Gemini Veo 2.
            </p>
          </div>

          {hasWorkflow && (
            <WorkflowBanner
              label="Workflow Applied ✓"
              sublabel={workflowModeLabel ? `Mode: ${workflowModeLabel}` : undefined}
            />
          )}

          {/* Creator Presets */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Sparkles size={11} className="text-primary" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Creator Presets</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {VIDEO_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset)}
                  disabled={isWorking}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border/60 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span>{preset.emoji}</span>
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Status banner */}
          <AnimatePresence mode="wait">
            {(isWorking || isDone) && (
              <StatusBanner key={genState} status={genState} message={statusMsg} elapsed={elapsed} />
            )}
          </AnimatePresence>

          {/* Video player (completed state) */}
          <AnimatePresence>
            {genState === 'completed' && jobId && (
              <VideoPlayer key={jobId} jobId={jobId} onReset={handleReset} />
            )}
          </AnimatePresence>

          {/* Form — always shown unless completed */}
          {genState !== 'completed' && (
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
                  disabled={isWorking}
                />
              </div>

              {/* Prompt input */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                    Motion Instruction
                  </label>
                  <span className="text-[10px] text-muted-foreground/60">{prompt.length}/500</span>
                </div>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value.slice(0, 500))}
                  placeholder="Describe the motion or camera movement you want…"
                  rows={3}
                  disabled={isWorking}
                  className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all resize-none leading-relaxed disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <div className="flex flex-wrap gap-1.5">
                  {PROMPT_EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      onClick={() => !isWorking && setPrompt(ex)}
                      disabled={isWorking}
                      className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
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
                        onClick={() => !isWorking && setMode(vm.id)}
                        disabled={isWorking}
                        className={`flex items-center gap-3 px-3.5 py-3 rounded-xl border text-left transition-all disabled:opacity-60 ${
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

              {/* Error banner */}
              <AnimatePresence>
                {error && genState === 'failed' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl bg-red-500/8 border border-red-400/25"
                  >
                    <AlertCircle size={13} className="text-red-400 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-red-400/90">{error}</p>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Generate button */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleGenerate}
                    disabled={!canGenerate}
                    className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all shadow-lg ${
                      canGenerate
                        ? 'bg-primary text-primary-foreground hover:opacity-90 shadow-primary/20 cursor-pointer'
                        : 'bg-primary/40 text-primary-foreground/60 cursor-not-allowed shadow-none'
                    }`}
                  >
                    {isWorking
                      ? <><RefreshCw size={14} className="animate-spin" />{genState === 'submitting' ? 'Starting…' : 'Generating…'}</>
                      : <><Zap size={14} />Generate Video</>
                    }
                  </button>
                  {(genState === 'failed' || genState === 'provider_not_configured') && (
                    <button
                      onClick={handleReset}
                      className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-sm font-medium border border-border/60 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    >
                      <RefreshCw size={13} />
                      Reset
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Mode: <span className={`font-medium ${activeMode.color}`}>{activeMode.label}</span>
                  {image ? ' · Image ready' : ' · Upload an image to begin'}
                  {' · 2 credits per video · 30–90 seconds'}
                </p>
              </div>

              {/* Specs */}
              <div className="rounded-xl bg-secondary/30 border border-border/30 p-4 space-y-3">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Video specs</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['5-second clips', '720p HD output'],
                    ['Async job queue', 'Poll until ready'],
                    ['4 motion styles', 'Download MP4'],
                    ['2 credits / video', 'CEO = unlimited'],
                  ].map(([a, b], i) => (
                    <div key={i} className="space-y-0.5">
                      <p className="text-[11px] font-medium text-foreground/80">{a}</p>
                      <p className="text-[11px] text-muted-foreground">{b}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Persistent video history */}
          <AnimatePresence>
            {(historyLoading || history.length > 0) && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-card rounded-2xl overflow-hidden"
              >
                <div className="px-5 py-3 border-b border-border/40 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <History size={12} className="text-muted-foreground" />
                    <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                      Video History
                    </h2>
                  </div>
                  {historyLoading && <RefreshCw size={10} className="text-muted-foreground animate-spin" />}
                  {!historyLoading && history.length > 0 && (
                    <span className="text-[10px] text-muted-foreground/60">{history.length} generations</span>
                  )}
                </div>

                {historyLoading ? (
                  <div className="p-4 space-y-2">
                    {[1, 2].map(i => (
                      <div key={i} className="h-14 rounded-xl bg-secondary/30 animate-pulse" />
                    ))}
                  </div>
                ) : history.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-8 px-4">
                    <Video size={20} className="text-muted-foreground/30" />
                    <p className="text-xs text-muted-foreground/60">No video generations yet</p>
                    <p className="text-[11px] text-muted-foreground/40">Completed videos appear here</p>
                  </div>
                ) : (
                  <div className="p-3 space-y-2">
                    {history.map((entry, i) => (
                      <HistoryCard key={entry.jobId ?? entry.timestamp ?? i} entry={entry} />
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <p className="text-center text-xs text-muted-foreground/50">
            Powered by Gemini Veo 2 · Async generation · 2 credits per video
          </p>
        </div>
      </main>
    </div>
  );
}
