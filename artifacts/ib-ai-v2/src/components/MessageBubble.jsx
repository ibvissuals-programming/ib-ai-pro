import { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Copy, Check, Cpu, User, Square, CheckSquare, Image as ImageIcon, Download, Wand2 } from 'lucide-react';
import { ImageAnalysisCard } from './ImageAnalysisCard';

// ─── Reliable clipboard helper ────────────────────────────────────────────────
// Note: isSecureContext guard intentionally omitted — the Replit preview runs
// in a proxied iframe where isSecureContext can be false even over HTTPS, which
// would silently prevent the Clipboard API from being attempted at all.

async function copyToClipboard(text) {
  // Primary: async Clipboard API
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }
  // Fallback: document.execCommand — works on iOS Safari, older browsers,
  // and iframe contexts where the Clipboard API is unavailable.
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

// ─── Code block with per-block copy ──────────────────────────────────────────

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative my-2 rounded-lg glass-card bg-black/30 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
        <span className="text-[10px] text-muted-foreground font-mono tracking-wide uppercase">
          {lang || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors py-0.5 px-1.5 rounded hover:bg-white/5"
          aria-label="Copy code"
        >
          {copied ? <Check size={9} /> : <Copy size={9} />}
          <span>{copied ? 'Copied!' : 'Copy code'}</span>
        </button>
      </div>
      <pre className="overflow-x-auto">
        <code className={`block px-4 py-3 text-xs font-mono leading-relaxed text-foreground/90 language-${lang}`}>
          {code}
        </code>
      </pre>
    </div>
  );
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderBold(line) {
  return line.split(/(\*\*[^*]+\*\*)/g).map((part, j) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={j} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={j}>{part}</span>;
  });
}

function renderContent(text) {
  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim() || 'text';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      result.push(
        <CodeBlock key={`code-${i}`} lang={lang} code={codeLines.join('\n')} />
      );
      i++;
      continue;
    }

    if (!trimmed) {
      result.push(<br key={`br-${i}`} />);
      i++;
      continue;
    }

    if (/^\d+\./.test(trimmed)) {
      const num = trimmed.match(/^\d+/)[0];
      const rest = line.replace(/^\s*\d+\.\s*/, '');
      result.push(
        <div key={`ol-${i}`} className="flex gap-2 my-0.5">
          <span className="text-primary font-medium shrink-0">{num}.</span>
          <span>{renderBold(rest)}</span>
        </div>
      );
      i++;
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('– ')) {
      const rest = line.replace(/^\s*[-–]\s*/, '');
      result.push(
        <div key={`li-${i}`} className="flex gap-2 my-0.5">
          <span className="text-primary shrink-0 mt-0.5">–</span>
          <span>{renderBold(rest)}</span>
        </div>
      );
      i++;
      continue;
    }

    result.push(
      <p key={`p-${i}`} className="leading-relaxed">
        {renderBold(line)}
      </p>
    );
    i++;
  }

  return result;
}

// ─── Edited image result card ─────────────────────────────────────────────────

function EditedImageCard({ src }) {
  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = src;
    a.download = `ib-ai-edit-${Date.now()}.png`;
    a.click();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] text-primary/70 font-medium uppercase tracking-widest">
        <Wand2 size={10} />
        Edited Image
      </div>
      <div className="relative rounded-xl overflow-hidden border border-border/50 bg-black/20">
        <img
          src={src}
          alt="Edited"
          className="w-full max-h-[480px] object-contain"
        />
        <button
          onClick={handleDownload}
          className="absolute bottom-2 right-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/60 backdrop-blur text-white text-xs hover:bg-black/80 transition-colors"
        >
          <Download size={11} />
          Save
        </button>
      </div>
    </div>
  );
}

// ─── Message content branching ────────────────────────────────────────────────

function MessageContent({ message }) {
  // User: image uploaded for analysis only (no text)
  if (message.type === 'image') {
    return (
      <div className="flex items-center gap-2 py-0.5">
        <ImageIcon size={14} className="shrink-0 opacity-70" />
        <span className="text-sm truncate max-w-[200px]">{message.content}</span>
        <span className="text-[10px] text-current opacity-50 shrink-0">· image</span>
      </div>
    );
  }

  // User: image + edit-intent prompt → routing to /api/image/edit
  if (message.type === 'image-edit-request') {
    return (
      <div className="flex items-start gap-2.5">
        {message.imagePreview && (
          <img
            src={message.imagePreview}
            alt={message.filename ?? 'source'}
            className="w-12 h-12 rounded-lg object-cover border border-white/20 shrink-0"
          />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-[10px] opacity-60 mb-1">
            <Wand2 size={9} />
            Edit request
          </div>
          <span className="text-sm leading-relaxed">{message.content}</span>
        </div>
      </div>
    );
  }

  // Assistant: edited image returned from /api/image/edit
  if (message.type === 'image-edit-result') {
    return <EditedImageCard src={message.content} />;
  }

  // Assistant: structured analysis JSON from /api/analyze-image
  if (message.type === 'image-analysis') {
    let data = null;
    try {
      data = JSON.parse(message.content);
    } catch {
      // fall through to text render
    }
    if (data) return <ImageAnalysisCard data={data} />;
  }

  return <div className="space-y-1">{renderContent(message.content)}</div>;
}

// ─── Message bubble ───────────────────────────────────────────────────────────

const LONG_PRESS_MS = 500;

export function MessageBubble({
  message,
  index,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
  onEnterSelection,
  isTyping = false,
}) {
  const [copied, setCopied] = useState(false);
  const longPressTimer = useRef(null);
  const didLongPress = useRef(false);

  const isUser = message.role === 'user';
  const isPromptEngineering = message.mode === 'prompt_engineering';
  const isAnalysis = message.type === 'image-analysis';
  const isImageMsg = message.type === 'image';
  const isEditRequest = message.type === 'image-edit-request';
  const isEditResult = message.type === 'image-edit-result';

  // Full-width for analysis cards and edit result images
  const bubbleMaxWidth = (isAnalysis || isEditResult) ? 'max-w-full w-full' : 'max-w-[78%]';

  // ── Reliable copy handler ──────────────────────────────────────────────────
  const handleCopy = useCallback(async (e) => {
    e.stopPropagation();
    const textToCopy = isAnalysis
      ? (() => {
          try {
            const d = JSON.parse(message.content);
            const p = d?.prompts ?? {};
            const ie = p.imageEdit ?? {};
            return [
              ie.cinematic, ie.luxury, ie.wallpaper, ie.canva, ie.tiktok,
              p.videoEdit,
              ...(Object.values(p.variants ?? {})),
            ].filter(Boolean).join('\n\n');
          } catch {
            return message.content;
          }
        })()
      : message.content;

    const ok = await copyToClipboard(textToCopy);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [message.content, isAnalysis]);

  // ── Long-press (enter selection mode) ─────────────────────────────────────
  const startLongPress = useCallback(() => {
    didLongPress.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      if (!selectionMode && onEnterSelection) {
        onEnterSelection(message.id);
      }
    }, LONG_PRESS_MS);
  }, [selectionMode, onEnterSelection, message.id]);

  const cancelLongPress = useCallback(() => {
    clearTimeout(longPressTimer.current);
  }, []);

  const handleClick = useCallback(() => {
    if (didLongPress.current) return;
    if (selectionMode && onToggleSelect) {
      onToggleSelect(message.id);
    }
  }, [selectionMode, onToggleSelect, message.id]);

  const CheckIcon = isSelected ? CheckSquare : Square;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut', delay: Math.min(index * 0.025, 0.12) }}
      className={`flex gap-3 group relative ${isUser ? 'flex-row-reverse' : 'flex-row'} ${
        selectionMode ? 'cursor-pointer select-none' : ''
      }`}
      data-testid={`message-bubble-${message.id}`}
      onClick={handleClick}
      onTouchStart={startLongPress}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
    >
      {/* Selection highlight overlay */}
      {selectionMode && (
        <div
          className={`absolute inset-0 -mx-2 rounded-xl transition-colors pointer-events-none ${
            isSelected ? 'bg-primary/8' : 'hover:bg-white/3'
          }`}
        />
      )}

      {/* Avatar / checkbox */}
      <div className="relative shrink-0 mt-0.5">
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
            isUser
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary border border-border text-muted-foreground'
          } ${selectionMode ? 'opacity-0 scale-75' : 'opacity-100 scale-100'}`}
          style={{ transitionDuration: '150ms' }}
        >
          {isUser ? <User size={13} /> : <Cpu size={13} />}
        </div>

        <div
          className={`absolute inset-0 flex items-center justify-center transition-all ${
            selectionMode ? 'opacity-100 scale-100' : 'opacity-0 scale-75'
          }`}
          style={{ transitionDuration: '150ms' }}
        >
          <CheckIcon
            size={18}
            className={isSelected ? 'text-primary' : 'text-muted-foreground'}
          />
        </div>
      </div>

      {/* Bubble */}
      <div
        className={`relative flex flex-col gap-1 ${bubbleMaxWidth} ${
          isUser ? 'items-end' : 'items-start'
        }`}
      >
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed transition-colors ${
            isAnalysis || isEditResult
              ? 'glass-card text-foreground rounded-tl-sm w-full'
              : isUser
              ? `bg-primary text-primary-foreground rounded-tr-sm shadow-lg shadow-primary/10 ${isSelected ? 'ring-1 ring-primary/40' : ''}`
              : isPromptEngineering
              ? 'glass-card border-purple-500/30 text-foreground rounded-tl-sm'
              : `glass-card text-foreground rounded-tl-sm ${isSelected ? 'ring-1 ring-primary/30' : ''}`
          }`}
        >
          {isPromptEngineering && !isUser && !isAnalysis && (
            <div className="text-xs text-purple-400 font-medium mb-2 pb-2 border-b border-purple-500/20 tracking-wide uppercase">
              Prompt Engineering
            </div>
          )}
          <MessageContent message={message} />
        </div>

        {/* Single-message copy */}
        {!selectionMode && !isTyping && !isImageMsg && !isEditRequest && !isEditResult && (
          <button
            onClick={handleCopy}
            data-testid={`button-copy-${message.id}`}
            className={`
              flex items-center gap-1 text-xs text-muted-foreground
              hover:text-foreground px-1.5 py-0.5 rounded transition-all self-end
              opacity-40 hover:opacity-100
              [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100
            `}
            aria-label="Copy message"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>
        )}
      </div>
    </motion.div>
  );
}
