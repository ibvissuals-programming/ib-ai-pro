/**
 * UserHistoryModal — CEO view of a single user's image generation history.
 *
 * Fetches: GET /api/admin/users/:userId/history?limit=20
 * Opens as a full-screen modal overlay.
 * Shows thumbnail grid with prompt, mode, type badge, and timestamp.
 */

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Image, RefreshCw, AlertCircle, ImageOff, Clock, Wand2, Pencil } from 'lucide-react';
import { getAuthHeaders } from '../auth/authService';

const BASE = (() => {
  try { return (import.meta?.env?.BASE_URL ?? '').replace(/\/$/, ''); }
  catch { return ''; }
})();

function formatRelative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 5_000)      return 'just now';
  if (diff < 60_000)     return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'Africa/Lagos' });
}

function TypeBadge({ type }) {
  const isEdit = type === 'edit';
  return (
    <span className={`
      inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide
      ${isEdit
        ? 'text-blue-300 bg-blue-400/10 border-blue-400/20'
        : 'text-violet-300 bg-violet-400/10 border-violet-400/20'}
    `}>
      {isEdit ? <Pencil size={7} /> : <Wand2 size={7} />}
      {isEdit ? 'Edit' : 'Generate'}
    </span>
  );
}

function HistoryThumbnail({ entry }) {
  const [imgError, setImgError] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      className="glass-subtle rounded-lg overflow-hidden border border-border/20 hover:border-border/40 transition-colors group"
    >
      {/* Image */}
      <div className="relative aspect-square bg-muted/20 overflow-hidden">
        {!imgError ? (
          <img
            src={`${BASE}${entry.imageUrl}`}
            alt={entry.prompt}
            onError={() => setImgError(true)}
            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageOff size={20} className="text-muted-foreground/30" />
          </div>
        )}
        {/* Type badge overlay */}
        <div className="absolute top-1.5 left-1.5">
          <TypeBadge type={entry.type} />
        </div>
      </div>

      {/* Meta */}
      <div className="px-2.5 py-2 space-y-1">
        <p className="text-[10px] text-foreground/80 line-clamp-2 leading-relaxed">
          {entry.prompt}
        </p>
        <div className="flex items-center justify-between">
          <span className="text-[9px] text-muted-foreground/60 capitalize">{entry.mode}</span>
          <span className="text-[9px] text-muted-foreground/50 flex items-center gap-0.5">
            <Clock size={7} />
            {formatRelative(entry.timestamp)}
          </span>
        </div>
        {entry.latencyMs && (
          <div className="text-[9px] text-muted-foreground/40">
            {(entry.latencyMs / 1000).toFixed(1)}s
            {entry.retryCount > 0 && <span className="ml-1 text-amber-400/60">↺{entry.retryCount}</span>}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function SkeletonCard() {
  return (
    <div className="glass-subtle rounded-lg overflow-hidden border border-border/20 animate-pulse">
      <div className="aspect-square bg-muted/30" />
      <div className="px-2.5 py-2 space-y-1.5">
        <div className="h-2 bg-muted/40 rounded w-full" />
        <div className="h-2 bg-muted/30 rounded w-3/4" />
      </div>
    </div>
  );
}

export function UserHistoryModal({ userId, username, onClose }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    setEntries([]);

    const controller = new AbortController();
    abortRef.current = controller;

    fetch(`${BASE}/api/admin/users/${userId}/history?limit=20`, {
      headers: { ...getAuthHeaders() },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (controller.signal.aborted) return;
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(json.error ?? `Server error (${res.status})`);
        } else {
          setEntries(json.entries ?? []);
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setError('Failed to load history');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [userId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ duration: 0.18 }}
          className="glass-card rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden border border-border/30"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/30 shrink-0">
            <div className="flex items-center gap-2.5">
              <Image size={16} className="text-primary" />
              <div>
                <h2 className="text-sm font-semibold text-foreground">Image History</h2>
                <p className="text-[10px] text-muted-foreground">{username}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {loading && <RefreshCw size={12} className="text-muted-foreground animate-spin" />}
              {!loading && entries.length > 0 && (
                <span className="text-[10px] text-muted-foreground/60">{entries.length} image{entries.length !== 1 ? 's' : ''}</span>
              )}
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto px-5 py-4">
            {error && (
              <div className="flex flex-col items-center gap-2 py-16 text-center">
                <AlertCircle size={20} className="text-amber-400/70" />
                <p className="text-sm text-muted-foreground">Failed to load history</p>
                <p className="text-xs text-muted-foreground/50">{error}</p>
              </div>
            )}

            {!error && loading && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
              </div>
            )}

            {!error && !loading && entries.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-16 text-center">
                <ImageOff size={24} className="text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No images yet</p>
                <p className="text-xs text-muted-foreground/50">This user has not generated or edited any images</p>
              </div>
            )}

            {!error && !loading && entries.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {entries.map((entry) => (
                  <HistoryThumbnail key={entry.id} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
