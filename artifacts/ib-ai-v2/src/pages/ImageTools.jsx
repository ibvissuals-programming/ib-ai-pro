import { useState, useRef, useCallback, useEffect } from 'react';
import { Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Cpu, ArrowLeft, Upload, ImageIcon,
  Download, X, Loader2, AlertCircle, Sparkles, Copy, Check,
  History, Trash2, RefreshCw, Clock, Film,
  Lightbulb, Eye, Sun, Moon, Palette, Aperture,
} from 'lucide-react';
import { expandPrompt, fetchImageHistory, deleteHistoryEntry, generateCinematicPrompt } from '../services/imageToolsApi';
import { useTheme } from '../contexts/ThemeContext';

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
        <p className="text-xs text-muted-foreground mt-1">This takes a few seconds</p>
      </div>
      <div className="flex gap-2">
        {[40, 64, 48, 56].map((w, i) => (
          <div key={i} className="h-1 rounded-full bg-primary/20 animate-pulse" style={{ width: w, animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </motion.div>
  );
}

// ── Error display ─────────────────────────────────────────────────────────────
function ErrorBox({ message }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl bg-destructive/7 border border-destructive/18 text-destructive/85"
    >
      <AlertCircle size={13} className="shrink-0 mt-0.5 opacity-75" />
      <span className="text-xs leading-relaxed">{message}</span>
    </motion.div>
  );
}

// ── Generate tab — Prompt Generator Mode ──────────────────────────────────────
function GenerateTab({ initialPrompt = '' }) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [expandedPrompt, setExpandedPrompt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const checkRate = useRateLimit();

  const EXAMPLES = [
    'Cinematic sunset over a futuristic cityscape',
    'Studio portrait of a golden retriever in soft light',
    'Abstract digital art with neon geometry',
    'Professional product photo of a glass perfume bottle',
  ];

  const handleExpand = async () => {
    if (loading || !prompt.trim()) return;
    const wait = checkRate();
    if (wait > 0) { setError(`Please wait ${wait}s before trying again.`); return; }
    setLoading(true);
    setError(null);
    setExpandedPrompt(null);
    try {
      const res = await expandPrompt(prompt.trim());
      setExpandedPrompt(res.expanded);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Idea or Subject</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleExpand(); }}
          placeholder="Describe your idea — a few words is enough…"
          rows={3}
          className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all resize-none leading-relaxed"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => setPrompt(ex)}
            className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all"
          >
            {ex.length > 34 ? ex.slice(0, 34) + '…' : ex}
          </button>
        ))}
      </div>

      <button
        onClick={handleExpand}
        disabled={loading || !prompt.trim()}
        className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
      >
        {loading
          ? <><Loader2 size={14} className="animate-spin" />Generating…</>
          : <><Sparkles size={14} />Generate Prompt</>}
      </button>

      <AnimatePresence>{error && <ErrorBox message={error} />}</AnimatePresence>

      <AnimatePresence>
        {loading && (
          <motion.div key="skel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <ImageSkeleton label="Generating your prompt…" />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {expandedPrompt && !loading && (
          <motion.div
            key="prompt-result"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-2xl border border-primary/20 bg-primary/5 p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-primary uppercase tracking-widest flex items-center gap-1.5">
                <Sparkles size={10} />
                Generated Prompt
              </span>
              <div className="flex items-center gap-1">
                <CopyButton text={expandedPrompt} label="Copy" />
                <button
                  onClick={() => setExpandedPrompt(null)}
                  className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
            <p className="text-sm text-foreground leading-relaxed">{expandedPrompt}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Analyse tab ───────────────────────────────────────────────────────────────
function AnalyseTab() {
  const [sourceImage, setSourceImage] = useState(null);
  const [insight, setInsight] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const checkRate = useRateLimit();

  useEffect(() => () => abortRef.current?.abort(), []);

  const readFile = (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setError('Please upload a valid image file (JPG, PNG, WebP).');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError('Image must be under 4 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => { setSourceImage(e.target.result); setInsight(null); setError(null); };
    reader.onerror = () => setError('Failed to read image file.');
    reader.readAsDataURL(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    readFile(e.dataTransfer.files?.[0]);
  };

  const handleAnalyse = async () => {
    if (loading || !sourceImage) return;
    const wait = checkRate();
    if (wait > 0) { setError(`Please wait ${wait}s before analysing again.`); return; }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setInsight(null);
    try {
      const result = await generateCinematicPrompt(sourceImage, controller.signal);
      setInsight(result);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
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
          dragOver
            ? 'border-primary/60 bg-primary/5'
            : sourceImage
            ? 'border-border/40 cursor-default'
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
        {sourceImage ? (
          <div className="relative">
            <img src={sourceImage} alt="Source" className="w-full max-h-64 object-contain bg-black/10" />
            <button
              onClick={(e) => { e.stopPropagation(); setSourceImage(null); setInsight(null); }}
              className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 backdrop-blur text-white hover:bg-black/80 transition-colors"
            >
              <X size={12} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
              className="absolute bottom-2 right-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/60 backdrop-blur text-white text-xs hover:bg-black/80 transition-colors"
            >
              <Upload size={11} />Replace
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center">
              <ImageIcon size={18} className="text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm text-foreground font-medium">Drop an image here</p>
              <p className="text-xs text-muted-foreground mt-0.5">or click to browse — JPG, PNG, WebP up to 4 MB</p>
            </div>
          </div>
        )}
      </div>

      {/* Analyse button — only shown once an image is uploaded */}
      {sourceImage && (
        <button
          onClick={handleAnalyse}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
        >
          {loading
            ? <><Loader2 size={14} className="animate-spin" />Analysing…</>
            : <><Eye size={14} />Analyse Image</>}
        </button>
      )}

      <AnimatePresence>{error && <ErrorBox message={error} />}</AnimatePresence>

      <AnimatePresence>
        {loading && (
          <motion.div key="skel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <ImageSkeleton label="Analysing your image…" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Structured insight results */}
      <AnimatePresence>
        {insight && !loading && (
          <motion.div
            key="insight"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-2.5"
          >
            {/* Scene + Composition */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="rounded-xl bg-background/60 border border-border/40 px-3 py-2.5 space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Eye size={9} />Scene
                </div>
                <p className="text-[11px] text-foreground leading-relaxed">{insight.sceneDescription}</p>
              </div>
              <div className="rounded-xl bg-background/60 border border-border/40 px-3 py-2.5 space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Aperture size={9} />Composition
                </div>
                <p className="text-[11px] text-foreground leading-relaxed">{insight.compositionType}</p>
              </div>
            </div>

            {/* Lighting */}
            <div className="rounded-xl bg-background/60 border border-border/40 px-3 py-2.5 space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <Sun size={9} />Lighting
              </div>
              <p className="text-[11px] text-foreground leading-relaxed">{insight.lightingConditions}</p>
              {insight.lightingDirection && (
                <p className="text-[11px] text-muted-foreground leading-relaxed mt-1 pt-1 border-t border-border/30">
                  <span className="font-medium text-foreground/70">Direction: </span>{insight.lightingDirection}
                </p>
              )}
            </div>

            {/* Color Grade + Mood */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="rounded-xl bg-background/60 border border-border/40 px-3 py-2.5 space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Palette size={9} />Color Grade
                </div>
                <p className="text-[11px] text-foreground leading-relaxed">{insight.colorTone}</p>
                {insight.colorGrade && (
                  <p className="text-[11px] text-muted-foreground leading-relaxed mt-1 pt-1 border-t border-border/30">{insight.colorGrade}</p>
                )}
              </div>
              <div className="rounded-xl bg-background/60 border border-border/40 px-3 py-2.5 space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Lightbulb size={9} />Mood &amp; Style
                </div>
                <p className="text-[11px] text-foreground leading-relaxed">{insight.mood}</p>
                {insight.moodTarget && (
                  <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400 border border-violet-400/20 font-medium capitalize">
                    → {insight.moodTarget}
                  </span>
                )}
              </div>
            </div>

            {/* Cinematic prompt — primary copyable output */}
            <div className="rounded-xl bg-primary/5 border border-primary/20 px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-primary uppercase tracking-wider">
                  <Film size={9} />Cinematic Prompt
                </div>
                <CopyButton text={insight.cinematicEditPrompt} label="Copy" />
              </div>
              <p className="text-[11px] text-foreground leading-relaxed">{insight.cinematicEditPrompt}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {insight && !loading && <EnhancementPlanPanel insight={insight} />}
    </div>
  );
}

// ── Enhancement plan builder functions ────────────────────────────────────────

function buildAIPrompt(insight) {
  return [
    insight.cinematicEditPrompt,
    insight.lightingDirection && `Relighting: ${insight.lightingDirection}`,
    insight.colorGrade        && `Color science: ${insight.colorGrade}`,
    insight.exposureGuidance  && `Exposure: ${insight.exposureGuidance}`,
    insight.moodTarget        && `Target mood: ${insight.moodTarget}.`,
  ].filter(Boolean).join(' ');
}

function buildLightroomGuide(insight) {
  const mood  = (insight.moodTarget || 'cinematic').toLowerCase();
  const warm  = ['golden', 'warm', 'vibrant', 'intimate'].some((m) => mood.includes(m));
  const cool  = ['cinematic', 'dark', 'moody', 'dramatic'].some((m) => mood.includes(m));
  const wbDir = warm
    ? 'Shift White Balance toward amber (+500 to +800K).'
    : cool
    ? 'Shift White Balance toward blue (−300 to −500K).'
    : 'Keep White Balance as-shot; adjust by feel.';

  return [
    'LIGHTROOM EDIT GUIDE',
    `Scene: ${insight.sceneDescription || ''}`,
    `Target mood: ${(insight.moodTarget || 'cinematic').toUpperCase()}`,
    '',
    '─ LIGHT PANEL ──────────────────────────────────────',
    insight.exposureGuidance || '',
    '',
    '─ COLOR PANEL ──────────────────────────────────────',
    `White balance: ${wbDir}`,
    `Current palette: ${insight.colorTone || ''}`,
    insight.colorGrade || '',
    '',
    '─ TONE CURVE ───────────────────────────────────────',
    `Apply an S-curve: pull shadows down ~10 pts, push highlights up ~10 pts.`,
    `This reinforces the ${insight.moodTarget || 'cinematic'} contrast direction.`,
    '',
    '─ EFFECTS ──────────────────────────────────────────',
    'Vignette: Amount −20 to −30, Feather 80%. Draws focus to subject.',
    'Clarity: +15–25 for landscape/architecture; +5–10 for portraits.',
    '',
    '─ LIGHTING NOTE ────────────────────────────────────',
    insight.lightingDirection || '',
  ].join('\n');
}

function buildPhotoshopGuide(insight) {
  const mood       = (insight.moodTarget || 'cinematic').toLowerCase();
  const warmMoods  = ['golden', 'warm', 'vibrant'];
  const coolMoods  = ['cinematic', 'dark', 'moody', 'dramatic'];
  const hlShift    = warmMoods.some((m) => mood.includes(m))
    ? 'Push highlights toward amber: Cyan −5, Yellow +8, Red +3 (Highlights).'
    : coolMoods.some((m) => mood.includes(m))
    ? 'Push highlights toward cool blue: Cyan +5, Yellow −8, Blue +3 (Highlights).'
    : 'Keep highlights neutral; adjust Whites +5 for clean separation.';
  const shShift    = coolMoods.some((m) => mood.includes(m))
    ? 'Teal shadows: Cyan +8, Blue +5, Red −3 (Shadows).'
    : 'Warm shadows: Red +3, Yellow +3 (Shadows). Avoid crushing blacks.';

  return [
    'PHOTOSHOP EDIT GUIDE',
    `Scene: ${insight.sceneDescription || ''}`,
    `Current lighting: ${insight.lightingConditions || ''}`,
    `Target: ${(insight.moodTarget || 'cinematic').toUpperCase()} mood`,
    '',
    '─ STEP 1 — CURVES ──────────────────────────────────',
    'Apply an S-curve: anchor centre, pull ¼ shadows down ~10 pts, push ¾ highlights up ~10 pts.',
    insight.exposureGuidance || '',
    '',
    '─ STEP 2 — COLOR BALANCE (HIGHLIGHTS) ──────────────',
    hlShift,
    '',
    '─ STEP 3 — COLOR BALANCE (SHADOWS) ─────────────────',
    shShift,
    '',
    '─ STEP 4 — HUE / SATURATION ─────────────────────────',
    `Palette reference: ${insight.colorTone || ''}`,
    'Overall: Vibrance +20, Saturation −5 (avoids oversaturation).',
    'If faces present: Reds Saturation −8, Reds Luminance +5 (skin protection).',
    '',
    '─ STEP 5 — SELECTIVE COLOR ──────────────────────────',
    insight.colorGrade || '',
    '',
    '─ STEP 6 — RELIGHTING DIRECTION ─────────────────────',
    insight.lightingDirection || '',
    '',
    '─ FINISHING ─────────────────────────────────────────',
    `Composition: ${insight.compositionType || ''}`,
    `Mood directive: ${insight.mood || ''}`,
    'Smart Sharpen: Amount 80%, Radius 1.0px, Reduce Noise 10%.',
  ].join('\n');
}

// ── EnhancementPlanPanel ──────────────────────────────────────────────────────
function EnhancementPlanPanel({ insight }) {
  const [active, setActive] = useState(null);
  const [copied, setCopied] = useState(null);

  const exports = [
    {
      id: 'ai',
      label: 'AI Prompt',
      icon: Sparkles,
      desc: 'For any AI image tool',
      content: buildAIPrompt(insight),
    },
    {
      id: 'lr',
      label: 'Lightroom Guide',
      icon: Sun,
      desc: 'Panel-by-panel adjustments',
      content: buildLightroomGuide(insight),
    },
    {
      id: 'ps',
      label: 'Photoshop Guide',
      icon: Palette,
      desc: 'Layer-by-layer workflow',
      content: buildPhotoshopGuide(insight),
    },
  ];

  const handleCopy = (id, text) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-3 pt-1"
    >
      <div className="border-t border-border/30 pt-3 space-y-3">
        <div className="flex items-center gap-1.5">
          <Lightbulb size={11} className="text-primary" />
          <span className="text-[11px] font-semibold text-foreground uppercase tracking-widest">Enhancement Plan</span>
          <span className="ml-1 text-[10px] text-muted-foreground">· AI Creative Director output</span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {exports.map((exp) => {
            const Icon  = exp.icon;
            const isOn  = active === exp.id;
            return (
              <button
                key={exp.id}
                onClick={() => setActive(isOn ? null : exp.id)}
                className={`flex flex-col items-start gap-1.5 px-2.5 py-2.5 rounded-xl border text-left transition-all ${
                  isOn
                    ? 'border-primary/50 bg-primary/8 text-foreground'
                    : 'border-border/40 bg-background/40 text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-primary/5'
                }`}
              >
                <Icon size={12} className={isOn ? 'text-primary' : ''} />
                <span className="text-[11px] font-medium leading-tight">{exp.label}</span>
                <span className="text-[10px] opacity-60 leading-tight">{exp.desc}</span>
              </button>
            );
          })}
        </div>

        <AnimatePresence mode="wait">
          {active && (() => {
            const exp = exports.find((e) => e.id === active);
            return (
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                className="rounded-xl border border-border/40 bg-background/60 overflow-hidden"
              >
                <div className="flex items-center justify-between px-3 py-2 border-b border-border/30 bg-secondary/30">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    {exp.label}
                  </span>
                  <button
                    onClick={() => handleCopy(exp.id, exp.content)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-[11px] font-medium"
                  >
                    {copied === exp.id
                      ? <><Check size={10} />Copied</>
                      : <><Copy size={10} />Copy all</>}
                  </button>
                </div>
                <pre className="text-[11px] text-foreground/85 leading-relaxed whitespace-pre-wrap font-mono px-3 py-3 max-h-72 overflow-y-auto">
                  {exp.content}
                </pre>
              </motion.div>
            );
          })()}
        </AnimatePresence>
      </div>
    </motion.div>
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
                <button onClick={() => setLightboxSrc(entry.imageUrl)} className="block w-full">
                  <img
                    src={entry.imageUrl}
                    alt={entry.prompt}
                    className="w-full object-cover aspect-square bg-secondary/30"
                    loading="lazy"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                </button>

                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

                <div className="absolute bottom-0 left-0 right-0 p-2 translate-y-1 group-hover:translate-y-0 opacity-0 group-hover:opacity-100 transition-all duration-200">
                  <p className="text-[10px] text-white/90 leading-snug line-clamp-2 font-medium">{entry.prompt}</p>
                </div>

                <div className="absolute top-1.5 left-1.5 flex gap-1">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold backdrop-blur ${
                    entry.type === 'generate' ? 'bg-purple-600/70 text-white' : 'bg-blue-600/70 text-white'
                  }`}>
                    {entry.type === 'generate' ? 'GEN' : 'EDIT'}
                  </span>
                </div>

                <div className="absolute top-1.5 right-8 flex items-center gap-1">
                  <span className="text-[9px] text-white/70 backdrop-blur bg-black/40 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                    <Clock size={8} />
                    {formatTime(entry.timestamp)}
                  </span>
                </div>

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
                  <X size={12} />
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
  const [tab, setTab] = useState('generate');

  const TABS = [
    { id: 'generate', icon: Sparkles, label: 'Generate' },
    { id: 'analyse',  icon: Eye,      label: 'Analyse' },
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
          <span className="text-[11px] px-2.5 py-1 rounded-full border border-border/50 text-muted-foreground hidden sm:block">Powered by Gemini</span>
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
              Generate professional image prompts, analyse your photos, or browse your history.
            </p>
          </div>

          {/* Mode tabs */}
          <div className="flex gap-0.5 p-1 rounded-xl bg-secondary/30 border border-border/35 w-fit">
            {TABS.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                  tab === id
                    ? 'bg-background/90 text-foreground shadow-md ring-1 ring-white/6'
                    : 'text-muted-foreground hover:text-foreground/80 hover:bg-secondary/40'
                }`}
              >
                <Icon size={13} className={tab === id ? 'text-primary' : ''} />
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
                {tab === 'analyse'  && <AnalyseTab />}
                {tab === 'history'  && <HistoryTab />}
              </motion.div>
            </AnimatePresence>
          </div>

          <p className="text-center text-xs text-muted-foreground/50">
            AI Image Studio · Prompt generation and image analysis powered by Gemini
          </p>
        </div>
      </main>
    </div>
  );
}
