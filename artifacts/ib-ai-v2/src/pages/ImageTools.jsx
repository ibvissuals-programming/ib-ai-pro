import { useState, useRef, useCallback } from 'react';
import { Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Cpu, ArrowLeft, Wand2, Upload, ImageIcon,
  Download, X, Loader2, AlertCircle, Sparkles,
} from 'lucide-react';
import { generateImage, editImage } from '../services/imageToolsApi';
import { useTheme } from '../contexts/ThemeContext';

// ── Rate limit guard (client-side, mirrors server) ────────────────────────────
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

// ── Image output card ──────────────────────────────────────────────────────────

function OutputCard({ src, onClear }) {
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
      <img
        src={src}
        alt="Generated"
        className="w-full object-contain max-h-[520px] bg-black/20"
      />
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

// ── Error display ──────────────────────────────────────────────────────────────

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

// ── Generate tab ───────────────────────────────────────────────────────────────

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
    if (wait > 0) {
      setError(`Please wait ${wait}s before generating again.`);
      return;
    }
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
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
          Prompt
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate();
          }}
          placeholder="Describe the image you want to generate…"
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
        onClick={handleGenerate}
        disabled={loading || !prompt.trim()}
        className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
      >
        {loading ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Generating…
          </>
        ) : (
          <>
            <Sparkles size={14} />
            Generate Image
          </>
        )}
      </button>

      <AnimatePresence>
        {error && <ErrorBox message={error} />}
      </AnimatePresence>

      {loading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center py-16 gap-3 rounded-2xl border border-dashed border-border/50 bg-secondary/20"
        >
          <Loader2 size={28} className="animate-spin text-primary/60" />
          <p className="text-sm text-muted-foreground">
            Generating your image — this takes 10–30 seconds…
          </p>
        </motion.div>
      )}

      <AnimatePresence>
        {output && !loading && (
          <OutputCard src={output} onClear={() => setOutput(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Edit tab ──────────────────────────────────────────────────────────────────

function EditTab() {
  const [sourceImage, setSourceImage] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const checkRate = useRateLimit();

  const EXAMPLES = [
    'Make it look like a watercolor painting',
    'Convert to black and white film noir style',
    'Add dramatic cinematic lighting',
    'Make the background a sunset beach',
  ];

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
    reader.onload = (e) => {
      setSourceImage(e.target.result);
      setOutput(null);
      setError(null);
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  };

  const handleEdit = async () => {
    if (loading || !sourceImage || !prompt.trim()) return;
    const wait = checkRate();
    if (wait > 0) {
      setError(`Please wait ${wait}s before editing again.`);
      return;
    }
    setLoading(true);
    setError(null);
    setOutput(null);
    try {
      const res = await editImage(sourceImage, prompt.trim());
      setOutput(res.b64Image);
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
            <img
              src={sourceImage}
              alt="Source"
              className="w-full max-h-64 object-contain bg-black/10"
            />
            <button
              onClick={(e) => { e.stopPropagation(); setSourceImage(null); setOutput(null); }}
              className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 backdrop-blur text-white hover:bg-black/80 transition-colors"
            >
              <X size={12} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
              className="absolute bottom-2 right-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/60 backdrop-blur text-white text-xs hover:bg-black/80 transition-colors"
            >
              <Upload size={11} />
              Replace
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

      {/* Edit prompt */}
      <div className="space-y-2">
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
          Edit Instruction
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleEdit();
          }}
          placeholder="Describe how to edit the image…"
          rows={2}
          className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all resize-none"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => setPrompt(ex)}
            className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all"
          >
            {ex}
          </button>
        ))}
      </div>

      <button
        onClick={handleEdit}
        disabled={loading || !sourceImage || !prompt.trim()}
        className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
      >
        {loading ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Editing…
          </>
        ) : (
          <>
            <Wand2 size={14} />
            Edit Image
          </>
        )}
      </button>

      <AnimatePresence>
        {error && <ErrorBox message={error} />}
      </AnimatePresence>

      {loading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center py-16 gap-3 rounded-2xl border border-dashed border-border/50 bg-secondary/20"
        >
          <Loader2 size={28} className="animate-spin text-primary/60" />
          <p className="text-sm text-muted-foreground">
            Editing your image — this takes 15–30 seconds…
          </p>
        </motion.div>
      )}

      <AnimatePresence>
        {output && !loading && (
          <OutputCard src={output} onClear={() => setOutput(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ImageTools() {
  const [tab, setTab] = useState('generate');
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header
        className="flex items-center justify-between px-4 py-3 border-b border-border/50 glass-panel sticky top-0 z-10"
        style={{ borderRadius: 0 }}
      >
        <div className="flex items-center gap-3">
          <Link
            to="/chat"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded-lg hover:bg-secondary"
          >
            <ArrowLeft size={13} />
            <span className="hidden sm:block">Back to Chat</span>
          </Link>

          <div className="w-px h-4 bg-border/50" />

          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-primary flex items-center justify-center">
              <Cpu size={11} className="text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground tracking-tight">
              AI Image Tools
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] px-2.5 py-1 rounded-full border border-border/50 text-muted-foreground hidden sm:block">
            Powered by HuggingFace
          </span>
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors text-xs"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 flex justify-center px-4 py-8">
        <div className="w-full max-w-2xl space-y-6">
          {/* Title */}
          <div>
            <h1 className="text-xl font-bold text-foreground tracking-tight">
              AI Image Tools
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Generate new images or edit existing ones using free AI models.
            </p>
          </div>

          {/* HF key notice */}
          <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-primary/8 border border-primary/20 text-xs text-primary/80 leading-relaxed">
            <Sparkles size={13} className="shrink-0 mt-0.5" />
            <span>
              Requires a free{' '}
              <a
                href="https://huggingface.co/settings/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-primary"
              >
                HuggingFace token
              </a>{' '}
              added to Replit Secrets as{' '}
              <code className="bg-primary/10 px-1 py-0.5 rounded text-[11px]">
                HUGGINGFACE_API_KEY
              </code>
              . Creating an account and token is free.
            </span>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 p-1 rounded-xl bg-secondary/40 border border-border/40 w-fit">
            {[
              { id: 'generate', icon: Sparkles, label: 'Generate' },
              { id: 'edit', icon: Wand2, label: 'Edit' },
            ].map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  tab === id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
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
                {tab === 'generate' ? <GenerateTab /> : <EditTab />}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Footer note */}
          <p className="text-center text-xs text-muted-foreground/50">
            Images are generated by open-source models via HuggingFace. Generation
            takes 10–30 seconds on the free tier.
          </p>
        </div>
      </main>
    </div>
  );
}
