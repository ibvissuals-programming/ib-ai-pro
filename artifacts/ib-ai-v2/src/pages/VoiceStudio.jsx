/**
 * VoiceStudio.jsx — IB AI Assistant
 *
 * Text-to-speech studio. Lets users type text, pick a voice style,
 * generate WAV audio, play it inline, and download it.
 *
 * History: persistent — loaded from /api/tts/history on mount.
 * Presets: 5 creator workflow presets (text + voice combos).
 */
import { useState, useRef, useEffect } from 'react';
import { Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Mic, Play, Pause, Download, Loader2,
  AlertCircle, Volume2, Square, Sun, Moon, RefreshCw,
  Sparkles, History, Clock, Layers,
} from 'lucide-react';
import { generateSpeech, getAudioUrl } from '../services/ttsApi';
import { fetchTtsHistory } from '../services/historyApi';
import { useTheme } from '../contexts/ThemeContext';
import { WorkflowLauncher } from '../components/WorkflowLauncher';

// ── Voice definitions ─────────────────────────────────────────────────────────
const VOICES = [
  {
    id:          'neutral_assistant',
    label:       'Neutral Assistant',
    description: 'Clear, professional, neutral voice',
    emoji:       '🎙️',
    color:       'text-sky-400',
    bg:          'bg-sky-500/10 border-sky-500/25',
    activeBg:    'bg-sky-500/20 border-sky-400/50',
  },
  {
    id:          'cinematic_narration',
    label:       'Cinematic Narration',
    description: 'Deep, gravelly, dramatic narrator voice',
    emoji:       '🎬',
    color:       'text-violet-400',
    bg:          'bg-violet-500/10 border-violet-500/25',
    activeBg:    'bg-violet-500/20 border-violet-400/50',
  },
  {
    id:          'female_soft',
    label:       'Female Soft',
    description: 'Warm, gentle, expressive female voice',
    emoji:       '🌸',
    color:       'text-rose-400',
    bg:          'bg-rose-500/10 border-rose-500/25',
    activeBg:    'bg-rose-500/20 border-rose-400/50',
  },
  {
    id:          'male_deep',
    label:       'Male Deep',
    description: 'Strong, authoritative deep male voice',
    emoji:       '⚡',
    color:       'text-amber-400',
    bg:          'bg-amber-500/10 border-amber-500/25',
    activeBg:    'bg-amber-500/20 border-amber-400/50',
  },
  {
    id:          'energetic_social',
    label:       'Energetic Social',
    description: 'Upbeat, expressive, high-energy voice',
    emoji:       '🔥',
    color:       'text-orange-400',
    bg:          'bg-orange-500/10 border-orange-500/25',
    activeBg:    'bg-orange-500/20 border-orange-400/50',
  },
];

const MAX_CHARS = 1000;

// ── Quick text examples ───────────────────────────────────────────────────────
const EXAMPLES = [
  'Welcome to IB AI Studio, where creativity meets artificial intelligence.',
  'In the beginning, there was silence — and then, the word.',
  'Breaking news: scientists have discovered a new form of light that bends time.',
  'Thank you for joining us today. Your journey to mastery starts right now.',
];

// ── Creator presets ───────────────────────────────────────────────────────────
const VOICE_PRESETS = [
  {
    id:         'narration',
    label:      'Documentary',
    emoji:      '🎙️',
    voiceStyle: 'cinematic_narration',
    text:       'In the vast expanse of human creativity, some ideas transcend time. This is the story of one such vision — a moment where technology and artistry converge to create something extraordinary.',
  },
  {
    id:         'trailer',
    label:      'Movie Trailer',
    emoji:      '🎬',
    voiceStyle: 'cinematic_narration',
    text:       'In a world where boundaries are challenged every day — one platform dares to redefine what\'s possible. IB AI Studio. The future of creation is here.',
  },
  {
    id:         'soft_story',
    label:      'Soft Story',
    emoji:      '🌸',
    voiceStyle: 'female_soft',
    text:       'Sometimes the most powerful stories are told in a whisper. Close your eyes, and let this moment carry you somewhere you\'ve never been before. This is your story.',
  },
  {
    id:         'energetic',
    label:      'Energetic Promo',
    emoji:      '⚡',
    voiceStyle: 'energetic_social',
    text:       'Are you ready to level up? Introducing the most powerful AI creative studio you\'ve ever experienced. No limits. No boundaries. Just pure creative power — starting right now.',
  },
  {
    id:         'professional',
    label:      'Professional Brief',
    emoji:      '💼',
    voiceStyle: 'neutral_assistant',
    text:       'Welcome to our quarterly overview. Today we\'ll walk through our key results, strategic initiatives, and the roadmap that positions us for continued growth in the months ahead.',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000)  return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Audio player ──────────────────────────────────────────────────────────────
function AudioPlayer({ audioUrl, voiceLabel, onDownload }) {
  const audioRef   = useRef(null);
  const [playing, setPlaying]     = useState(false);
  const [progress, setProgress]   = useState(0);
  const [duration, setDuration]   = useState(0);
  const [currentTime, setCurrent] = useState(0);
  const [loaded, setLoaded]       = useState(false);

  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    setCurrent(0);
    setDuration(0);
    setLoaded(false);
  }, [audioUrl]);

  const fmt = (s) => {
    if (!s || !isFinite(s)) return '0:00';
    const m   = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const handlePlayPause = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { el.play().then(() => setPlaying(true)).catch(() => {}); }
  };

  const handleSeek = (e) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect  = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setProgress(ratio * 100);
    setCurrent(el.currentTime);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-border/60 glass-card p-4 space-y-3"
    >
      <audio
        ref={audioRef}
        src={audioUrl}
        onLoadedMetadata={(e) => { setDuration(e.target.duration); setLoaded(true); }}
        onTimeUpdate={(e) => {
          const el = e.target;
          setCurrent(el.currentTime);
          setProgress(duration ? (el.currentTime / duration) * 100 : 0);
        }}
        onEnded={() => { setPlaying(false); setProgress(0); setCurrent(0); if (audioRef.current) audioRef.current.currentTime = 0; }}
        preload="metadata"
      />
      <div className="flex items-center gap-2">
        <Volume2 size={13} className="text-primary shrink-0" />
        <span className="text-xs font-semibold text-foreground">{voiceLabel}</span>
        {!loaded && <span className="text-[10px] text-muted-foreground">Loading…</span>}
      </div>
      <div
        className="relative h-1.5 rounded-full bg-secondary cursor-pointer group"
        onClick={handleSeek}
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-primary shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ left: `calc(${progress}% - 6px)` }}
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={handlePlayPause}
            disabled={!loaded}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-primary/25"
          >
            {playing ? <Pause size={14} /> : <Play size={14} className="translate-x-0.5" />}
          </button>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {fmt(currentTime)} / {fmt(duration)}
          </span>
        </div>
        <button
          onClick={onDownload}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-all border border-transparent hover:border-border/40"
        >
          <Download size={12} />
          Download
        </button>
      </div>
    </motion.div>
  );
}

// ── Compact history entry (for history list) ──────────────────────────────────
function HistoryEntry({ entry, onReplay }) {
  const voice = VOICES.find(v => v.id === entry.voiceStyle) ?? VOICES[0];
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-secondary/50 transition-colors cursor-pointer group"
      onClick={() => onReplay(entry)}
    >
      <span className="text-base shrink-0 mt-0.5">{voice.emoji}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground/80 leading-relaxed line-clamp-2">{entry.text}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <p className="text-[10px] text-muted-foreground">{voice.label}</p>
          {entry.timestamp && (
            <span className="text-[10px] text-muted-foreground/50">· {formatRelative(entry.timestamp)}</span>
          )}
        </div>
      </div>
      <button className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-1 rounded-lg hover:bg-secondary">
        <Play size={11} className="text-primary" />
      </button>
    </motion.div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function VoiceStudio() {
  const { theme, toggleTheme } = useTheme();
  const [text, setText]               = useState('');
  const [selectedVoice, setVoice]     = useState('neutral_assistant');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [result, setResult]           = useState(null);
  const [history, setHistory]         = useState([]);
  const [historyLoading, setHLoad]    = useState(true);

  const remaining  = MAX_CHARS - text.length;
  const nearLimit  = remaining <= 100;
  const overLimit  = remaining < 0;
  const activeVoice = VOICES.find(v => v.id === selectedVoice) ?? VOICES[0];

  // ── Restore from URL params on mount (WorkflowLauncher session restore) ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlText  = params.get('prompt');
    const urlVoice = params.get('voice');
    if (urlText) setText(urlText);
    if (urlVoice && VOICES.some(v => v.id === urlVoice)) setVoice(urlVoice);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load persistent history on mount ─────────────────────────────────────
  useEffect(() => {
    fetchTtsHistory()
      .then(setHistory)
      .catch(() => {})
      .finally(() => setHLoad(false));
  }, []);

  const handleGenerate = async () => {
    if (loading || !text.trim() || overLimit) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data      = await generateSpeech(text.trim(), selectedVoice);
      const jobId     = data.jobId ?? data.data?.jobId;
      const audioUrl  = jobId ? getAudioUrl(jobId) : null;
      const voiceLabel = activeVoice.label;

      const entry = { text: text.trim(), voiceStyle: selectedVoice, voiceLabel, jobId, audioUrl, timestamp: Date.now() };
      setResult(entry);

      // Optimistically prepend to local history, then refresh from backend
      setHistory(h => [entry, ...h].slice(0, 20));
      setTimeout(() => {
        fetchTtsHistory().then(setHistory).catch(() => {});
      }, 1_500);
    } catch (err) {
      // Differentiate error types for better UX
      const msg = err.message ?? '';
      if (msg.includes('FEATURE_DISABLED') || msg.includes('501')) {
        setError('Text-to-speech is not available in this environment.');
      } else if (msg.includes('429') || msg.includes('rate')) {
        setError('You\'ve reached the rate limit. Please wait a moment before generating again.');
      } else if (msg.includes('402') || msg.includes('credit')) {
        setError('Insufficient credits for TTS generation.');
      } else if (msg.includes('503') || msg.includes('network')) {
        setError('The voice service is temporarily unavailable. Please try again in a few seconds.');
      } else {
        setError(msg || 'Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (!result?.audioUrl) return;
    const a = document.createElement('a');
    a.href     = result.audioUrl;
    a.download = `ib-voice-${result.jobId ?? Date.now()}.wav`;
    a.click();
  };

  const handleDownloadEntry = (entry) => {
    if (!entry?.audioUrl) return;
    const a = document.createElement('a');
    a.href     = entry.audioUrl;
    a.download = `ib-voice-${entry.jobId ?? Date.now()}.wav`;
    a.click();
  };

  const handleReplay = (entry) => setResult(entry);

  const applyPreset = (preset) => {
    setText(preset.text);
    setVoice(preset.voiceStyle);
  };

  const historyToShow = result ? history.filter(e => e.jobId !== result.jobId) : history;

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
              <Mic size={11} className="text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground tracking-tight">Voice Studio</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] px-2.5 py-1 rounded-full border border-border/50 text-muted-foreground hidden sm:block">
            Powered by Gemini
          </span>
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
            <h1 className="text-xl font-bold text-foreground tracking-tight">AI Voice Studio</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Type any text, choose a voice style, and generate studio-quality speech.
            </p>
          </div>

          {/* Creator Presets */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Sparkles size={11} className="text-primary" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Creator Presets</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {VOICE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset)}
                  disabled={loading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border/60 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span>{preset.emoji}</span>
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="glass-card p-6 rounded-2xl space-y-5">
            {/* Text input */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                  Text
                </label>
                <span className={`text-[11px] tabular-nums ${overLimit ? 'text-destructive' : nearLimit ? 'text-amber-400' : 'text-muted-foreground'}`}>
                  {remaining} characters remaining
                </span>
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
                placeholder="Enter the text you want to convert to speech…"
                rows={5}
                className="w-full bg-background/60 border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all resize-none leading-relaxed"
              />
              {/* Quick example chips */}
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => setText(ex)}
                    className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-all"
                  >
                    {ex.length > 38 ? ex.slice(0, 38) + '…' : ex}
                  </button>
                ))}
              </div>
            </div>

            {/* Voice picker */}
            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                Voice Style
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {VOICES.map((voice) => {
                  const active = selectedVoice === voice.id;
                  return (
                    <button
                      key={voice.id}
                      onClick={() => setVoice(voice.id)}
                      className={`flex items-center gap-3 px-3.5 py-3 rounded-xl border text-left transition-all ${
                        active ? `${voice.activeBg} shadow-sm` : `${voice.bg} hover:opacity-90`
                      }`}
                    >
                      <span className="text-xl shrink-0">{voice.emoji}</span>
                      <div className="min-w-0">
                        <p className={`text-xs font-semibold ${active ? voice.color : 'text-foreground/80'}`}>
                          {voice.label}
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-tight mt-0.5 line-clamp-1">
                          {voice.description}
                        </p>
                      </div>
                      {active && (
                        <div className={`ml-auto w-2 h-2 rounded-full ${voice.color.replace('text-', 'bg-')} shrink-0`} />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Generate button */}
            <div className="space-y-1.5">
              <button
                onClick={handleGenerate}
                disabled={loading || !text.trim() || overLimit}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
              >
                {loading
                  ? <><Loader2 size={14} className="animate-spin" />Generating speech…</>
                  : <><Mic size={14} />Generate Speech</>
                }
              </button>
              <p className="text-[11px] text-muted-foreground">
                {activeVoice.emoji} {activeVoice.label}
                {' · Takes 5–15 seconds · 1 credit'}
              </p>
            </div>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-destructive/10 border border-destructive/25 text-destructive text-sm"
                >
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{error}</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Loading skeleton */}
            <AnimatePresence>
              {loading && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center justify-center py-10 gap-4 rounded-2xl border border-dashed border-border/50 bg-secondary/20"
                >
                  <div className="relative w-14 h-14">
                    <div className="absolute inset-0 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
                    <div className="absolute inset-2 rounded-full border border-primary/10 border-t-primary/40 animate-spin" style={{ animationDuration: '1.5s', animationDirection: 'reverse' }} />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Mic size={14} className="text-primary/60" />
                    </div>
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">Synthesizing voice…</p>
                    <p className="text-xs text-muted-foreground mt-1">Using {activeVoice.label} · Takes 5–15 seconds</p>
                  </div>
                  <div className="flex gap-1.5">
                    {[32, 48, 40, 56, 36, 44].map((w, i) => (
                      <div key={i} className="h-1 rounded-full bg-primary/20 animate-pulse" style={{ width: w, animationDelay: `${i * 0.1}s` }} />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Audio player */}
            <AnimatePresence>
              {result && !loading && (
                <AudioPlayer
                  audioUrl={result.audioUrl}
                  voiceLabel={result.voiceLabel ?? result.voiceStyle}
                  onDownload={handleDownload}
                />
              )}
            </AnimatePresence>
          </div>

          {/* Persistent history */}
          <AnimatePresence>
            {(historyLoading || historyToShow.length > 0) && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-card rounded-2xl overflow-hidden"
              >
                <div className="px-5 py-3 border-b border-border/40 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <History size={12} className="text-muted-foreground" />
                    <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
                      Voice History
                    </h2>
                  </div>
                  {historyLoading && <RefreshCw size={10} className="text-muted-foreground animate-spin" />}
                  {!historyLoading && historyToShow.length > 0 && (
                    <span className="text-[10px] text-muted-foreground/60">{historyToShow.length} generations</span>
                  )}
                </div>

                {historyLoading ? (
                  <div className="p-4 space-y-2">
                    {[1, 2].map(i => (
                      <div key={i} className="h-10 rounded-lg bg-secondary/30 animate-pulse" />
                    ))}
                  </div>
                ) : historyToShow.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-8 px-4">
                    <Mic size={20} className="text-muted-foreground/30" />
                    <p className="text-xs text-muted-foreground/60">No previous generations yet</p>
                  </div>
                ) : (
                  <div className="p-2 space-y-0.5">
                    {historyToShow.map((entry, i) => (
                      <HistoryEntry
                        key={entry.jobId ?? entry.timestamp ?? i}
                        entry={entry}
                        onReplay={handleReplay}
                      />
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <p className="text-center text-xs text-muted-foreground/50">
            Speech generated via Gemini AI · WAV output · 1 credit per generation
          </p>
        </div>
      </main>
    </div>
  );
}
