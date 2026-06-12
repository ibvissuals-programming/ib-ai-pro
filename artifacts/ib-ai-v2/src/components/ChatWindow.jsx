import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Cpu, Copy, Check, Download, X, CheckSquare, Square, ImagePlus, ChevronDown } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { useSelection } from '../hooks/useSelection';
import { IbLogo } from './IbLogo';
import { OnboardingPanel } from './OnboardingPanel';

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="flex gap-3 items-end"
    >
      <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center bg-secondary border border-border/60 text-muted-foreground">
        <Cpu size={13} />
      </div>
      <div className="px-4 py-3.5 rounded-2xl rounded-tl-sm glass-card">
        <div className="flex gap-1 items-center h-4">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              className="w-2 h-2 rounded-full bg-primary/50"
              animate={{ opacity: [0.25, 0.9, 0.25], scale: [0.8, 1.15, 0.8] }}
              transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
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
      <motion.div
        initial={{ opacity: 0, scale: 0.88, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="mb-5"
      >
        <IbLogo variant="mark" size={52} />
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.38, delay: 0.08, ease: 'easeOut' }}
      >
        <h3 className="text-[17px] font-bold text-foreground mb-2 tracking-tight" style={{ letterSpacing: '-0.03em' }}>
          IB <span className="text-primary">AI</span> Studio Lab
        </h3>
        <p className="text-sm text-muted-foreground/70 max-w-[280px] leading-relaxed mb-7">
          Ask anything — code, ideas, writing, or just a conversation.
        </p>
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, delay: 0.18, ease: 'easeOut' }}
        className="flex flex-col gap-2 w-full max-w-[320px]"
      >
        {[
          { text: 'Explain a concept simply' },
          { text: 'Help me write or improve content' },
          { icon: <ImagePlus size={11} />, text: 'Drop an image to analyze or edit' },
        ].map((item, i) => (
          <div
            key={i}
            className="text-left text-xs text-muted-foreground/60 px-3.5 py-3 rounded-xl border border-border/40 bg-secondary/20 flex items-center gap-2.5 leading-relaxed hover:border-primary/25 hover:text-muted-foreground hover:bg-secondary/40 transition-all cursor-default"
          >
            {item.icon ? (
              <>
                <span className="text-primary/70 shrink-0">{item.icon}</span>
                {item.text}
              </>
            ) : (
              <>
                <span className="w-1 h-1 rounded-full bg-border shrink-0" />
                {item.text}
              </>
            )}
          </div>
        ))}
      </motion.div>
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

export function ChatWindow({ messages, isTyping, onEditMessage, onSuggest, showOnboarding }) {
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
        <AnimatePresence mode="wait">
          {showOnboarding && onSuggest ? (
            <OnboardingPanel key="onboarding" onSend={onSuggest} />
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <EmptyState />
            </motion.div>
          )}
        </AnimatePresence>
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
              isStreaming={isTyping}
              selectionMode={selectionMode}
              isSelected={selectedIds.has(message.id)}
              onToggleSelect={toggleSelect}
              onEnterSelection={enterSelectionMode}
              onEditMessage={onEditMessage}
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
