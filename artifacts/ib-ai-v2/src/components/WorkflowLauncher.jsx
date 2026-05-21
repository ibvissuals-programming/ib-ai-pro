/**
 * WorkflowLauncher.jsx — Quick Workflow Launcher
 *
 * Slide-out panel showing:
 *   - Creator preset templates (6 categories)
 *   - User's saved sessions (pinned first, then recent)
 *   - One-click launch → navigates to the right studio with config applied via URL params
 *   - Export workflow as JSON
 *
 * Mobile-first, AnimatePresence-compliant, no layout shift.
 */
import { useState, useEffect, useCallback, memo } from 'react';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Plus, Pin, PinOff, Trash2, Copy, Download,
  ImageIcon, Mic, Video, MessageSquare,
  Zap, Sparkles, ChevronDown, ChevronRight,
  RefreshCw, AlertCircle, Layers, Clock, History, TrendingUp,
} from 'lucide-react';
import {
  listCreatorSessions,
  createCreatorSession,
  updateCreatorSession,
  duplicateCreatorSession,
  deleteCreatorSession,
} from '../services/creatorSessionsApi';

// ── Preset templates ──────────────────────────────────────────────────────────

const WORKFLOW_PRESETS = [
  {
    id:       'luxury_portrait',
    name:     'Luxury Portrait Pipeline',
    category: 'Luxury',
    emoji:    '💎',
    color:    'text-amber-400',
    bg:       'bg-amber-500/10 border-amber-400/20',
    config:   { tool: 'image', editMode: 'luxury', intensity: 'MEDIUM', prompt: 'Luxury editorial color grade, soft highlights, premium campaign quality' },
    description: 'Premium identity-safe portrait editing with luxury color grade',
  },
  {
    id:       'tiktok_voiceover',
    name:     'TikTok Voiceover Setup',
    category: 'Social',
    emoji:    '📱',
    color:    'text-cyan-400',
    bg:       'bg-cyan-500/10 border-cyan-400/20',
    config:   { tool: 'voice', voiceStyle: 'energetic_social', prompt: 'High-energy engaging intro for social media content' },
    description: 'High-energy social voice optimized for short-form video',
  },
  {
    id:       'cinematic_product',
    name:     'Cinematic Product Ads',
    category: 'Product Ads',
    emoji:    '🎬',
    color:    'text-violet-400',
    bg:       'bg-violet-500/10 border-violet-400/20',
    config:   { tool: 'image', editMode: 'cinematic', intensity: 'HIGH', prompt: 'Cinematic product advertisement, dramatic lighting, premium brand aesthetic' },
    description: 'Filmic product photography with atmospheric depth',
  },
  {
    id:       'afro_futuristic_reel',
    name:     'Afro-Futuristic Reel',
    category: 'Creator',
    emoji:    '🌍',
    color:    'text-emerald-400',
    bg:       'bg-emerald-500/10 border-emerald-400/20',
    config:   { tool: 'image', editMode: 'creative', intensity: 'HIGH', prompt: 'Afrofuturism aesthetic, vibrant African patterns, neon accents, futuristic' },
    description: 'Bold Afro-futuristic creative visual transformation',
  },
  {
    id:       'business_narration',
    name:     'Professional Brief',
    category: 'Business',
    emoji:    '💼',
    color:    'text-blue-400',
    bg:       'bg-blue-500/10 border-blue-400/20',
    config:   { tool: 'voice', voiceStyle: 'neutral_assistant', prompt: 'Clear professional business presentation voice' },
    description: 'Crisp, confident narration for business and corporate content',
  },
  {
    id:       'restore_cleanup',
    name:     'Photo Restoration',
    category: 'Creator',
    emoji:    '🔧',
    color:    'text-orange-400',
    bg:       'bg-orange-500/10 border-orange-400/20',
    config:   { tool: 'image', editMode: 'restore', intensity: 'MEDIUM', prompt: 'Remove noise, restore clarity, fix compression artifacts and blur' },
    description: 'Rescue old or degraded images with the Restore engine',
  },
];

const CATEGORY_ORDER = ['Creator', 'Business', 'Luxury', 'Social', 'Voiceover', 'Product Ads'];

const TOOL_ICONS = {
  image: <ImageIcon size={11} />,
  voice: <Mic size={11} />,
  video: <Video size={11} />,
  chat:  <MessageSquare size={11} />,
};

const TOOL_PATHS = {
  image: '/image-tools',
  voice: '/voice',
  video: '/video',
  chat:  '/chat',
};

// ── Recent workflow memory (localStorage only) ────────────────────────────────

const RECENT_KEY = 'ib_ai_recent_workflows';
const RECENT_MAX = 3;

function buildRecentEntry(config, name) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: name ?? `${config.tool ?? 'image'} workflow`,
    type: config.tool ?? 'image',
    mode: config.editMode ?? config.voiceStyle ?? config.videoMode ?? null,
    prompt: config.prompt ? config.prompt.slice(0, 40) : null,
    timestamp: Date.now(),
    config,
  };
}

function useRecentWorkflows() {
  const [recents, setRecents] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); }
    catch { return []; }
  });

  const addRecent = useCallback((entry) => {
    setRecents(prev => {
      const key = `${entry.name}|${entry.type}|${entry.mode}`;
      const next = [entry, ...prev.filter(e => `${e.name}|${e.type}|${e.mode}` !== key)].slice(0, RECENT_MAX);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, []);

  const removeRecent = useCallback((id) => {
    setRecents(prev => {
      const next = prev.filter(e => e.id !== id);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, []);

  const clearRecents = useCallback(() => {
    setRecents([]);
    try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
  }, []);

  return [recents, addRecent, removeRecent, clearRecents];
}

// ── Workflow run counter (localStorage) ───────────────────────────────────────

const COUNTS_KEY = 'ib_ai_workflow_counts';

function useWorkflowCounts() {
  const [counts, setCounts] = useState(() => {
    try { return JSON.parse(localStorage.getItem(COUNTS_KEY) ?? '{}'); }
    catch { return {}; }
  });

  const increment = useCallback((id) => {
    setCounts(prev => {
      const next = { ...prev, [id]: (prev[id] ?? 0) + 1 };
      try { localStorage.setItem(COUNTS_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, []);

  const clearCounts = useCallback(() => {
    setCounts({});
    try { localStorage.removeItem(COUNTS_KEY); } catch { /* ignore */ }
  }, []);

  return [counts, increment, clearCounts];
}

// ── URL param builder ─────────────────────────────────────────────────────────

function buildLaunchUrl(config) {
  const base = TOOL_PATHS[config.tool] ?? '/chat';
  const params = new URLSearchParams();
  if (config.editMode)  params.set('mode',    config.editMode);
  if (config.intensity) params.set('intensity', config.intensity);
  if (config.voiceStyle) params.set('voice',  config.voiceStyle);
  if (config.videoMode) params.set('vmode',   config.videoMode);
  if (config.presetId)  params.set('preset',  config.presetId);
  if (config.prompt)    params.set('prompt',  config.prompt);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// ── Preset card ───────────────────────────────────────────────────────────────

const PresetCard = memo(function PresetCard({ preset, count = 0, onLaunch, onSave }) {
  return (
    <motion.div
      layout
      className={`flex items-start gap-3 px-3.5 py-3 rounded-xl border ${preset.bg} group`}
    >
      <span className="text-xl shrink-0 mt-0.5">{preset.emoji}</span>
      <div className="flex-1 min-w-0">
        <p className={`text-[12px] font-semibold leading-tight ${preset.color}`}>{preset.name}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug line-clamp-2">{preset.description}</p>
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          <span className={`flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full border border-current/20 font-medium ${preset.color}`}>
            {TOOL_ICONS[preset.config.tool]}
            {preset.config.tool}
          </span>
          {preset.config.editMode && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-background/60 border border-border/40 text-muted-foreground">{preset.config.editMode}</span>
          )}
          {preset.config.voiceStyle && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-background/60 border border-border/40 text-muted-foreground">{preset.config.voiceStyle.replace(/_/g, ' ')}</span>
          )}
          {count > 1 && (
            <span className="text-[9px] font-medium text-muted-foreground/50 px-1.5 py-0.5 rounded-full bg-background/40 border border-border/30">
              ×{count}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 shrink-0">
        <button
          onClick={() => onLaunch(preset.config, preset.name, preset.id)}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-[10px] font-semibold hover:bg-primary/90 transition-colors shadow-sm shadow-primary/20"
        >
          <Zap size={9} />
          Launch
        </button>
        <button
          onClick={() => onSave(preset)}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border/60 text-muted-foreground text-[10px] hover:text-foreground hover:border-primary/30 hover:bg-secondary/40 transition-colors"
        >
          <Plus size={9} />
          Save
        </button>
      </div>
    </motion.div>
  );
});

// ── Session card ──────────────────────────────────────────────────────────────

const SessionCard = memo(function SessionCard({ session, onLaunch, onPin, onDuplicate, onDelete, onExport }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className="flex items-start gap-3 px-3.5 py-3 rounded-xl border border-border/50 bg-card/40 hover:bg-card/70 transition-colors group"
    >
      {session.pinned && <Pin size={10} className="text-primary mt-1.5 shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-foreground leading-tight truncate">{session.name}</p>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-secondary/60 border border-border/40 text-muted-foreground capitalize">{session.category}</span>
          <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground/70">
            {TOOL_ICONS[session.config?.tool]}
            {session.config?.tool}
          </span>
          {session.config?.editMode && (
            <span className="text-[9px] text-muted-foreground/50">{session.config.editMode}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onLaunch(session.config, session.name)}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-[10px] font-semibold hover:bg-primary/90 transition-colors"
        >
          <Zap size={9} />
          Launch
        </button>
        <div className="relative">
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <ChevronDown size={12} />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -4 }}
                className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-xl shadow-xl p-1 min-w-[130px]"
                onMouseLeave={() => setMenuOpen(false)}
              >
                {[
                  { icon: session.pinned ? <PinOff size={11} /> : <Pin size={11} />, label: session.pinned ? 'Unpin' : 'Pin', action: () => { onPin(session.id, !session.pinned); setMenuOpen(false); } },
                  { icon: <Copy size={11} />, label: 'Duplicate', action: () => { onDuplicate(session.id); setMenuOpen(false); } },
                  { icon: <Download size={11} />, label: 'Export JSON', action: () => { onExport(session); setMenuOpen(false); } },
                  { icon: <Trash2 size={11} />, label: 'Delete', action: () => { onDelete(session.id); setMenuOpen(false); }, danger: true },
                ].map(item => (
                  <button
                    key={item.label}
                    onClick={item.action}
                    className={`flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-[11px] transition-colors ${
                      item.danger ? 'text-destructive hover:bg-destructive/10' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
});

// ── Recent workflow card ───────────────────────────────────────────────────────

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000)        return 'just now';
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const RecentWorkflowCard = memo(function RecentWorkflowCard({ item, onLaunch, onRemove }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-border/40 bg-secondary/20 hover:bg-secondary/40 transition-colors group"
    >
      <div className="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 text-primary">
        {TOOL_ICONS[item.type]}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold text-foreground truncate leading-tight">{item.name}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          {item.mode && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-background/60 border border-border/40 text-muted-foreground/80 shrink-0">
              {item.mode.replace(/_/g, ' ')}
            </span>
          )}
          {item.prompt && (
            <span className="text-[9px] text-muted-foreground/50 truncate">{item.prompt}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <span className="text-[9px] text-muted-foreground/40 flex items-center gap-0.5 hidden sm:flex">
          <Clock size={8} />{relativeTime(item.timestamp)}
        </span>
        <button
          onClick={() => onLaunch(item.config, item.name)}
          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-primary text-primary-foreground text-[9px] font-semibold hover:bg-primary/90 transition-colors ml-1"
        >
          <Zap size={8} />
          Re-run
        </button>
        <button
          onClick={() => onRemove(item.id)}
          className="p-1 rounded-lg text-muted-foreground/30 hover:text-muted-foreground hover:bg-secondary transition-colors opacity-0 group-hover:opacity-100"
          aria-label="Remove from recents"
        >
          <X size={9} />
        </button>
      </div>
    </motion.div>
  );
});

// ── Save modal ────────────────────────────────────────────────────────────────

function SaveModal({ preset, onSave, onClose }) {
  const [name, setName] = useState(preset?.name ?? '');
  const [category, setCategory] = useState(preset?.category ?? 'Creator');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), category, config: preset.config });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 8 }}
        onClick={e => e.stopPropagation()}
        className="bg-card border border-border rounded-2xl p-5 w-full max-w-sm space-y-4 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Save Workflow</h3>
          <button onClick={onClose} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"><X size={14} /></button>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              placeholder="e.g. My Luxury Portrait Pipeline"
              className="w-full bg-background border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Category</label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="w-full bg-background border border-input rounded-xl px-3.5 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/50 transition-all"
            >
              {CATEGORY_ORDER.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="w-full px-4 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save Workflow'}
        </button>
      </motion.div>
    </motion.div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function WorkflowLauncher({ trigger }) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('presets');
  const [sessions, setSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [saveTarget, setSaveTarget] = useState(null);
  const [error, setError] = useState(null);
  const [recents, addRecent, removeRecent, clearRecents] = useRecentWorkflows();
  const [workflowCounts, incrementCount, clearCounts]   = useWorkflowCounts();
  const [clearConfirm, setClearConfirm] = useState(false);

  // Auto-cancel confirmation after 8 s
  useEffect(() => {
    if (!clearConfirm) return;
    const t = setTimeout(() => setClearConfirm(false), 8000);
    return () => clearTimeout(t);
  }, [clearConfirm]);

  const handleClearMemory = useCallback(() => {
    clearRecents();
    clearCounts();
    setClearConfirm(false);
  }, [clearRecents, clearCounts]);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const data = await listCreatorSessions();
      setSessions(data.sessions ?? []);
      setError(null);
    } catch {
      setError('Could not load saved workflows');
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    if (open && tab === 'mine') loadSessions();
  }, [open, tab, loadSessions]);

  const handleLaunch = useCallback((config, name, presetId) => {
    if (presetId) incrementCount(presetId);
    addRecent(buildRecentEntry(config, name));
    setOpen(false);
    navigate(buildLaunchUrl(config));
  }, [navigate, addRecent, incrementCount]);

  const handleSaveSession = useCallback(async (payload) => {
    await createCreatorSession(payload);
    setSessions(prev => [{ ...payload, id: Date.now().toString(), pinned: false, createdAt: Date.now(), updatedAt: Date.now() }, ...prev]);
    await loadSessions();
  }, [loadSessions]);

  const handlePin = useCallback(async (id, pinned) => {
    await updateCreatorSession(id, { pinned });
    setSessions(prev => prev.map(s => s.id === id ? { ...s, pinned } : s));
  }, []);

  const handleDuplicate = useCallback(async (id) => {
    await duplicateCreatorSession(id);
    await loadSessions();
  }, [loadSessions]);

  const handleDelete = useCallback(async (id) => {
    await deleteCreatorSession(id);
    setSessions(prev => prev.filter(s => s.id !== id));
  }, []);

  const handleExport = useCallback((session) => {
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-${session.name.replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const pinnedSessions  = sessions.filter(s => s.pinned);
  const recentSessions  = sessions.filter(s => !s.pinned).slice(0, 8);

  return (
    <>
      {/* Trigger */}
      <div onClick={() => setOpen(true)}>
        {trigger ?? (
          <button className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border/60 text-sm text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-secondary/40 transition-all">
            <Layers size={14} />
            Workflows
          </button>
        )}
      </div>

      {/* Backdrop */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Slide-out panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="fixed right-0 inset-y-0 z-[100] w-full max-w-sm bg-card border-l border-border shadow-2xl flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-border/50 shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-xl bg-primary/15 flex items-center justify-center">
                  <Layers size={13} className="text-primary" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Workflow Launcher</h2>
                  <p className="text-[10px] text-muted-foreground">Quick launch creator workflows</p>
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Tab bar */}
            <div className="flex gap-1 px-4 py-2.5 border-b border-border/40 shrink-0">
              {[
                { id: 'presets', label: 'Presets', icon: <Sparkles size={11} /> },
                { id: 'mine',   label: 'My Workflows', icon: <Layers size={11} /> },
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                    tab === t.id
                      ? 'bg-primary/15 text-primary border border-primary/25'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary border border-transparent'
                  }`}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {tab === 'presets' && (
                <>
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest font-semibold">Ready-to-launch templates</p>
                  <AnimatePresence mode="popLayout">
                    {WORKFLOW_PRESETS.map(preset => (
                      <PresetCard
                        key={preset.id}
                        preset={preset}
                        count={workflowCounts[preset.id] ?? 0}
                        onLaunch={handleLaunch}
                        onSave={(p) => setSaveTarget(p)}
                      />
                    ))}
                  </AnimatePresence>
                </>
              )}

              {tab === 'mine' && (
                <>
                  {/* ── Clear history control ── only shown when there is local memory */}
                  {(recents.length > 0 || Object.keys(workflowCounts).length > 0) && (
                    <div className="flex items-center justify-end min-h-[24px]">
                      <AnimatePresence mode="wait">
                        {clearConfirm ? (
                          <motion.div
                            key="confirm"
                            initial={{ opacity: 0, x: 6 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 6 }}
                            transition={{ duration: 0.15 }}
                            className="flex items-center gap-2"
                          >
                            <span className="text-[10px] text-muted-foreground">Clear local history?</span>
                            <button
                              onClick={handleClearMemory}
                              className="text-[10px] font-semibold text-destructive hover:text-destructive/80 px-2 py-0.5 rounded-md hover:bg-destructive/8 transition-colors"
                            >
                              Yes, clear
                            </button>
                            <button
                              onClick={() => setClearConfirm(false)}
                              className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                            >
                              Cancel
                            </button>
                          </motion.div>
                        ) : (
                          <motion.button
                            key="idle"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.12 }}
                            onClick={() => setClearConfirm(true)}
                            className="text-[9px] text-muted-foreground/40 hover:text-destructive/60 transition-colors px-2 py-1 rounded-lg hover:bg-destructive/5 border border-transparent hover:border-destructive/15"
                          >
                            Clear History
                          </motion.button>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* ── Top Workflows ── derived from localStorage counts, no effect */}
                  {(() => {
                    const topPresets = WORKFLOW_PRESETS
                      .filter(p => (workflowCounts[p.id] ?? 0) > 0)
                      .sort((a, b) => (workflowCounts[b.id] ?? 0) - (workflowCounts[a.id] ?? 0))
                      .slice(0, 2);
                    if (!topPresets.length) return null;
                    return (
                      <div className="space-y-1.5">
                        <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest font-semibold flex items-center gap-1.5">
                          <TrendingUp size={8} /> Top Workflows
                        </p>
                        {topPresets.map((preset, i) => (
                          <motion.div
                            key={preset.id}
                            layout
                            className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-border/40 bg-primary/5 hover:bg-primary/8 transition-colors"
                          >
                            <span className="text-base shrink-0 leading-none">{i === 0 ? '🥇' : '🥈'}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-[11px] font-semibold text-foreground truncate leading-tight">{preset.name}</p>
                              <span className={`flex items-center gap-0.5 text-[9px] mt-0.5 ${preset.color}`}>
                                {TOOL_ICONS[preset.config.tool]}
                                {preset.config.tool}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="text-[9px] font-semibold text-primary/70 bg-primary/10 px-1.5 py-0.5 rounded-full border border-primary/20">
                                ×{workflowCounts[preset.id]}
                              </span>
                              <button
                                onClick={() => handleLaunch(preset.config, preset.name, preset.id)}
                                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-primary text-primary-foreground text-[9px] font-semibold hover:bg-primary/90 transition-colors"
                              >
                                <Zap size={8} />
                                Launch
                              </button>
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* ── Recently Launched ── */}
                  {recents.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest font-semibold flex items-center gap-1.5">
                        <History size={8} /> Recently Launched
                      </p>
                      <AnimatePresence mode="popLayout">
                        {recents.map(item => (
                          <RecentWorkflowCard
                            key={item.id}
                            item={item}
                            onLaunch={handleLaunch}
                            onRemove={removeRecent}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  )}

                  {error && (
                    <div className="flex items-center gap-2 text-[11px] text-amber-400 bg-amber-400/10 rounded-lg px-3 py-2 border border-amber-400/20">
                      <AlertCircle size={11} /> {error}
                    </div>
                  )}
                  {loadingSessions ? (
                    <div className="flex items-center justify-center py-10 text-muted-foreground text-xs">
                      <RefreshCw size={14} className="animate-spin mr-2" /> Loading…
                    </div>
                  ) : sessions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                      <div className="w-12 h-12 rounded-2xl bg-secondary/60 flex items-center justify-center">
                        <Layers size={20} className="text-muted-foreground/40" />
                      </div>
                      <div>
                        <p className="text-sm text-foreground font-medium">No saved workflows</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Save a preset to build your library</p>
                      </div>
                      <button
                        onClick={() => setTab('presets')}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-primary border border-primary/25 hover:bg-primary/10 transition-colors"
                      >
                        <Sparkles size={10} /> Browse Presets
                      </button>
                    </div>
                  ) : (
                    <>
                      {pinnedSessions.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest font-semibold flex items-center gap-1.5">
                            <Pin size={8} /> Pinned
                          </p>
                          <AnimatePresence mode="popLayout">
                            {pinnedSessions.map(s => (
                              <SessionCard key={s.id} session={s} onLaunch={handleLaunch} onPin={handlePin} onDuplicate={handleDuplicate} onDelete={handleDelete} onExport={handleExport} />
                            ))}
                          </AnimatePresence>
                        </div>
                      )}
                      {recentSessions.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest font-semibold">Recent</p>
                          <AnimatePresence mode="popLayout">
                            {recentSessions.map(s => (
                              <SessionCard key={s.id} session={s} onLaunch={handleLaunch} onPin={handlePin} onDuplicate={handleDuplicate} onDelete={handleDelete} onExport={handleExport} />
                            ))}
                          </AnimatePresence>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Save modal */}
      <AnimatePresence>
        {saveTarget && (
          <SaveModal
            preset={saveTarget}
            onSave={handleSaveSession}
            onClose={() => setSaveTarget(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
