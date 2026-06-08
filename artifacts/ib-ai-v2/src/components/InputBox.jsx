import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowUp, Trash2, ImagePlus, X, AlertCircle, Wand2, Mic, MicOff, Square } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { readImageFile, validateImageFile } from '../services/imageApi';
import { hasEditIntent } from '../services/aiEngine';

export function InputBox({ onSend, onSendImage, onSendImageEdit, onClear, onStop, disabled }) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [attachedImage, setAttachedImage] = useState(null); // { base64, mimeType, filename, previewUrl }
  const [imageError, setImageError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const [isListening, setIsListening] = useState(false);

  const textareaRef    = useRef(null);
  const fileInputRef   = useRef(null);
  const dragCounterRef = useRef(0); // track nested drag events
  const recognitionRef = useRef(null);

  const speechSupported =
    typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  // ── Global drag-and-drop support ─────────────────────────────────────────────
  const processFile = useCallback(async (file) => {
    setImageError('');
    const validationError = validateImageFile(file);
    if (validationError) {
      setImageError(validationError);
      setTimeout(() => setImageError(''), 4000);
      return;
    }
    try {
      const imageData = await readImageFile(file);
      setAttachedImage(imageData);
    } catch {
      setImageError('Failed to read image. Please try again.');
      setTimeout(() => setImageError(''), 4000);
    }
  }, []);

  useEffect(() => {
    const onDragEnter = (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      dragCounterRef.current++;
      setIsDragging(true);
    };
    const onDragLeave = () => {
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragging(false);
      }
    };
    const onDragOver = (e) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    };
    const onDrop = (e) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        processFile(file);
      }
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [processFile]);

  // ── Text handlers ─────────────────────────────────────────────────────────────
  const handleInput = (e) => {
    setValue(e.target.value);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }
  };

  const handleSend = () => {
    if (disabled) return;
    const trimmed = value.trim();
    if (!trimmed && !attachedImage) return;

    // ── ROUTING DECISION ──────────────────────────────────────────────────────
    // Image + edit-intent text → image editing pipeline (/api/image/edit)
    // Image only (no text)    → image analysis pipeline (/api/analyze-image)
    // Text only               → chat pipeline (/api/chat → Gemini)
    // Image + non-edit text   → both chat and analysis fire independently
    // ─────────────────────────────────────────────────────────────────────────
    if (attachedImage && trimmed && hasEditIntent(trimmed)) {
      if (onSendImageEdit) {
        onSendImageEdit(attachedImage, trimmed);
        setValue('');
        setAttachedImage(null);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        return; // ← hard stop: do NOT also fire onSend or onSendImage
      }
    }

    // Default paths (unmodified behaviour)
    if (trimmed) {
      onSend(trimmed);
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }

    if (attachedImage && onSendImage) {
      onSendImage(attachedImage);
      setAttachedImage(null);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClear = () => {
    if (showClearConfirm) {
      onClear();
      setShowClearConfirm(false);
      setAttachedImage(null);
    } else {
      setShowClearConfirm(true);
      setTimeout(() => setShowClearConfirm(false), 3000);
    }
  };

  // ── File input handler ────────────────────────────────────────────────────────
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = ''; // reset so same file can be re-selected
  };

  // ── Voice input (Web Speech API) ─────────────────────────────────────────────
  const handleVoice = useCallback(() => {
    if (!speechSupported) return;

    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SR();
    recognition.lang             = 'en-US';
    recognition.interimResults   = false;
    recognition.maxAlternatives  = 1;
    recognition.continuous       = false;

    recognition.onstart  = () => setIsListening(true);
    recognition.onend    = () => { setIsListening(false); recognitionRef.current = null; };
    recognition.onerror  = () => { setIsListening(false); recognitionRef.current = null; };
    recognition.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? '';
      if (transcript) setValue(prev => prev ? `${prev} ${transcript}` : transcript);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [isListening, speechSupported]);

  // Stop recognition if the component unmounts while listening
  useEffect(() => () => { recognitionRef.current?.stop(); }, []);

  const canSend = (value.trim().length > 0 || attachedImage !== null) && !disabled;

  return (
    <>
      {/* Full-screen drag overlay */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center pointer-events-none"
          >
            <div className="flex flex-col items-center gap-3 p-8 rounded-2xl border-2 border-dashed border-primary/50 bg-primary/5">
              <ImagePlus size={32} className="text-primary" />
              <p className="text-sm font-medium text-foreground">Drop image to analyze</p>
              <p className="text-xs text-muted-foreground">JPEG, PNG, WebP or GIF · Max 4 MB</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={handleFileChange}
        aria-label="Upload image"
      />

      <div className="px-4 pb-5 pt-3">
        {/* Image error */}
        <AnimatePresence>
          {imageError && (
            <motion.div
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: 'auto', marginBottom: 8 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2"
            >
              <AlertCircle size={11} className="shrink-0" />
              {imageError}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Image preview strip */}
        <AnimatePresence>
          {attachedImage && (
            <motion.div
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: 'auto', marginBottom: 8 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              transition={{ duration: 0.18 }}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-secondary/60 border border-border"
            >
              <div className="relative shrink-0">
                <img
                  src={attachedImage.previewUrl}
                  alt="Preview"
                  className="w-10 h-10 rounded-lg object-cover border border-border"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground font-medium truncate">
                  {attachedImage.filename}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                  {value.trim() && hasEditIntent(value.trim()) ? (
                    <><Wand2 size={9} className="text-primary" /> Ready to edit</>
                  ) : (
                    'Ready to analyze'
                  )}
                </p>
              </div>
              <button
                onClick={() => setAttachedImage(null)}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
                aria-label="Remove image"
              >
                <X size={13} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main input container */}
        <motion.div
          animate={{
            boxShadow: focused
              ? '0 0 0 1px hsl(217 91% 60% / 0.4), 0 4px 20px rgba(0,0,0,0.2)'
              : '0 4px 20px rgba(0,0,0,0.14)',
          }}
          transition={{ duration: 0.15 }}
          className="relative rounded-2xl glass-input overflow-hidden"
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={disabled}
            rows={1}
            data-testid="input-message"
            placeholder="Message IB AI Assistant… or drop an image"
            className="w-full bg-transparent text-foreground text-sm placeholder:text-muted-foreground/60 resize-none outline-none px-4 py-3.5 pr-28 leading-relaxed disabled:opacity-50"
            style={{ maxHeight: '120px', minHeight: '52px' }}
          />

          <div className="absolute right-2 bottom-2 flex items-center gap-1">
            {/* Voice input — only rendered when browser supports Web Speech API */}
            {speechSupported && (
              <button
                type="button"
                onClick={handleVoice}
                disabled={disabled}
                title={isListening ? 'Stop recording' : 'Voice input'}
                className={`p-2 rounded-xl transition-all ${
                  isListening
                    ? 'text-red-400 bg-red-400/10 animate-pulse'
                    : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-secondary disabled:opacity-30'
                }`}
              >
                {isListening ? <MicOff size={14} /> : <Mic size={14} />}
              </button>
            )}

            {/* Image upload button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              data-testid="button-upload-image"
              title="Upload image for analysis"
              className={`p-2 rounded-xl transition-all ${
                attachedImage
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-secondary disabled:opacity-30'
              }`}
            >
              <ImagePlus size={14} />
            </button>

            {/* Clear chat button */}
            <button
              onClick={handleClear}
              data-testid="button-clear-chat"
              className={`p-2 rounded-xl transition-all text-xs font-medium ${
                showClearConfirm
                  ? 'bg-destructive/20 text-destructive border border-destructive/30'
                  : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-secondary'
              }`}
              title={showClearConfirm ? 'Click again to confirm' : 'Clear chat'}
            >
              {showClearConfirm ? (
                <span className="px-1">Clear?</span>
              ) : (
                <Trash2 size={14} />
              )}
            </button>

            {/* Stop / Send button */}
            {disabled && onStop ? (
              <button
                onClick={onStop}
                data-testid="button-stop"
                title="Stop generation"
                className="p-2 rounded-xl transition-all bg-destructive/15 text-destructive hover:bg-destructive/25 active:scale-95"
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!canSend}
                data-testid="button-send"
                className={`p-2 rounded-xl transition-all ${
                  canSend
                    ? 'bg-primary text-primary-foreground hover:opacity-90 active:scale-95'
                    : 'bg-secondary text-muted-foreground/30 cursor-not-allowed'
                }`}
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </motion.div>

        <p className="text-center text-xs text-muted-foreground/40 mt-2">
          Enter to send · Shift + Enter for new line · Drop image anywhere
        </p>
      </div>
    </>
  );
}
