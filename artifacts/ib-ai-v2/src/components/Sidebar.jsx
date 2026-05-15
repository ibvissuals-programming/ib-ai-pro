import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, Cpu, MessageSquare, Check, X, PenLine, Search } from 'lucide-react';
import { CreditMeter } from './CreditMeter';

function HighlightedText({ text, query }) {
  if (!query.trim()) return <span>{text}</span>;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  return (
    <span>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-primary/30 text-foreground rounded-sm px-0.5 not-italic">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

function getMessageSnippet(messages, query) {
  if (!query.trim() || !messages?.length) return null;
  const lower = query.toLowerCase();
  const match = messages.find(m => m.content?.toLowerCase().includes(lower));
  if (!match) return null;
  const idx = match.content.toLowerCase().indexOf(lower);
  const start = Math.max(0, idx - 20);
  const snippet = (start > 0 ? '...' : '') + match.content.slice(start, idx + query.length + 30) + (idx + query.length + 30 < match.content.length ? '...' : '');
  return snippet;
}

function ChatItem({ chatId, chat, isActive, onSwitch, onDelete, onRename, searchQuery }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(chat.title);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleRenameSubmit = () => {
    onRename(chatId, editValue);
    setEditing(false);
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete(chatId);
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 2500);
    }
  };

  const titleMatch = searchQuery && chat.title?.toLowerCase().includes(searchQuery.toLowerCase());
  const snippet = !titleMatch ? getMessageSnippet(chat.messages, searchQuery) : null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -8 }}
      className={`group relative flex items-start gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
        isActive
          ? 'bg-primary/15 border border-primary/25 text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground border border-transparent'
      }`}
      onClick={() => !editing && onSwitch(chatId)}
      data-testid={`chat-item-${chatId}`}
    >
      <MessageSquare size={13} className={`shrink-0 mt-0.5 ${isActive ? 'text-primary' : ''}`} />

      {editing ? (
        <form
          onSubmit={(e) => { e.preventDefault(); handleRenameSubmit(); }}
          className="flex-1 flex items-center gap-1"
          onClick={e => e.stopPropagation()}
        >
          <input
            autoFocus
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setEditing(false)}
            className="flex-1 bg-background border border-input rounded px-1.5 py-0.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring min-w-0"
          />
          <button type="submit" className="text-primary hover:opacity-80">
            <Check size={12} />
          </button>
          <button type="button" onClick={() => setEditing(false)} className="text-muted-foreground hover:opacity-80">
            <X size={12} />
          </button>
        </form>
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <div className="text-xs truncate leading-relaxed">
              <HighlightedText text={chat.title} query={searchQuery} />
            </div>
            {snippet && (
              <div className="text-xs text-muted-foreground/60 mt-0.5 leading-relaxed line-clamp-2">
                <HighlightedText text={snippet} query={searchQuery} />
              </div>
            )}
          </div>

          <div className={`flex items-center gap-0.5 shrink-0 ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
            <button
              onClick={(e) => { e.stopPropagation(); setEditing(true); setEditValue(chat.title); }}
              data-testid={`button-rename-${chatId}`}
              className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              title="Rename"
            >
              <PenLine size={11} />
            </button>
            <button
              onClick={handleDelete}
              data-testid={`button-delete-${chatId}`}
              className={`p-1 rounded transition-colors ${
                confirmDelete
                  ? 'text-destructive bg-destructive/10'
                  : 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
              }`}
              title={confirmDelete ? 'Click again to confirm' : 'Delete chat'}
            >
              <Trash2 size={11} />
            </button>
          </div>
        </>
      )}
    </motion.div>
  );
}

export function Sidebar({ chats, activeChatId, onSwitch, onNew, onDelete, onRename, user, credits, onUpgradeClick }) {
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef(null);

  const allIds = Object.keys(chats).sort(
    (a, b) => (chats[b].createdAt ?? 0) - (chats[a].createdAt ?? 0)
  );

  const filteredIds = searchQuery.trim()
    ? allIds
        .filter((id) => {
          const chat = chats[id];
          const q = searchQuery.toLowerCase();
          const titleMatch = chat.title?.toLowerCase().includes(q);
          const messageMatch = chat.messages?.some(m => m.content?.toLowerCase().includes(q));
          return titleMatch || messageMatch;
        })
        .sort((a, b) => {
          const q = searchQuery.toLowerCase();
          const aTitleMatch = chats[a].title?.toLowerCase().includes(q) ? 1 : 0;
          const bTitleMatch = chats[b].title?.toLowerCase().includes(q) ? 1 : 0;
          return bTitleMatch - aTitleMatch;
        })
    : allIds;

  return (
    <div className="flex flex-col h-full bg-sidebar border-r border-sidebar-border/60 w-64 shrink-0 glass-subtle">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 py-4 border-b border-sidebar-border/60">
        <div className="w-7 h-7 rounded-xl bg-primary flex items-center justify-center shrink-0 shadow-md shadow-primary/25">
          <Cpu size={12} className="text-primary-foreground" />
        </div>
        <span className="font-semibold text-sm tracking-tight text-sidebar-foreground font-heading">
          IB AI <span className="text-primary">v3</span>
        </span>
      </div>

      {/* New Chat Button */}
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onNew}
          data-testid="button-new-chat"
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-border/60 text-muted-foreground hover:border-primary/50 hover:text-foreground hover:bg-primary/6 transition-all text-xs font-medium hover-lift-sm"
        >
          <Plus size={13} />
          New Chat
        </button>
      </div>

      {/* Search Input */}
      <div className="px-3 pb-2">
        <div className="relative flex items-center">
          <Search size={12} className="absolute left-2.5 text-muted-foreground/50 pointer-events-none" />
          <input
            ref={searchRef}
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search chats..."
            data-testid="input-search-chats"
            className="w-full bg-background border border-input rounded-lg pl-7 pr-7 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-ring transition-all"
          />
          <AnimatePresence>
            {searchQuery && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                onClick={() => { setSearchQuery(''); searchRef.current?.focus(); }}
                className="absolute right-2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                data-testid="button-clear-search"
              >
                <X size={11} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Chat List */}
      <div
        className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'hsl(217 33% 20%) transparent' }}
      >
        {filteredIds.length === 0 ? (
          <div className="py-6 text-center">
            {searchQuery ? (
              <>
                <p className="text-xs text-muted-foreground">No results for</p>
                <p className="text-xs text-foreground font-medium mt-0.5">"{searchQuery}"</p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No chats yet</p>
            )}
          </div>
        ) : (
          <>
            {searchQuery && (
              <p className="text-xs text-muted-foreground/60 px-1 pb-1">
                {filteredIds.length} result{filteredIds.length !== 1 ? 's' : ''}
              </p>
            )}
            <AnimatePresence mode="popLayout">
              {filteredIds.map(id => (
                <ChatItem
                  key={id}
                  chatId={id}
                  chat={chats[id]}
                  isActive={id === activeChatId}
                  onSwitch={onSwitch}
                  onDelete={onDelete}
                  onRename={onRename}
                  searchQuery={searchQuery}
                />
              ))}
            </AnimatePresence>
          </>
        )}
      </div>

      {/* Credit Meter — above user footer */}
      <CreditMeter credits={credits} onUpgradeClick={onUpgradeClick} />

      {/* User Footer */}
      <div className="px-4 py-3 border-t border-sidebar-border">
        <p className="text-xs text-muted-foreground truncate">
          Signed in as <span className="text-foreground font-medium">{user?.username}</span>
        </p>
      </div>
    </div>
  );
}

/* Mobile slide-out wrapper */
export function MobileSidebar({ open, onClose, children }) {
  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={onClose}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: -260 }}
            animate={{ x: 0 }}
            exit={{ x: -260 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="fixed inset-y-0 left-0 z-50 md:hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
