import { useState, useRef, useCallback, useEffect } from 'react';
import { Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Cpu, ArrowLeft, Wand2, Upload, ImageIcon,
  Download, X, Loader2, AlertCircle, Sparkles, Copy, Check,
  History, Trash2, RefreshCw, Clock, Film, Zap, ChevronDown, ChevronUp,
  Lightbulb, Eye, Sun, Moon, Palette, Aperture, Shield,
} from 'lucide-react';
import { generateImage, editImage, fetchImageHistory, deleteHistoryEntry, generateCinematicPrompt } from '../services/imageToolsApi';
import { useTheme } from '../contexts/ThemeContext';
import { WorkflowBanner } from '../components/WorkflowBanner';

// ── Rate limit guard (client-side) ────────────────────────────────────────────
const RATE_LIMIT_MS = 11_000;

function useRateLimit() {
  const lastRef = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    if (now - lastRef.current < RATE_LIMIT_MS) {
      return Math.ceil((RATE_LIMIT_MS - (now - lastRef.current)) / 1000);
    }
    lastRef.current = now;
    return 0;
  }, []);
}

// ── Copy button ───────────────────────────────────────────────────────────────
function CopyButton({ text, label = 'Copy prompt' }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      disabled={!text}
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded-lg hover:bg-secondary transition-all"
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      {copied ? 'Copied!' : label}
    </button>
  );
}

// ── Skeleton placeholder ──────────────────────────────────────────────────────
function ImageSkeleton({ label }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col items-center justify-center py-16 gap-4 rounded-2xl border border-dashed border-border/50 bg-secondary/20"
    >
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
        <div className="absolute inset-2 rounded-full border border-primary/10 border-t-primary/40 animate-spin" style={{ animationDuration: '1.5s', animationDirection: 'reverse' }} />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-1">This takes 10–30 seconds</p>
      </div>
      <div className="flex gap-2">
        {[40, 64, 48, 56].map((w, i) => (
          <div key={i} className="h-1 rounded-full bg-primary/20 animate-pulse" style={{ width: w, animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </motion.div>
  );
}

// ── Output card ───────────────────────────────────────────────────────────────
function OutputCard({ src, onClear, mode, intensity }) {
  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = src;
    a.download = `ib-ai-image-${Date.now()}.png`;
    a.click();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative rounded-2xl overflow-hidden border border-border/60 glass-card"
    >
      <img src={src} alt="Generated" className="w-full object-contain max-h-[520px] bg-black/20" />
      <div className="absolute top-2 left-2 flex gap-1.5">
        {mode && (
          <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-black/60 backdrop-blur text-white text-[10px] font-medium">
            <Film size={9} />
            {mode}
          </span>
        )}
        {intensity && intensity !== 'MEDIUM' && (
          <span className={`flex items-center gap-1 px-2 py-1 rounded-lg bg-black/60 backdrop-blur text-[10px] font-medium ${
            intensity === 'EXTREME' ? 'text-red-300' : intensity === 'HIGH' ? 'text-orange-300' : 'text-blue-300'
          }`}>
            <Zap size={9} />
            {intensity}
          </span>
        )}
      </div>
      <div className="absolute top-2 right-2 flex gap-1.5">
        <button
          onClick={handleDownload}
          title="Download image"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/60 backdrop-blur text-white text-xs hover:bg-black/80 transition-colors"
        >
          <Download size={12} />
          Save
        </button>
        <button
          onClick={onClear}
          title="Clear"
          className="p-1.5 rounded-lg bg-black/60 backdrop-blur text-white hover:bg-black/80 transition-colors"
        >
          <X size={12} />
        </button>
      </div>
    </motion.div>
  );
}

// ── Before / after comparison slider ─────────────────────────────────────────
function BeforeAfterSlider({ before, after }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="relative rounded-2xl overflow-hidden border border-border/60 select-none" style={{ touchAction: 'none' }}>
      <img src={before} alt="Before" className="w-full object-contain max-h-[520px] bg-black/20" draggable={false} />
      <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={after} alt="After" className="w-full object-contain max-h-[520px] bg-black/20" draggable={false} />
      </div>
      <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${pos}%` }}>
        <div className="w-0.5 h-full bg-white/80 shadow-lg" />
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 rounded-full bg-white shadow-xl flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 7L3 5M5 7L3 9M9 7L11 5M9 7L11 9" stroke="#333" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </div>
      </div>
      <input type="range" min="0" max="100" value={pos} onChange={(e) => setPos(Number(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
        style={{ WebkitAppearance: 'none', margin: 0, padding: 0 }}
      />
      <div className="absolute top-2 left-2 text-[10px] bg-black/60 backdrop-blur text-white px-2 py-0.5 rounded-md font-medium pointer-events-none">Before</div>
      <div className="absolute top-2 right-2 text-[10px] bg-primary/80 backdrop-blur text-white px-2 py-0.5 rounded-md font-medium pointer-events-none">After</div>
    </div>
  );
}

// ── Processing stage indicator ────────────────────────────────────────────────
const PROC_STAGES = ['Uploading', 'Analyzing', 'Enhancing', 'Validating', 'Finalizing'];
function ProcessingStageIndicator({ active }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!active) { setIdx(0); return; }
    const delays = [600, 2000, 12000, 4000, 2000];
    let cur = 0;
    const handles = [];
    const advance = () => {
      cur = Math.min(cur + 1, PROC_STAGES.length - 1);
      setIdx(cur);
      if (cur < PROC_STAGES.length - 1) handles.push(setTimeout(advance, delays[cur]));
    };
    handles.push(setTimeout(advance, delays[0]));
    return () => handles.forEach(clearTimeout);
  }, [active]);
  if (!active) return null;
  return (
    <div className="flex items-center justify-center gap-1 flex-wrap py-2">
      {PROC_STAGES.map((stage, i) => (
        <div key={stage} className="flex items-center gap-1">
          <div className={`w-1.5 h-1.5 rounded-full transition-all ${i < idx ? 'bg-emerald-400' : i === idx ? 'bg-primary animate-pulse' : 'bg-border'}`} />
          <span className={`text-[10px] transition-colors ${i === idx ? 'text-foreground font-medium' : i < idx ? 'text-emerald-400' : 'text-muted-foreground/40'}`}>{stage}</span>
          {i < PROC_STAGES.length - 1 && <div className={`w-3 h-px ${i < idx ? 'bg-emerald-400/50' : 'bg-border/40'}`} />}
        </div>
      ))}
    </div>
  );
}

// ── Error display ─────────────────────────────────────────────────────────────
function ErrorBox({ message }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-destructive/10 border border-destructive/25 text-destructive text-sm"
    >
      <AlertCircle size={14} className="shrink-0 mt-0.5" />
      <span className="leading-relaxed">{message}</span>
    </motion.div>
  );
}

// ── Generate tab ──────────────────────────────────────────────────────────────
function GenerateTab({ initialPrompt = '', savedResult = null, onResult = null }) {
  const [prompt, setPrompt] = useState(initialPrompt || savedResult?.prompt || '');
  const [output, setOutput] = useState(savedResult?.b64Image ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loadingMsg, setLoadingMsg] = useState('');
  const checkRate = useRateLimit();

  useEffect(() => {
    if (!loading) { setLoadingMsg(''); return; }
    const t1 = setTimeout(() => setLoadingMsg('Generation is taking longer than usual…'),    15_000);
    const t2 = setTimeout(() => setLoadingMsg('Model may be warming up. Your image is still processing.'), 30_000);
    const t3 = setTimeout(() => setLoadingMsg('Still working… please keep this tab open.'),  60_000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [loading]);

  useEffect(() => {
    if (savedResult?.b64Image && !loading) {
      setOutput(savedResult.b64Image);
    }
  }, [savedResult?.b64Image, loading]);

  const EXAMPLES = [
    'Cinematic sunset over a futuristic cityscape',
    'Studio portrait of a golden retriever in soft light',
    'Abstract digital art with neon geometry',
    'Professional product photo of a glass perfume bottle',
  ];

  const handleGenerate = async () => {
    if (loading || !prompt.trim()) return;
    const wait = checkRate();
    if (wait > 0) { setError(`Please wait ${wait}s before generating again.`); return; }
    setLoading(true);
    setError(null);
    try {
      console.log('[ImageTools:generate]', 'start');
      const res = await generateImage(prompt.trim());
      const result = {
        b64Image:       res.b64Image,
        prompt:         prompt.trim(),
        status:         res.status         ?? null,
        promptExpanded: res.promptExpanded ?? false,
        timestamp:      Date.now(),
      };
      setOutput(res.b64Image);
      onResult?.(result);
      console.log('[ImageTools:generate]', 'success', { expanded: res.promptExpanded ?? false });
    } catch (err) {
      console.log('[ImageTools:generate]', 'error', err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setOutput(null);
    onResult?.(null);
  };

  const showRestoredBadge = !!(savedResult?.b64Image && output === savedResult.b64Image && !loading);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Prompt</label>
          <CopyButton text={prompt} />
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
          placeholder="Describe the image you want to generate…"
          rows={3}
          className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all resize-none leading-relaxed"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button key={ex} onClick={() => setPrompt(ex)} className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all">
            {ex.length > 34 ? ex.slice(0, 34) + '…' : ex}
          </button>
        ))}
      </div>

      <button
        onClick={handleGenerate}
        disabled={loading || !prompt.trim()}
        className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
      >
        {loading ? <><Loader2 size={14} className="animate-spin" />Generating…</> : <><Sparkles size={14} />Generate Image</>}
      </button>

      <AnimatePresence>{error && <ErrorBox message={error} />}</AnimatePresence>

      <AnimatePresence>
        {loading && (
          <motion.div key="skeleton-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <ImageSkeleton label={loadingMsg || 'Generating your image…'} />
            {loadingMsg && (
              <p className="mt-2 text-center text-xs text-muted-foreground/70 animate-pulse">{loadingMsg}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {output && !loading && (
          <motion.div key="output-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {showRestoredBadge && savedResult?.timestamp && (
              <div className="mb-2 flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
                <Clock size={10} />
                <span>Last generated {new Date(savedResult.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                {savedResult.prompt && (
                  <span className="truncate max-w-[200px] opacity-70">· {savedResult.prompt}</span>
                )}
              </div>
            )}
            <OutputCard src={output} onClear={handleClear} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Edit mode options ─────────────────────────────────────────────────────────
const EDIT_MODES = [
  { value: '',             label: 'Auto-Detect',    description: 'AI selects best mode for your instruction',             icon: '✦',  color: 'text-muted-foreground' },
  { value: 'polish',       label: 'Polish',          description: 'Natural skin cleanup, lighting balance, sharpness',      icon: '✨',  color: 'text-emerald-400' },
  { value: 'cinematic',    label: 'Cinematic',       description: 'Filmic contrast, atmospheric depth, premium color grade', icon: '🎬', color: 'text-blue-400' },
  { value: 'social',       label: 'Social',          description: 'Punchy mobile-optimized, vibrant and controlled',        icon: '📱', color: 'text-cyan-400' },
  { value: 'luxury',       label: 'Luxury',          description: 'Ultra-clean premium aesthetic, soft highlights',         icon: '💎', color: 'text-amber-400' },
  { value: 'restore',      label: 'Restore',         description: 'Noise cleanup, blur reduction, image restoration',       icon: '🔧', color: 'text-orange-400' },
  { value: 'portrait_safe', label: 'Portrait Safe',  description: 'Maximum identity preservation, enhancement only',        icon: '🛡',  color: 'text-green-400' },
  { value: 'style_transfer', label: 'Style Transfer', description: 'Full artistic transformation — loose subject preservation', icon: '🎨', color: 'text-violet-400' },
  { value: 'creative',     label: 'Creative',        description: 'Full artistic freedom — complete transformation',         icon: '⚡',  color: 'text-orange-400' },
];

const INTENSITY_LEVELS = [
  { value: '',        label: 'Auto' },
  { value: 'LOW',     label: 'Low' },
  { value: 'MEDIUM',  label: 'Medium' },
  { value: 'HIGH',    label: 'High' },
  { value: 'EXTREME', label: 'Extreme' },
];

// ── AI Director panel (Cinematic Prompt Generator) ────────────────────────────
function AiDirectorPanel({ sourceImage, onApplyPrompt }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [insight, setInsight] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleGenerate = async () => {
    if (loading || !sourceImage) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setInsight(null);
    try {
      console.log('[ImageTools:director]', 'start');
      const result = await generateCinematicPrompt(sourceImage, controller.signal);
      setInsight(result);
      setOpen(true);
      console.log('[ImageTools:director]', 'success', { mood: result.moodTarget });
    } catch (err) {
      console.log('[ImageTools:director]', err.name === 'AbortError' ? 'aborted' : 'error', err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!sourceImage) return null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ layout: { duration: 0.2, ease: 'easeInOut' } }}
      className="rounded-xl border border-border/50 bg-secondary/20 overflow-hidden"
    >
      {/* Header row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-secondary/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-md bg-violet-500/15 flex items-center justify-center">
            <Film size={11} className="text-violet-400" />
          </div>
          <span className="text-[11px] font-semibold text-foreground/80 uppercase tracking-widest">AI Director</span>
          {insight && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400 border border-violet-400/20 font-medium">
              {insight.moodTarget}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!insight && !loading && (
            <span className="text-[10px] text-muted-foreground">Analyze image for cinematic direction</span>
          )}
          {open ? <ChevronUp size={13} className="text-muted-foreground" /> : <ChevronDown size={13} className="text-muted-foreground" />}
        </div>
      </button>

      {/* Expanded body */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3.5 space-y-3">
              {/* Generate button */}
              <button
                onClick={handleGenerate}
                disabled={loading}
                className="flex items-center gap-2 px-3.5 py-2 bg-violet-600/90 text-white rounded-lg text-xs font-medium hover:bg-violet-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-violet-500/20"
              >
                {loading
                  ? <><Loader2 size={12} className="animate-spin" />Analyzing scene…</>
                  : <><Sparkles size={12} />Generate Edit Idea</>}
              </button>

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2 text-[11px] text-destructive bg-destructive/10 rounded-lg px-3 py-2 border border-destructive/20">
                  <AlertCircle size={11} className="shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              {/* Insight result card */}
              {insight && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-2.5"
                >
                  {/* Scene + Mood row */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="rounded-lg bg-background/60 border border-border/40 px-3 py-2 space-y-1">
                      <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        <Eye size={9} />
                        Scene
                      </div>
                      <p className="text-[11px] text-foreground/80 leading-relaxed">{insight.sceneDescription}</p>
                    </div>
                    <div className="rounded-lg bg-background/60 border border-border/40 px-3 py-2 space-y-1">
                      <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        <Lightbulb size={9} />
                        Current Mood
                      </div>
                      <p className="text-[11px] text-foreground/80 leading-relaxed">{insight.mood}</p>
                      <div className="flex items-center gap-1 mt-1">
                        <span className="text-[9px] text-muted-foreground">→</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400 border border-violet-400/20 font-medium capitalize">{insight.moodTarget}</span>
                      </div>
                    </div>
                  </div>

                  {/* Lighting direction */}
                  <div className="rounded-lg bg-background/60 border border-border/40 px-3 py-2 space-y-1">
                    <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      <Sun size={9} />
                      Lighting Redesign
                    </div>
                    <p className="text-[11px] text-foreground/80 leading-relaxed">{insight.lightingDirection}</p>
                  </div>

                  {/* Color grade + Exposure row */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="rounded-lg bg-background/60 border border-border/40 px-3 py-2 space-y-1">
                      <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        <Palette size={9} />
                        Color Grade
                      </div>
                      <p className="text-[11px] text-foreground/80 leading-relaxed">{insight.colorGrade}</p>
                    </div>
                    <div className="rounded-lg bg-background/60 border border-border/40 px-3 py-2 space-y-1">
                      <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        <Aperture size={9} />
                        Exposure
                      </div>
                      <p className="text-[11px] text-foreground/80 leading-relaxed">{insight.exposureGuidance}</p>
                    </div>
                  </div>

                  {/* Director brief */}
                  <div className="rounded-lg bg-violet-500/8 border border-violet-400/20 px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1 text-[10px] font-semibold text-violet-400 uppercase tracking-wider">
                        <Film size={9} />
                        Director Brief
                      </div>
                      <CopyButton text={insight.cinematicEditPrompt} label="Copy" />
                    </div>
                    <p className="text-[11px] text-foreground/80 leading-relaxed">{insight.cinematicEditPrompt}</p>
                  </div>

                  {/* Apply button */}
                  <button
                    onClick={() => onApplyPrompt(insight.cinematicEditPrompt)}
                    className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg bg-violet-600/90 text-white hover:bg-violet-600 transition-all font-medium"
                  >
                    <Wand2 size={11} />
                    Use This Prompt
                  </button>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Enhancement Panel — Safe Enhancement Mode output ──────────────────────────
function EnhancementPanel({ result, sourceImage, onClear }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      className="space-y-4 rounded-2xl border border-primary/20 bg-primary/5 p-4"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <Sparkles size={13} className="text-primary" />
          <span className="text-sm font-semibold text-foreground">Suggested Edit Prompts</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/20 font-medium flex items-center gap-1">
            <Shield size={8} />
            Prompt Suggestions
          </span>
        </div>
        <button onClick={onClear} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
          <X size={12} />
        </button>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Fal.ai image editing is temporarily unavailable. Your original image is unchanged. Here are professional cinematic suggestions powered by Gemini AI:
      </p>

      {/* Original image preview */}
      {sourceImage && (
        <div className="rounded-xl overflow-hidden border border-border/50">
          <img src={sourceImage} alt="Original" className="w-full max-h-48 object-contain bg-black/10" />
          <div className="px-3 py-1.5 bg-secondary/50 text-[10px] text-muted-foreground flex items-center gap-1.5">
            <Shield size={9} />
            Original preserved — no modifications applied
          </div>
        </div>
      )}

      {/* Suggestions list */}
      {result.suggestions?.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
            <Lightbulb size={9} />Enhancement Steps
          </p>
          <div className="space-y-1.5">
            {result.suggestions.map((s, i) => (
              <div key={i} className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-background/60 border border-border/40">
                <span className="text-[10px] font-bold text-primary/60 shrink-0 mt-0.5 tabular-nums w-4">{i + 1}.</span>
                <span className="text-xs text-foreground leading-relaxed">{s}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Color, lighting, composition cards */}
      <div className="grid grid-cols-1 gap-2">
        {result.colorGrade && (
          <div className="px-3 py-2.5 rounded-xl bg-background/60 border border-border/40 space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
              <Palette size={9} />Color Grade
            </div>
            <p className="text-xs text-foreground leading-relaxed">{result.colorGrade}</p>
          </div>
        )}
        {result.lightingNotes && (
          <div className="px-3 py-2.5 rounded-xl bg-background/60 border border-border/40 space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
              <Sun size={9} />Lighting Notes
            </div>
            <p className="text-xs text-foreground leading-relaxed">{result.lightingNotes}</p>
          </div>
        )}
        {result.compositionNotes && (
          <div className="px-3 py-2.5 rounded-xl bg-background/60 border border-border/40 space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
              <Aperture size={9} />Composition
            </div>
            <p className="text-xs text-foreground leading-relaxed">{result.compositionNotes}</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── Edit tab ──────────────────────────────────────────────────────────────────
function EditTab({ initialPrompt = '', initialMode = '', initialIntensity = '' }) {
  const [sourceImage, setSourceImage] = useState(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [output, setOutput] = useState(null);
  const [outputMeta, setOutputMeta] = useState(null); // { mode, intensity, cinematicAnalysisUsed }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [editMode, setEditMode] = useState(initialMode);
  const [intensityLevel, setIntensityLevel] = useState(initialIntensity);
  const [useDirectorAnalysis, setUseDirectorAnalysis] = useState(false);
  const [showBeforeAfter, setShowBeforeAfter] = useState(false);
  const [enhancementResult, setEnhancementResult] = useState(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const checkRate = useRateLimit();

  useEffect(() => () => abortRef.current?.abort(), []);

  const EXAMPLES_BY_MODE = {
    '':            ['Add dramatic cinematic lighting', 'Make it look like a watercolor painting', 'Remove the watermark', 'Make the background a sunset beach'],
    polish:        ['Smooth skin naturally and balance lighting', 'Remove blemishes and even skin tone', 'Clean up skin and sharpen the eyes', 'Improve skin texture naturally'],
    cinematic:     ['Add dramatic cinematic lighting', 'Apply golden hour warm tones', 'Add moody blue-hour atmosphere', 'Film noir black and white grade'],
    social:        ['Make it pop for Instagram', 'Vibrant punchy mobile edit', 'Enhance for social media', 'TikTok-tuned color grade'],
    luxury:        ['Apply luxury editorial look', 'Premium campaign aesthetic', 'Soft luxury color grade', 'High-end fashion editorial treatment'],
    restore:       ['Remove noise and sharpen', 'Restore old photo quality', 'Fix blur and compression artifacts', 'Clean up and enhance detail'],
    portrait_safe: ['Subtle lighting improvement', 'Remove blemishes naturally', 'Fix exposure gently', 'Clean up background slightly'],
    style_transfer: ['Make it look like a watercolor painting', 'Convert to Studio Ghibli anime style', 'Apply editorial fashion photography look', 'Render as an oil painting'],
    creative:      ['Transport to a fantasy forest', 'Reimagine as sci-fi concept art', 'Place in a neon cyberpunk city', 'Transform into a surreal dreamscape'],
  };

  const examples = EXAMPLES_BY_MODE[editMode] ?? EXAMPLES_BY_MODE[''];

  const readFile = (file) => {
    if (!file || !file.type.startsWith('image/')) { setError('Please upload a valid image file (JPG, PNG, WebP).'); return; }
    if (file.size > 4 * 1024 * 1024) { setError('Image must be under 4 MB.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => { setSourceImage(e.target.result); setOutput(null); setOutputMeta(null); setError(null); };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files?.[0]; if (file) readFile(file); };

  const handleEdit = async () => {
    if (loading || !sourceImage || !prompt.trim()) return;
    const wait = checkRate();
    if (wait > 0) { setError(`Please wait ${wait}s before editing again.`); return; }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setOutput(null);
    setOutputMeta(null);
    setEnhancementResult(null);
    try {
      console.log('[ImageTools:edit]', 'start', { mode: editMode || 'auto', intensity: intensityLevel || 'auto', director: useDirectorAnalysis });
      const res = await editImage(
        sourceImage,
        prompt.trim(),
        editMode             || undefined,
        intensityLevel       || undefined,
        useDirectorAnalysis  || undefined,
        controller.signal,
      );
      console.log('[ImageTools:edit]', res.enhancementMode ? 'enhancement-mode' : 'success', { mode: res.mode ?? null });
      if (res.enhancementMode) {
        setEnhancementResult(res);
      } else {
        setOutput(res.b64Image);
        setOutputMeta({
          mode:                  res.mode          ?? null,
          intensity:             res.intensity      ?? null,
          cinematicAnalysisUsed: res.cinematicAnalysisUsed ?? false,
          pipelineDebug:         res.pipelineDebug  ?? null,
        });
      }
    } catch (err) {
      console.log('[ImageTools:edit]', err.name === 'AbortError' ? 'aborted' : 'error', err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Upload zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !sourceImage && fileInputRef.current?.click()}
        className={`relative rounded-xl border-2 border-dashed transition-all cursor-pointer overflow-hidden ${
          dragOver ? 'border-primary/60 bg-primary/5' : sourceImage ? 'border-border/40 cursor-default' : 'border-border/40 hover:border-primary/40 hover:bg-primary/3'
        }`}
      >
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} />
        {sourceImage ? (
          <div className="relative">
            <img src={sourceImage} alt="Source" className="w-full max-h-64 object-contain bg-black/10" />
            <button onClick={(e) => { e.stopPropagation(); setSourceImage(null); setOutput(null); setOutputMeta(null); }} className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 backdrop-blur text-white hover:bg-black/80 transition-colors"><X size={12} /></button>
            <button onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }} className="absolute bottom-2 right-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/60 backdrop-blur text-white text-xs hover:bg-black/80 transition-colors"><Upload size={11} />Replace</button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center"><ImageIcon size={18} className="text-muted-foreground" /></div>
            <div className="text-center">
              <p className="text-sm text-foreground font-medium">Drop an image here</p>
              <p className="text-xs text-muted-foreground mt-0.5">or click to browse — JPG, PNG, WebP up to 4 MB</p>
            </div>
          </div>
        )}
      </div>

      {/* AI Director panel — appears once an image is uploaded */}
      <AiDirectorPanel
        sourceImage={sourceImage}
        onApplyPrompt={(p) => setPrompt(p)}
      />

      {/* Edit prompt */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Enhance Instruction</label>
          <CopyButton text={prompt} />
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleEdit(); }}
          placeholder="Describe how to edit the image…"
          rows={2}
          className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all resize-none"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {examples.map((ex) => (
          <button key={ex} onClick={() => setPrompt(ex)} className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all">{ex}</button>
        ))}
      </div>

      {/* ── Edit Mode selector ── */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
          <Film size={9} />
          Edit Mode
        </label>
        <div className="grid grid-cols-1 gap-1.5">
          {EDIT_MODES.map(({ value, label, description, icon, color }) => (
            <button
              key={value}
              onClick={() => setEditMode(value)}
              className={`flex items-start gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                editMode === value
                  ? 'border-primary/60 bg-primary/8 shadow-sm'
                  : 'border-border/50 hover:border-primary/30 hover:bg-secondary/40 bg-transparent'
              }`}
            >
              <span className={`text-base leading-none mt-0.5 ${color}`}>{icon}</span>
              <div className="flex-1 min-w-0">
                <div className={`text-[12px] font-semibold leading-tight ${editMode === value ? 'text-primary' : 'text-foreground'}`}>
                  {label}
                  {value === '' && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/70">(recommended)</span>}
                </div>
                <div className="text-[10px] text-muted-foreground/70 mt-0.5 leading-snug">{description}</div>
              </div>
              {editMode === value && (
                <div className="w-2 h-2 rounded-full bg-primary mt-1 flex-shrink-0" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Intensity selector ── */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
          <Zap size={9} />
          Intensity
        </label>
        <div className="flex flex-wrap gap-1.5">
          {INTENSITY_LEVELS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setIntensityLevel(value)}
              className={`px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-all ${
                intensityLevel === value
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border/50 text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-secondary/40'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* AI Director auto-enhance toggle + Edit button */}
      <div className="flex flex-col gap-2.5">
        {sourceImage && (
          <label className="flex items-center gap-2.5 cursor-pointer select-none group w-fit">
            <div className="relative">
              <input
                type="checkbox"
                checked={useDirectorAnalysis}
                onChange={(e) => setUseDirectorAnalysis(e.target.checked)}
                className="sr-only"
              />
              <div className={`w-8 h-4 rounded-full transition-colors ${useDirectorAnalysis ? 'bg-violet-500' : 'bg-secondary border border-border'}`} />
              <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${useDirectorAnalysis ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </div>
            <span className="text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
              Auto-expand my prompt with AI
              {useDirectorAnalysis && <span className="ml-1.5 text-violet-400 font-medium">(+15–20s)</span>}
            </span>
          </label>
        )}
        <button
          onClick={handleEdit}
          disabled={loading || !sourceImage || !prompt.trim()}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20 w-fit"
        >
          {loading
            ? <><Loader2 size={14} className="animate-spin" />{useDirectorAnalysis ? 'Analyzing + Enhancing…' : 'Enhancing…'}</>
            : <><Wand2 size={14} />Enhance Image</>}
        </button>
      </div>

      <AnimatePresence>{error && <ErrorBox message={error} />}</AnimatePresence>
      <ProcessingStageIndicator active={loading} />
      <AnimatePresence>{loading && <ImageSkeleton label="Applying your edit…" />}</AnimatePresence>

      {/* ── LAYER 8: Before / After viewer ── */}
      <AnimatePresence>
        {output && !loading && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            {/* Mode badge row */}
            {(outputMeta?.mode || outputMeta?.cinematicAnalysisUsed) && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">Applied</span>
                {outputMeta?.mode && (
                  <span className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 font-medium">
                    <Film size={10} />
                    {outputMeta.mode}
                  </span>
                )}
                {outputMeta?.intensity && outputMeta.intensity !== 'MEDIUM' && (
                  <span className={`flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border font-medium ${
                    outputMeta.intensity === 'EXTREME'
                      ? 'bg-red-500/10 text-red-400 border-red-400/20'
                      : outputMeta.intensity === 'HIGH'
                      ? 'bg-orange-500/10 text-orange-400 border-orange-400/20'
                      : 'bg-blue-500/10 text-blue-400 border-blue-400/20'
                  }`}>
                    <Zap size={10} />
                    {outputMeta.intensity}
                  </span>
                )}
                {outputMeta?.cinematicAnalysisUsed && (
                  <span className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-violet-500/10 text-violet-400 border border-violet-400/20 font-medium">
                    <Sparkles size={10} />
                    AI Director
                  </span>
                )}
                {outputMeta?.mode && ['portrait_safe', 'polish', 'restore'].includes(outputMeta.mode) && (
                  <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-400/20 font-medium">
                    <Shield size={8} />
                    Identity Protected
                  </span>
                )}
                {outputMeta?.mode && ['cinematic', 'social', 'luxury'].includes(outputMeta.mode) && (
                  <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-400/20 font-medium">
                    <Sparkles size={8} />
                    Cinematic Grade
                  </span>
                )}
                {sourceImage && (
                  <button
                    onClick={() => setShowBeforeAfter(v => !v)}
                    className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                      showBeforeAfter
                        ? 'bg-primary/15 text-primary border-primary/30'
                        : 'bg-secondary/40 text-muted-foreground border-border/50 hover:text-foreground hover:border-primary/30'
                    }`}
                  >
                    {showBeforeAfter ? 'Hide Compare' : 'Compare'}
                  </button>
                )}
              </div>
            )}

            {/* Before / After drag slider */}
            {showBeforeAfter && sourceImage && output && (
              <BeforeAfterSlider before={sourceImage} after={output} />
            )}

            {/* Pipeline debug tracker */}
            {outputMeta?.pipelineDebug && (() => {
              const dbg = outputMeta.pipelineDebug;
              const STATUS_ICON = { success: '✓', failed: '✗', skipped: '—' };
              const STATUS_COLOR = {
                success: 'text-emerald-400 border-emerald-400/30 bg-emerald-500/8',
                failed:  'text-red-400 border-red-400/30 bg-red-500/8',
                skipped: 'text-muted-foreground border-border/40 bg-transparent',
              };
              const EFFECT_LABEL = {
                cleanup:        'Cleanup',
                enhancement:    'Enhancement',
                color_grading:  'Color Grade',
                style_transfer: 'Style',
                creative_pass:  'Creative',
                none:           '—',
              };
              const PIPELINE_STATUS_COLOR = {
                success: 'text-emerald-400',
                partial: 'text-amber-400',
                failed:  'text-red-400',
              };

              const stageList = [
                { key: 'stage_1_cleanup',     num: 1, label: 'Cleanup' },
                { key: 'stage_2_enhancement', num: 2, label: 'Enhance' },
                { key: 'stage_3_cinematic',   num: 3, label: 'Grade' },
              ];

              return (
                <div className="rounded-xl border border-border/40 bg-background/40 overflow-hidden">
                  {/* Header */}
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary/60 inline-block" />
                      Pipeline
                    </span>
                    <span className={`text-[10px] font-semibold capitalize ${PIPELINE_STATUS_COLOR[dbg.pipeline_status]}`}>
                      {dbg.pipeline_status}
                    </span>
                  </div>

                  {/* Stage rows */}
                  <div className="divide-y divide-border/20">
                    {stageList.map(({ key, num, label }) => {
                      const rec = dbg.stages[key];
                      const colorClass = STATUS_COLOR[rec.status];
                      return (
                        <div key={key} className="flex items-center gap-2.5 px-3 py-2">
                          {/* Stage number */}
                          <span className="text-[9px] font-bold text-muted-foreground/50 w-3 shrink-0">{num}</span>
                          {/* Status badge */}
                          <span className={`text-[9px] font-bold w-3.5 shrink-0 ${PIPELINE_STATUS_COLOR[rec.status] || 'text-muted-foreground'}`}>
                            {STATUS_ICON[rec.status]}
                          </span>
                          {/* Label */}
                          <span className={`text-[11px] font-medium flex-1 ${rec.status === 'skipped' ? 'text-muted-foreground/40' : 'text-foreground'}`}>
                            {label}
                          </span>
                          {/* Effect pill */}
                          {rec.status !== 'skipped' && rec.effect !== 'none' && (
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-md border font-medium ${colorClass}`}>
                              {EFFECT_LABEL[rec.effect] ?? rec.effect}
                            </span>
                          )}
                          {/* Failure reason */}
                          {rec.status === 'failed' && rec.reason && rec.reason !== 'model_rejection' && (
                            <span className="text-[9px] text-red-400/70 font-medium capitalize">{rec.reason.replace(/_/g, ' ')}</span>
                          )}
                          {/* Time */}
                          {rec.status !== 'skipped' && rec.time_ms > 0 && (
                            <span className="text-[9px] text-muted-foreground/50 tabular-nums shrink-0">
                              {rec.time_ms >= 1000 ? `${(rec.time_ms / 1000).toFixed(1)}s` : `${rec.time_ms}ms`}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Recommendation footer — only when not a clean success */}
                  {dbg.pipeline_status !== 'success' && (
                    <div className="px-3 py-2 border-t border-border/30 bg-amber-500/5">
                      <p className="text-[10px] text-amber-400/80 leading-snug">{dbg.recommendation}</p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Side-by-side comparison */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Before</p>
                <div className="rounded-xl overflow-hidden border border-border/50 bg-black/10 relative">
                  <img src={sourceImage} alt="Before" className="w-full object-contain max-h-52" />
                  <div className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/50 backdrop-blur text-[9px] text-white/80 font-medium">Original</div>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">After</p>
                <div className="rounded-xl overflow-hidden border border-primary/30 bg-black/10 relative shadow-sm shadow-primary/10">
                  <img src={output} alt="After" className="w-full object-contain max-h-52" />
                  <div className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-primary/60 backdrop-blur text-[9px] text-white font-medium">Edited</div>
                </div>
              </div>
            </div>

            <OutputCard src={output} onClear={() => { setOutput(null); setOutputMeta(null); }} mode={outputMeta?.mode} intensity={outputMeta?.intensity} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {enhancementResult && !loading && (
          <EnhancementPanel
            result={enhancementResult}
            sourceImage={sourceImage}
            onClear={() => setEnhancementResult(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── History tab ───────────────────────────────────────────────────────────────
function HistoryTab() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [lightboxSrc, setLightboxSrc] = useState(null);

  const loadHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchImageHistory(30);
      setEntries(data.entries ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadHistory(); }, []);

  const handleDelete = async (id) => {
    setDeletingId(id);
    try {
      await deleteHistoryEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const formatTime = (ts) => {
    const d = new Date(ts);
    const now = Date.now();
    const diffMs = now - ts;
    const diffMin = Math.floor(diffMs / 60_000);
    const diffHr = Math.floor(diffMs / 3_600_000);
    const diffDay = Math.floor(diffMs / 86_400_000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">Your saved images</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {loading ? 'Loading…' : `${entries.length} image${entries.length !== 1 ? 's' : ''} saved`}
          </p>
        </div>
        <button
          onClick={loadHistory}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <AnimatePresence>{error && <ErrorBox message={error} />}</AnimatePresence>

      {loading && !entries.length && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading your history…</p>
        </div>
      )}

      {!loading && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 rounded-2xl border border-dashed border-border/50 bg-secondary/10">
          <div className="w-12 h-12 rounded-2xl bg-secondary flex items-center justify-center">
            <History size={20} className="text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">No images yet</p>
            <p className="text-xs text-muted-foreground mt-1">Generate or enhance an image and it'll appear here.</p>
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <AnimatePresence>
            {entries.map((entry) => (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                layout
                className="group relative rounded-xl overflow-hidden border border-border/50 bg-black/5 hover:border-primary/30 transition-colors"
              >
                <button
                  onClick={() => setLightboxSrc(entry.imageUrl)}
                  className="block w-full"
                >
                  <img
                    src={entry.imageUrl}
                    alt={entry.prompt}
                    className="w-full object-cover aspect-square bg-secondary/30"
                    loading="lazy"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                </button>

                {/* Overlay on hover */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

                {/* Bottom info */}
                <div className="absolute bottom-0 left-0 right-0 p-2 translate-y-1 group-hover:translate-y-0 opacity-0 group-hover:opacity-100 transition-all duration-200">
                  <p className="text-[10px] text-white/90 leading-snug line-clamp-2 font-medium">{entry.prompt}</p>
                </div>

                {/* Type + time badge (always visible) */}
                <div className="absolute top-1.5 left-1.5 flex gap-1">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold backdrop-blur ${
                    entry.type === 'generate' ? 'bg-purple-600/70 text-white' : 'bg-blue-600/70 text-white'
                  }`}>
                    {entry.type === 'generate' ? 'GEN' : 'EDIT'}
                  </span>
                </div>

                {/* Time */}
                <div className="absolute top-1.5 right-8 flex items-center gap-1">
                  <span className="text-[9px] text-white/70 backdrop-blur bg-black/40 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                    <Clock size={8} />
                    {formatTime(entry.timestamp)}
                  </span>
                </div>

                {/* Delete */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(entry.id); }}
                  disabled={deletingId === entry.id}
                  className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/50 backdrop-blur text-white/70 hover:text-red-400 hover:bg-black/70 transition-colors"
                  title="Delete"
                >
                  {deletingId === entry.id
                    ? <Loader2 size={10} className="animate-spin" />
                    : <Trash2 size={10} />
                  }
                </button>

                {/* Mode badge at bottom */}
                {entry.mode && entry.mode !== 'Subtle Enhancement' && entry.mode !== 'IMAGE_GENERATION' && (
                  <div className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-primary/70 backdrop-blur text-white font-medium">{entry.mode}</span>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Lightbox */}
      <AnimatePresence>
        {lightboxSrc && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLightboxSrc(null)}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.9 }}
              className="relative max-w-2xl w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <img src={lightboxSrc} alt="Full size" className="w-full rounded-2xl object-contain max-h-[80vh]" />
              <div className="absolute top-3 right-3 flex gap-2">
                <button
                  onClick={() => { const a = document.createElement('a'); a.href = lightboxSrc; a.download = `ib-ai-${Date.now()}.jpg`; a.click(); }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/70 backdrop-blur text-white text-xs hover:bg-black/90 transition-colors"
                >
                  <Download size={12} />
                  Save
                </button>
                <button
                  onClick={() => setLightboxSrc(null)}
                  className="p-1.5 rounded-lg bg-black/70 backdrop-blur text-white hover:bg-black/90 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ImageTools() {
  const { theme, toggleTheme } = useTheme();

  // ── Read URL params once on mount (session restore from WorkflowLauncher) ──
  const [urlParams] = useState(() => new URLSearchParams(window.location.search));
  const urlPrompt    = urlParams.get('prompt')    ?? '';
  const urlMode      = urlParams.get('mode')       ?? '';
  const urlIntensity = urlParams.get('intensity') ?? '';
  const initialTab   = (urlMode || urlPrompt) ? 'edit' : 'generate';

  const hasWorkflow       = !!(urlMode || urlPrompt);
  const workflowSublabel  = urlMode
    ? `${urlMode.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}${urlIntensity ? ` · ${urlIntensity}` : ''}`
    : null;

  const [tab, setTab] = useState(initialTab);
  const [generateResult, setGenerateResult] = useState(null);

  const TABS = [
    { id: 'generate', icon: Sparkles, label: 'Generate' },
    { id: 'edit',     icon: Wand2,    label: 'Enhance' },
    { id: 'history',  icon: History,  label: 'History' },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/50 glass-panel sticky top-0 z-10" style={{ borderRadius: 0 }}>
        <div className="flex items-center gap-3">
          <Link to="/chat" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded-lg hover:bg-secondary">
            <ArrowLeft size={13} />
            <span className="hidden sm:block">Back to Chat</span>
          </Link>
          <div className="w-px h-4 bg-border/50" />
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-primary flex items-center justify-center">
              <Cpu size={11} className="text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground tracking-tight">AI Image Studio</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] px-2.5 py-1 rounded-full border border-border/50 text-muted-foreground hidden sm:block">Powered by FLUX</span>
          <button onClick={toggleTheme} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 flex justify-center px-4 py-8">
        <div className="w-full max-w-2xl space-y-6">
          <div>
            <h1 className="text-xl font-bold text-foreground tracking-tight">AI Image Studio</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Generate new images from text, transform existing ones, or browse your history.
            </p>
          </div>

          {hasWorkflow && (
            <WorkflowBanner
              label="Workflow Applied ✓"
              sublabel={workflowSublabel ?? undefined}
            />
          )}

          {/* Mode tabs */}
          <div className="flex gap-1 p-1 rounded-xl bg-secondary/40 border border-border/40 w-fit">
            {TABS.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  tab === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="glass-card p-6 rounded-2xl">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.15 }}
              >
                {tab === 'generate' && <GenerateTab initialPrompt={urlPrompt} savedResult={generateResult} onResult={setGenerateResult} />}
                {tab === 'edit'     && <EditTab initialPrompt={urlPrompt} initialMode={urlMode} initialIntensity={urlIntensity} />}
                {tab === 'history'  && <HistoryTab />}
              </motion.div>
            </AnimatePresence>
          </div>

          <p className="text-center text-xs text-muted-foreground/50">
            Images are generated via Pollinations AI · FLUX model · Free, no setup required
          </p>
        </div>
      </main>
    </div>
  );
}
