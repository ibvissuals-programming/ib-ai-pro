import { useState, useRef, useCallback, useEffect } from 'react';
import { Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Cpu, ArrowLeft, Wand2, Upload, ImageIcon,
  Download, X, Loader2, AlertCircle, Sparkles, Copy, Check,
  History, Trash2, RefreshCw, Clock, Film, Zap,
} from 'lucide-react';
import { generateImage, editImage, fetchImageHistory, deleteHistoryEntry } from '../services/imageToolsApi';
import { useTheme } from '../contexts/ThemeContext';
import { Sun, Moon } from 'lucide-react';

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
function GenerateTab() {
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const checkRate = useRateLimit();

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
    setOutput(null);
    try {
      const res = await generateImage(prompt.trim());
      setOutput(res.b64Image);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

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
      <AnimatePresence>{loading && <ImageSkeleton label="Generating your image…" />}</AnimatePresence>
      <AnimatePresence>
        {output && !loading && <OutputCard src={output} onClear={() => setOutput(null)} />}
      </AnimatePresence>
    </div>
  );
}

// ── Render profile + intensity options ────────────────────────────────────────
const CINEMATIC_PROFILES = [
  { value: '',                        label: 'Auto-Detect (recommended)' },
  { value: 'CINEMATIC_EDIT',          label: 'Cinematic Edit' },
  { value: 'COLOR_MOOD_EDIT',         label: 'Color & Mood' },
  { value: 'SUBTLE_ENHANCEMENT',      label: 'Subtle Enhancement' },
  { value: 'AGGRESSIVE_RECONSTRUCTION', label: 'Aggressive Reconstruction' },
  { value: 'STYLE_TRANSFER',          label: 'Style Transfer' },
  { value: 'BACKGROUND_TRANSFORMATION', label: 'Background Swap' },
  { value: 'SCREENSHOT_CLEANUP',      label: 'Screenshot Cleanup' },
  { value: 'TEXT_REMOVAL',            label: 'Text Removal' },
  { value: 'WALLPAPER_UPGRADE',       label: 'Wallpaper Upgrade' },
  { value: 'OBJECT_MANIPULATION',     label: 'Object Manipulation' },
];

const INTENSITY_LEVELS = [
  { value: '',        label: 'Auto-Detect' },
  { value: 'LOW',     label: 'Low' },
  { value: 'MEDIUM',  label: 'Medium' },
  { value: 'HIGH',    label: 'High' },
  { value: 'EXTREME', label: 'Extreme' },
];

// ── Edit tab ──────────────────────────────────────────────────────────────────
function EditTab() {
  const [sourceImage, setSourceImage] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState(null);
  const [outputMeta, setOutputMeta] = useState(null); // { mode, intensity }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [cinematicProfile, setCinematicProfile] = useState('');
  const [intensityLevel, setIntensityLevel] = useState('');
  const fileInputRef = useRef(null);
  const checkRate = useRateLimit();

  const EXAMPLES = [
    'Make it look like a watercolor painting',
    'Convert to black and white film noir style',
    'Add dramatic cinematic lighting',
    'Make the background a sunset beach',
    'Remove the watermark',
    'Screenshot cleanup — remove UI elements',
  ];

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
    setLoading(true);
    setError(null);
    setOutput(null);
    setOutputMeta(null);
    try {
      const res = await editImage(
        sourceImage,
        prompt.trim(),
        cinematicProfile || undefined,
        intensityLevel   || undefined,
      );
      setOutput(res.b64Image);
      setOutputMeta({ mode: res.mode ?? null, intensity: res.intensity ?? null });
    } catch (err) {
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

      {/* Edit prompt */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Edit Instruction</label>
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
        {EXAMPLES.map((ex) => (
          <button key={ex} onClick={() => setPrompt(ex)} className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all">{ex}</button>
        ))}
      </div>

      {/* ── Render Profile + Intensity selectors ── */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
            <Film size={9} />
            Render Profile
          </label>
          <select
            value={cinematicProfile}
            onChange={(e) => setCinematicProfile(e.target.value)}
            className="w-full bg-background/60 border border-input rounded-xl px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all cursor-pointer"
          >
            {CINEMATIC_PROFILES.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
            <Zap size={9} />
            Intensity
          </label>
          <select
            value={intensityLevel}
            onChange={(e) => setIntensityLevel(e.target.value)}
            className="w-full bg-background/60 border border-input rounded-xl px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all cursor-pointer"
          >
            {INTENSITY_LEVELS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      <button
        onClick={handleEdit}
        disabled={loading || !sourceImage || !prompt.trim()}
        className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
      >
        {loading ? <><Loader2 size={14} className="animate-spin" />Editing…</> : <><Wand2 size={14} />Edit Image</>}
      </button>

      <AnimatePresence>{error && <ErrorBox message={error} />}</AnimatePresence>
      <AnimatePresence>{loading && <ImageSkeleton label="Applying your edit…" />}</AnimatePresence>

      {/* ── LAYER 8: Before / After viewer ── */}
      <AnimatePresence>
        {output && !loading && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            {/* Mode badge row */}
            {outputMeta?.mode && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">Applied</span>
                <span className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 font-medium">
                  <Film size={10} />
                  {outputMeta.mode}
                </span>
                {outputMeta.intensity && outputMeta.intensity !== 'MEDIUM' && (
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
              </div>
            )}

            {/* Side-by-side comparison */}
            <div className="grid grid-cols-2 gap-3">
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
            <p className="text-xs text-muted-foreground mt-1">Generate or edit an image and it'll appear here.</p>
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
  const [tab, setTab] = useState('generate');
  const { theme, toggleTheme } = useTheme();

  const TABS = [
    { id: 'generate', icon: Sparkles, label: 'Generate' },
    { id: 'edit',     icon: Wand2,    label: 'Edit' },
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
                {tab === 'generate' && <GenerateTab />}
                {tab === 'edit'     && <EditTab />}
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
