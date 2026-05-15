import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Cpu, Copy, Check, Download, X, CheckSquare, Square, ImagePlus, ChevronDown } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { useSelection } from '../hooks/useSelection';

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="flex gap-3 items-end"
    >
      <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center bg-secondary border border-border text-muted-foreground">
        <Cpu size={13} />
      </div>
      <div className="px-4 py-3 rounded-2xl rounded-tl-sm glass-card">
        <div className="flex gap-1.5 items-center h-4">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-muted-foreground"
              animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
              transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
        <Cpu size={20} className="text-primary" />
      </div>
      <h3 className="text-base font-semibold text-foreground mb-1">IB AI Assistant</h3>
      <p className="text-xs text-primary/70 font-medium mb-3 tracking-wide">
        Multimodal AI Assistant
      </p>
      <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
        Chat, analyze images, and generate creative briefs for editing and video production.
      </p>
      <div className="mt-6 flex flex-col gap-2 w-full max-w-sm">
        {[
          'Explain gradient descent in simple terms',
          'Improve this prompt: Write a blog post about AI',
          { icon: <ImagePlus size={11} />, text: 'Drop an image to generate cinematic edit prompts' },
        ].map((item, i) => (
          <div
            key={i}
            className="text-left text-xs text-muted-foreground px-3 py-2 rounded-lg border border-border/50 bg-secondary/30 flex items-center gap-2"
          >
            {typeof item === 'string' ? item : (
              <>
                <span className="text-primary shrink-0">{item.icon}</span>
                {item.text}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Selection toolbar ────────────────────────────────────────────────────────

function SelectionBar({
  selectedCount,
  allSelected,
  copyState,
  onSelectAll,
  onDeselectAll,
  onCopy,
  onExport,
  onCancel,
}) {
  const CopyIcon = copyState === 'copied' ? Check : Copy;
  const copyLabel =
    copyState === 'copied' ? 'Copied!' : copyState === 'error' ? 'Failed' : 'Copy';

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18 }}
      className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 glass-panel shrink-0"
    >
      <span className="text-xs font-medium text-foreground tabular-nums min-w-[72px]">
        {selectedCount} selected
      </span>

      <div className="flex items-center gap-1 flex-1">
        <button
          onClick={allSelected ? onDeselectAll : onSelectAll}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2.5 py-1.5 rounded-lg hover:bg-white/6 transition-colors"
        >
          {allSelected ? <CheckSquare size={13} /> : <Square size={13} />}
          <span className="hidden sm:inline">{allSelected ? 'Deselect all' : 'Select all'}</span>
        </button>

        <button
          onClick={onCopy}
          disabled={!selectedCount}
          className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            copyState === 'copied'
              ? 'text-green-400 bg-green-400/10'
              : copyState === 'error'
              ? 'text-destructive bg-destructive/10'
              : 'text-muted-foreground hover:text-foreground hover:bg-white/6'
          }`}
        >
          <CopyIcon size={13} />
          <span className="hidden sm:inline">{copyLabel}</span>
        </button>

        <button
          onClick={onExport}
          disabled={!selectedCount}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2.5 py-1.5 rounded-lg hover:bg-white/6 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download size={13} />
          <span className="hidden sm:inline">Export</span>
        </button>
      </div>

      <button
        onClick={onCancel}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2.5 py-1.5 rounded-lg hover:bg-white/6 transition-colors ml-auto"
      >
        <X size={13} />
        <span className="hidden sm:inline">Cancel</span>
      </button>
    </motion.div>
  );
}

// ─── Chat window ──────────────────────────────────────────────────────────────

const NEAR_BOTTOM_PX = 120;

export function ChatWindow({ messages, isTyping }) {
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const {
    selectionMode,
    selectedIds,
    selectedCount,
    allSelected,
    copyState,
    enterSelectionMode,
    exitSelectionMode,
    toggleSelect,
    selectAll,
    deselectAll,
    copySelected,
    exportSelected,
  } = useSelection(messages);

  // Track whether the user is near the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distFromBottom < NEAR_BOTTOM_PX;
    isNearBottomRef.current = near;
    setShowScrollBtn(!near);
  }, []);

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior });
  }, []);

  // Auto-scroll: only if user is already near the bottom
  useEffect(() => {
    if (!selectionMode && isNearBottomRef.current) {
      scrollToBottom('smooth');
    }
  }, [messages, isTyping, selectionMode, scrollToBottom]);

  useEffect(() => {
    if (messages.length === 0) exitSelectionMode();
  }, [messages.length, exitSelectionMode]);

  if (messages.length === 0 && !isTyping) {
    return (
      <div className="flex-1 overflow-y-auto">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AnimatePresence>
        {selectionMode && (
          <SelectionBar
            selectedCount={selectedCount}
            allSelected={allSelected}
            copyState={copyState}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onCopy={copySelected}
            onExport={exportSelected}
            onCancel={exitSelectionMode}
          />
        )}
      </AnimatePresence>

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-4 py-6 space-y-5 scroll-smooth"
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'hsl(217 33% 20%) transparent' }}
          data-testid="chat-window"
        >
          {messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              index={index}
              isTyping={isTyping && index === messages.length - 1}
              selectionMode={selectionMode}
              isSelected={selectedIds.has(message.id)}
              onToggleSelect={toggleSelect}
              onEnterSelection={enterSelectionMode}
            />
          ))}

          <AnimatePresence>
            {isTyping && <TypingIndicator />}
          </AnimatePresence>

          <div ref={bottomRef} />
        </div>

        {/* Scroll-to-bottom floating button */}
        <AnimatePresence>
          {showScrollBtn && !selectionMode && (
            <motion.button
              initial={{ opacity: 0, scale: 0.8, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              onClick={() => scrollToBottom('smooth')}
              aria-label="Scroll to bottom"
              className="absolute bottom-4 right-4 z-10 w-8 h-8 rounded-full glass-card flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shadow-lg hover:shadow-xl"
            >
              <ChevronDown size={16} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
