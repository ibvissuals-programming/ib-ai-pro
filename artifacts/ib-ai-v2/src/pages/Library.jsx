import { useState } from 'react';
import { Link } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { Bookmark, Trash2, Download, ArrowLeft, FileText, Image as ImageIcon, Loader2, BookmarkX } from 'lucide-react';
import { useLibrary } from '../hooks/useLibrary';
import { useAuth } from '../hooks/useAuth';

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function TextCard({ item, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = () => {
    if (confirmDelete) {
      onDelete(item.id);
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 2500);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="group relative rounded-xl border border-border/50 bg-card/60 backdrop-blur p-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-widest shrink-0">
          <FileText size={10} />
          Saved Hook
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={handleDelete}
            className={`p-1 rounded transition-colors ${
              confirmDelete
                ? 'text-destructive bg-destructive/10'
                : 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
            }`}
            title={confirmDelete ? 'Click again to confirm' : 'Delete'}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap line-clamp-[12]">
        {item.content}
      </p>
      <p className="text-[10px] text-muted-foreground/50">{formatDate(item.createdAt)}</p>
    </motion.div>
  );
}

function ImageCard({ item, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = () => {
    if (confirmDelete) {
      onDelete(item.id);
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 2500);
    }
  };

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = item.content;
    a.download = `ib-ai-saved-${item.id}.jpg`;
    a.click();
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="group relative rounded-xl border border-border/50 bg-card/60 backdrop-blur overflow-hidden"
    >
      <div className="relative">
        <img
          src={item.content}
          alt="Saved image"
          className="w-full object-cover max-h-72"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="absolute bottom-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-black/60 backdrop-blur text-white text-xs hover:bg-black/80 transition-colors"
          >
            <Download size={10} />
            Save
          </button>
          <button
            onClick={handleDelete}
            className={`p-1.5 rounded-lg backdrop-blur text-xs transition-colors ${
              confirmDelete
                ? 'bg-destructive/80 text-white'
                : 'bg-black/60 text-white/70 hover:bg-destructive/70 hover:text-white'
            }`}
            title={confirmDelete ? 'Click again to confirm' : 'Delete'}
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-widest">
          <ImageIcon size={10} />
          Saved Image
        </div>
        <p className="text-[10px] text-muted-foreground/50">{formatDate(item.createdAt)}</p>
      </div>
    </motion.div>
  );
}

export default function Library() {
  const { user } = useAuth();
  const { items, loading, error, deleteItem } = useLibrary();

  const textItems  = items.filter(i => i.type === 'text');
  const imageItems = items.filter(i => i.type === 'image');

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-border/60 shrink-0">
        <Link to="/chat">
          <a className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm">
            <ArrowLeft size={14} />
            Back to Chat
          </a>
        </Link>
        <div className="flex items-center gap-2 ml-2">
          <Bookmark size={16} className="text-primary" />
          <h1 className="text-base font-semibold text-foreground">My Library</h1>
          {!loading && items.length > 0 && (
            <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded-full">
              {items.length}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6" style={{ scrollbarWidth: 'thin' }}>
        {loading ? (
          <div className="flex items-center justify-center h-48 gap-2 text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-sm">Loading library…</span>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-48">
            <p className="text-sm text-destructive/70">{error}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
              <BookmarkX size={20} className="text-primary/50" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground/70">Your library is empty</p>
              <p className="text-xs text-muted-foreground mt-1">
                Click the bookmark icon on any AI message or image to save it here.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-8 max-w-3xl mx-auto">
            {imageItems.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest px-0.5">
                  Images · {imageItems.length}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <AnimatePresence mode="popLayout">
                    {imageItems.map(item => (
                      <ImageCard key={item.id} item={item} onDelete={deleteItem} />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            )}

            {textItems.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest px-0.5">
                  Hooks & Copy · {textItems.length}
                </h2>
                <div className="grid grid-cols-1 gap-3">
                  <AnimatePresence mode="popLayout">
                    {textItems.map(item => (
                      <TextCard key={item.id} item={item} onDelete={deleteItem} />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
