import { useState, useEffect, useCallback, useRef } from 'react';
import { getChats, saveChats, createDefaultChats } from '../utils/storage';
import { streamChat } from '../services/api';
import { analyzeImage } from '../services/imageApi';
import { editImage, generateImage } from '../services/imageToolsApi';
import { extractImagePrompt, detectMode } from '../services/aiEngine';
import { fetchLatestSession } from '../services/chatHistoryApi';

// ── UI error type system ──────────────────────────────────────────────────────
//
// Three-layer architecture:
//   1. UI_ERROR_MESSAGES  — the ONLY strings ever shown to users; keyed by the
//                           7 canonical backend AIErrorCode values (no extras)
//   2. mapBackendErrorToUI — maps backend AIErrorCode → user-safe string (direct
//                           lookup; no intermediate key layer)
//   3. classifyStreamError — maps any thrown error → user-safe string via
//                           mapBackendErrorToUI; never returns raw provider text
//
// Rules enforced by this layer:
//   • No raw error strings, HTTP codes, provider names, or system wording
//     may reach the user through this layer.
//   • classifyStreamError is the ONLY path to produce a user-facing error string.
//   • Error strings are NEVER stored in chat history — errors are transient state.

/** @type {Record<string, string>} */
const UI_ERROR_MESSAGES = {
  rate_limit:              "You're sending messages too fast. Please wait a moment.",
  rate_limit_app:          "You're sending messages too fast. Please wait a moment.",
  rate_limit_provider:     "AI is temporarily busy. Please wait a moment and try again.",
  invalid_request:         "Your message couldn't be processed. Try rephrasing.",
  safety_block:            "This request was blocked by safety filters.",
  timeout:                 "AI is taking too long. Please try again.",
  provider_unavailable:    "AI service is temporarily unavailable.",
  provider_not_configured: "AI service is not configured.",
  internal_error:          "Something went wrong. Please try again.",
};

/**
 * Maps a backend AIErrorCode to a user-safe UI string.
 * Direct lookup into UI_ERROR_MESSAGES — falls back to internal_error.
 * Covers all 7 canonical codes defined in aiOrchestrator.ts.
 * @param {string} code
 * @returns {string}
 */
function mapBackendErrorToUI(code) {
  return UI_ERROR_MESSAGES[code] ?? UI_ERROR_MESSAGES.internal_error;
}

/**
 * Classifies any error thrown by streamChat() into a user-safe UI message.
 *
 * Three phases:
 *   pre-stream  — fetch / HTTP handshake errors (before SSE stream opens)
 *   stream      — STREAM_ERROR:code events emitted inside the SSE loop,
 *                 and coded HTTP errors from api.js (same STREAM_ERROR format)
 *   post-stream — errors thrown after the stream has closed
 *
 * UNAUTHENTICATED and CREDITS_EXHAUSTED are intentionally not mapped here —
 * callers must detect and handle them before calling classifyStreamError.
 *
 * @param {unknown} err
 * @returns {string}
 */
function classifyStreamError(err) {
  const msg  = err?.message ?? '';
  const name = err?.name ?? '';

  // ── Determine stream phase ─────────────────────────────────────────────────
  const phase = msg.includes('STREAM_ERROR')
    ? 'stream'
    : msg.includes('Empty response')
      ? 'post-stream'
      : 'pre-stream';

  // ── Extract backend AIErrorCode (stream phase only) ───────────────────────
  const backendCode = phase === 'stream'
    ? (msg.split('STREAM_ERROR:')[1]?.trim() ?? 'internal_error')
    : null;

  // ── Debug log (never shown to users) ──────────────────────────────────────
  console.debug('[IB AI] classifyStreamError', {
    phase,
    code:    backendCode ?? (name || 'n/a'),
    message: msg,
  });

  // ── AbortError — user-initiated stop or timeout abort ─────────────────────
  // Only fires here when wasAborted is false (i.e. an unintended abort).
  // Intentional Stop-button aborts are handled before calling this function.
  if (name === 'AbortError') {
    return UI_ERROR_MESSAGES.timeout;
  }

  // ── Pre-stream: network failure ────────────────────────────────────────────
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('network')) {
    return UI_ERROR_MESSAGES.internal_error;
  }

  // ── Pre-stream: named codes from api.js ────────────────────────────────────
  // UNAUTHENTICATED / CREDITS_EXHAUSTED handled by caller before reaching here.
  if (msg === 'RATE_LIMITED') {
    return UI_ERROR_MESSAGES.rate_limit;
  }

  // ── Stream-phase: STREAM_ERROR:<code> — covers SSE server errors AND
  //    all coded HTTP errors emitted by api.js (400, 403, 5xx) ─────────────
  if (phase === 'stream') {
    return mapBackendErrorToUI(backendCode);
  }

  // ── Post-stream / catch-all ────────────────────────────────────────────────
  return UI_ERROR_MESSAGES.internal_error;
}

function classifyImageError(err) {
  const msg = err?.message ?? '';
  const name = err?.name ?? '';
  if (name === 'AbortError' || msg.includes('abort') || msg.includes('timeout') || msg.includes('timed out')) {
    return 'Image analysis timed out. Please try a smaller image or try again.';
  }
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
    return 'Network error during image analysis. Check your connection and try again.';
  }
  if (msg.includes('413') || err?.statusCode === 413) {
    return 'Image is too large to analyze. Please use an image under 4 MB.';
  }
  if (msg.includes('502') || msg.includes('504') || err?.statusCode === 504) {
    return 'Image analysis service temporarily unavailable. Please try again.';
  }
  return 'Image analysis failed. Please check your connection and try again.';
}

/**
 * Returns true for connection-level errors that warrant the reconnect loop.
 *
 * Two cases:
 *   TypeError       — fetch() threw before any response (port closed, offline)
 *   connection_error — api.js threw for HTTP 503 from the Vite proxy, which
 *                      happens when the backend is down/restarting and the proxy
 *                      cannot reach port 8099.
 *
 * Intentionally excludes provider_unavailable (AI provider 5xx) and all
 * other stream errors — those are real AI errors, not connection failures.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isConnectionLevelError(err) {
  if (!err) return false;
  if (err.name === 'TypeError') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return (
    msg === 'STREAM_ERROR:connection_error' ||
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('Load failed')
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} username
 * @param {{ onCreditExhausted?: () => void }} [options]
 */
export function useChat(username, { onCreditExhausted } = {}) {
  // Track whether this is a brand-new device (no local chat history).
  // Stored in a ref so it survives the first render and can be read inside
  // the useEffect without needing to be a dependency.
  const isNewDeviceRef = useRef(false);

  // Initialize chatData synchronously from localStorage so activeChatId is
  // stable on the very first render. If we start as null and set it in a
  // useEffect, activeChatId flips null → uuid which forces ChatWindow to
  // remount (key={activeChatId}) and interrupts the stagger animation.
  const [chatData, setChatData] = useState(() => {
    if (!username) return null;
    let data = getChats(username);
    if (!data) {
      isNewDeviceRef.current = true;
      data = createDefaultChats();
      saveChats(username, data);
    }
    return data;
  });

  const [isTyping, setIsTyping] = useState(false);
  const [rateLimitState, setRateLimitState] = useState(null);
  // chatError holds the current transient error string shown to the user.
  // It is NEVER stored in chat history — it resets on the next send, on chat
  // switch/new, or when the user dismisses it.
  const [chatError, setChatError] = useState(null);

  // connectionError: non-null when the last send failed due to a connection-level
  // error (port closed, Vite proxy 503 during backend restart).
  // Shape: { fallbackMsg: string } — the UI message to show if the backend
  // turns out to already be up (AI provider error, not connection error).
  // ChatApp watches this and runs a /api/system/ready reconnect loop.
  const [connectionError, setConnectionError] = useState(null);

  const streamAbortRef = useRef(null);
  const userStopRef   = useRef(false); // true when user explicitly clicks Stop
  // sendingRef prevents a second concurrent send while a stream is in-flight.
  // State-based guards have async timing gaps; a ref fires synchronously.
  const sendingRef    = useRef(false);

  useEffect(() => {
    if (!username) return;

    // If chatData is already populated (sync init succeeded), only run
    // new-device server hydration. Otherwise load from localStorage now
    // (covers the username===undefined-at-mount edge case).
    if (!chatData) {
      let data = getChats(username);
      if (!data) {
        isNewDeviceRef.current = true;
        data = createDefaultChats();
        saveChats(username, data);
      }
      setChatData(data);
    }

    // ── New-device hydration ───────────────────────────────────────────────
    // If this device had no chat history, try to load the latest session
    // from the server. Best-effort — failures are silently ignored.
    if (isNewDeviceRef.current) {
      isNewDeviceRef.current = false;
      fetchLatestSession()
        .then((serverSession) => {
          if (!serverSession?.messages?.length) return;

          const serverMessages = serverSession.messages.map((m) => ({
            id:        m.timestamp,
            role:      m.role,
            content:   m.content ?? '',
            timestamp: new Date(m.timestamp).toISOString(),
          }));

          setChatData((prev) => {
            if (!prev) return prev;
            const activeId = prev.activeChatId;
            if (!activeId) return prev;

            const updated = {
              ...prev,
              chats: {
                ...prev.chats,
                [activeId]: {
                  ...prev.chats[activeId],
                  sessionId: serverSession.id,
                  title:     serverSession.title,
                  messages:  serverMessages,
                },
              },
            };
            saveChats(username, updated);
            return updated;
          });
        })
        .catch((err) => {
          console.warn('[IB AI] Server hydration skipped:', err.message);
        });
    }
  }, [username]);

  useEffect(() => {
    return () => { streamAbortRef.current?.abort(); };
  }, []);

  const persist = useCallback((data) => {
    saveChats(username, data);
    setChatData({ ...data });
  }, [username]);

  const activeChatId = chatData?.activeChatId ?? null;
  const chats = chatData?.chats ?? {};
  const activeChat = activeChatId ? chats[activeChatId] : null;
  const messages = activeChat?.messages ?? [];

  const clearChatError = useCallback(() => setChatError(null), []);

  /**
   * clearConnectionError — dismiss the connection error state.
   *
   * @param {string} [errorToShow] — if provided, set chatError to this string
   *   (used when the backend turns out to be up and the error was AI provider).
   */
  const clearConnectionError = useCallback((errorToShow) => {
    setConnectionError(null);
    if (errorToShow) setChatError(errorToShow);
  }, []);

  const switchChat = useCallback((chatId) => {
    if (!chatData || !chatData.chats[chatId]) return;
    setChatError(null);
    setConnectionError(null);
    persist({ ...chatData, activeChatId: chatId });
  }, [chatData, persist]);

  const newChat = useCallback(() => {
    if (!chatData) return;
    const id = `chat_${Date.now()}`;
    setChatError(null);
    setConnectionError(null);
    persist({
      ...chatData,
      chats: {
        ...chatData.chats,
        [id]: { title: 'New Chat', messages: [], createdAt: Date.now() },
      },
      activeChatId: id,
    });
  }, [chatData, persist]);

  const deleteChat = useCallback((chatId) => {
    if (!chatData) return;
    const remaining = { ...chatData.chats };
    delete remaining[chatId];

    let nextActive = chatData.activeChatId;
    if (nextActive === chatId) {
      const ids = Object.keys(remaining).sort(
        (a, b) => (remaining[b].createdAt ?? 0) - (remaining[a].createdAt ?? 0)
      );
      if (ids.length === 0) {
        const newId = `chat_${Date.now()}`;
        remaining[newId] = { title: 'New Chat', messages: [], createdAt: Date.now() };
        nextActive = newId;
      } else {
        nextActive = ids[0];
      }
    }

    persist({ ...chatData, chats: remaining, activeChatId: nextActive });
  }, [chatData, persist]);

  const renameChat = useCallback((chatId, title) => {
    if (!chatData || !chatData.chats[chatId]) return;
    persist({
      ...chatData,
      chats: {
        ...chatData.chats,
        [chatId]: { ...chatData.chats[chatId], title: title.trim() || 'New Chat' },
      },
    });
  }, [chatData, persist]);

  // ── Text message send ──────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text) => {
    if (!chatData || !activeChatId) return;
    // Synchronous guard: drop the call if a send is already in flight.
    // Prevents double-submit races that React state updates cannot catch.
    if (sendingRef.current) return;
    sendingRef.current = true;

    // ── Image-generation intent intercept ──────────────────────────────────────
    // Phrases like "generate an image of X", "create a picture of Y", "draw me Z"
    // are detected by detectMode() and routed directly to /api/image/generate.
    // Pattern mirrors the image-edit flow exactly: set finalMessages inside
    // try/catch, then call a SINGLE persist(buildState(finalMessages)) after.
    if (detectMode(text) === 'image_generation') {
      const imagePrompt = extractImagePrompt(text);

      const userMsg = {
        id:        Date.now(),
        role:      'user',
        content:   text,
        timestamp: new Date().toISOString(),
      };
      const currentMessages = chatData.chats[activeChatId]?.messages ?? [];
      const updatedMessages  = [...currentMessages, userMsg];

      const currentTitle = chatData.chats[activeChatId]?.title;
      const autoTitle = currentTitle === 'New Chat'
        ? text.slice(0, 36) + (text.length > 36 ? '...' : '')
        : currentTitle;

      const buildImgState = (msgs) => ({
        ...chatData,
        chats: {
          ...chatData.chats,
          [activeChatId]: {
            ...chatData.chats[activeChatId],
            title:    autoTitle,
            messages: msgs,
          },
        },
      });

      persist(buildImgState(updatedMessages));
      setChatError(null);
      setIsTyping(true);

      const aiMsgId  = Date.now() + 1;
      const timestamp = new Date().toISOString();
      let finalMessages = updatedMessages;

      try {
        const result = await generateImage(imagePrompt);
        const b64 = result?.b64Image ?? '';
        if (!b64) throw new Error('Image generation returned no image data — please try again.');
        const src = b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`;
        finalMessages = [
          ...updatedMessages,
          {
            id:        aiMsgId,
            role:      'assistant',
            type:      'image-edit-result',
            content:   src,
            timestamp,
          },
        ];
      } catch (err) {
        console.error('[IB AI] Image generation from chat failed:', err?.message);
        if (err?.code === 'CREDITS_EXHAUSTED') {
          onCreditExhausted?.();
        }
        const userFacingError = err?.code === 'CREDITS_EXHAUSTED'
          ? "You've used all your image generation credits. Your balance resets every 24 hours."
          : `Image generation failed: ${err?.message ?? 'Please try again.'}`;
        finalMessages = [
          ...updatedMessages,
          { id: aiMsgId, role: 'assistant', content: userFacingError, timestamp },
        ];
      } finally {
        setIsTyping(false);
        sendingRef.current = false;
      }

      persist(buildImgState(finalMessages));
      return;
    }

    const streamController = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = streamController;
    let wasAborted = false;
    streamController.signal.addEventListener('abort', () => { wasAborted = true; }, { once: true });

    const userMsg = {
      id: Date.now(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };

    const currentMessages = chatData.chats[activeChatId]?.messages ?? [];
    const updatedMessages = [...currentMessages, userMsg];

    const currentTitle = chatData.chats[activeChatId]?.title;
    const autoTitle =
      currentTitle === 'New Chat'
        ? text.slice(0, 36) + (text.length > 36 ? '...' : '')
        : currentTitle;

    const withUserMsg = {
      ...chatData,
      chats: {
        ...chatData.chats,
        [activeChatId]: {
          ...chatData.chats[activeChatId],
          title: autoTitle,
          messages: updatedMessages,
        },
      },
    };
    persist(withUserMsg);
    setIsTyping(true);

    const aiMsgId = Date.now() + 1;
    const timestamp = new Date().toISOString();

    // Live-streaming state builder (does not include sessionId — that arrives
    // via the session SSE event at the end of the stream).
    const buildState = (content) => ({
      ...withUserMsg,
      chats: {
        ...withUserMsg.chats,
        [activeChatId]: {
          ...withUserMsg.chats[activeChatId],
          messages: [
            ...updatedMessages,
            { id: aiMsgId, role: 'assistant', content, timestamp },
          ],
        },
      },
    });

    const contextMessages = updatedMessages
      .filter((m) => !m.type || m.type === 'text')
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    // Carry the existing session ID and capture any new one assigned by server
    const chatSessionId = chatData.chats[activeChatId]?.sessionId;
    let resolvedSessionId = chatSessionId;

    // Clear any leftover error from a previous attempt before starting a new stream.
    setChatError(null);
    setConnectionError(null);

    let finalContent = '';
    // wasError: true when the stream fails with a genuine error (not a user abort).
    // On error we show a transient chatError banner — the error string is NEVER
    // stored in chat history. withUserMsg (user message only) was already persisted
    // before the stream; on error we simply roll back the live view to it.
    let wasError = false;

    try {
      for await (const chunk of streamChat(contextMessages, {
        sessionId:   chatSessionId,
        onSessionId: (id) => { resolvedSessionId = id; },
        signal:      streamController.signal,
        onRateLimit: (limit, remaining, resetAt) => {
          setRateLimitState({ limit, remaining, resetAt });
        },
      })) {
        finalContent += chunk;
        setChatData(buildState(finalContent));
      }
      if (!finalContent) {
        throw new Error('Empty response from AI');
      }
    } catch (err) {
      if (!wasAborted) {
        wasError = true;
        console.error('[IB AI Assistant] AI request failed:', err.message);

        if (isConnectionLevelError(err)) {
          // Connection-level error — backend down or Vite proxy 503 during restart.
          // ChatApp will run the reconnect loop; do NOT show a static error banner.
          setConnectionError({ fallbackMsg: classifyStreamError(err) });
        } else {
          // AI/auth/rate-limit error — show immediately, never reconnect.
          if (err?.message === 'CREDITS_EXHAUSTED') onCreditExhausted?.();
          setChatError(classifyStreamError(err));
        }
        // Roll back live streaming view (removes in-progress AI bubble).
        setChatData(withUserMsg);
      }
      // wasAborted + userStopRef.current: user hit Stop — finalContent keeps
      // whatever was streamed, committed below as a normal message.
    } finally {
      // Commit when: normal finish OR user explicitly stopped (not unmount/timeout abort)
      const shouldCommit = !wasAborted || userStopRef.current;
      userStopRef.current = false;
      if (shouldCommit) {
        if (!wasError && finalContent) {
          // Success or user-stop with content: persist the AI message to history.
          try {
            persist({
              ...withUserMsg,
              chats: {
                ...withUserMsg.chats,
                [activeChatId]: {
                  ...withUserMsg.chats[activeChatId],
                  sessionId: resolvedSessionId,
                  messages: [
                    ...updatedMessages,
                    { id: aiMsgId, role: 'assistant', content: finalContent, timestamp },
                  ],
                },
              },
            });
          } catch (persistErr) {
            console.error('[IB AI Assistant] Failed to persist message state:', persistErr);
          }
        }
        // On error: withUserMsg already persisted pre-stream; no further action.
        setIsTyping(false);
      }
      sendingRef.current = false;
    }
  }, [chatData, activeChatId, persist, onCreditExhausted]);

  // ── Stop generation (user-initiated) ──────────────────────────────────────
  // Aborts the active stream and commits whatever partial content was streamed.
  const stopGeneration = useCallback(() => {
    if (!streamAbortRef.current) return;
    userStopRef.current = true;
    streamAbortRef.current.abort();
  }, []);

  // ── Regenerate from a message index (edit + re-send) ──────────────────────
  // Trims the conversation to messages[0..index] with the edited user message,
  // then streams a new assistant response. Everything after the edit point is
  // discarded — no duplicate messages, no appended threads.
  const regenerateFrom = useCallback(async (index, newText) => {
    if (!chatData || !activeChatId) return;
    if (sendingRef.current) return;
    sendingRef.current = true;

    streamAbortRef.current?.abort();
    userStopRef.current = false;

    const streamController = new AbortController();
    streamAbortRef.current = streamController;
    let wasAborted = false;
    streamController.signal.addEventListener('abort', () => { wasAborted = true; }, { once: true });

    const currentMessages = chatData.chats[activeChatId]?.messages ?? [];

    const editedUserMsg = {
      ...(currentMessages[index] ?? {}),
      id:        currentMessages[index]?.id ?? Date.now(),
      role:      'user',
      content:   newText,
      timestamp: new Date().toISOString(),
    };

    // Keep messages before the edited point, then add the edited user message
    const trimmedMessages = [...currentMessages.slice(0, index), editedUserMsg];

    const withTrimmed = {
      ...chatData,
      chats: {
        ...chatData.chats,
        [activeChatId]: {
          ...chatData.chats[activeChatId],
          messages: trimmedMessages,
        },
      },
    };
    persist(withTrimmed);
    setIsTyping(true);

    const aiMsgId   = Date.now() + 1;
    const timestamp = new Date().toISOString();

    const buildState = (content) => ({
      ...withTrimmed,
      chats: {
        ...withTrimmed.chats,
        [activeChatId]: {
          ...withTrimmed.chats[activeChatId],
          messages: [
            ...trimmedMessages,
            { id: aiMsgId, role: 'assistant', content, timestamp },
          ],
        },
      },
    });

    const contextMessages = trimmedMessages
      .filter((m) => !m.type || m.type === 'text')
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    const chatSessionId    = chatData.chats[activeChatId]?.sessionId;
    let resolvedSessionId  = chatSessionId;
    let finalContent       = '';
    let wasError           = false;

    setChatError(null);
    setConnectionError(null);

    try {
      for await (const chunk of streamChat(contextMessages, {
        sessionId:   chatSessionId,
        onSessionId: (id) => { resolvedSessionId = id; },
        signal:      streamController.signal,
        onRateLimit: (limit, remaining, resetAt) => {
          setRateLimitState({ limit, remaining, resetAt });
        },
      })) {
        finalContent += chunk;
        setChatData(buildState(finalContent));
      }
      if (!finalContent) throw new Error('Empty response from AI');
    } catch (err) {
      if (!wasAborted) {
        wasError = true;
        console.error('[IB AI Assistant] Regeneration failed:', err.message);
        if (isConnectionLevelError(err)) {
          setConnectionError({ fallbackMsg: classifyStreamError(err) });
        } else {
          if (err?.message === 'CREDITS_EXHAUSTED') onCreditExhausted?.();
          setChatError(classifyStreamError(err));
        }
        setChatData(withTrimmed);
      }
    } finally {
      const shouldCommit = !wasAborted || userStopRef.current;
      userStopRef.current = false;
      if (shouldCommit) {
        if (!wasError && finalContent) {
          try {
            persist({
              ...withTrimmed,
              chats: {
                ...withTrimmed.chats,
                [activeChatId]: {
                  ...withTrimmed.chats[activeChatId],
                  sessionId: resolvedSessionId,
                  messages: [
                    ...trimmedMessages,
                    { id: aiMsgId, role: 'assistant', content: finalContent, timestamp },
                  ],
                },
              },
            });
          } catch (persistErr) {
            console.error('[IB AI Assistant] Failed to persist regenerated state:', persistErr);
          }
        }
        setIsTyping(false);
      }
      sendingRef.current = false;
    }
  }, [chatData, activeChatId, persist, onCreditExhausted]);

  // ── Retry last send (reconnect recovery) ──────────────────────────────────
  //
  // Called by ChatApp's reconnect loop after the backend comes back up.
  // The user's message is ALREADY in chatData (persisted before the stream
  // failed) — this function only streams the AI response for the existing
  // conversation, without re-adding the user message.
  //
  // If the retry also fails with a connection error, setConnectionError is
  // called again so the reconnect loop can restart.
  const retrySend = useCallback(async () => {
    if (!chatData || !activeChatId) return;
    if (sendingRef.current) return;
    sendingRef.current = true;

    const currentMessages = chatData.chats[activeChatId]?.messages ?? [];
    // Safety: only retry when the last message is from the user.
    if (!currentMessages.length || currentMessages[currentMessages.length - 1]?.role !== 'user') {
      sendingRef.current = false;
      return;
    }

    const streamController = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = streamController;
    let wasAborted = false;
    streamController.signal.addEventListener('abort', () => { wasAborted = true; }, { once: true });

    const aiMsgId   = Date.now() + 1;
    const timestamp = new Date().toISOString();
    let finalContent = '';
    let wasError = false;

    const buildState = (content) => ({
      ...chatData,
      chats: {
        ...chatData.chats,
        [activeChatId]: {
          ...chatData.chats[activeChatId],
          messages: [
            ...currentMessages,
            { id: aiMsgId, role: 'assistant', content, timestamp },
          ],
        },
      },
    });

    const contextMessages = currentMessages
      .filter((m) => !m.type || m.type === 'text')
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    const chatSessionId   = chatData.chats[activeChatId]?.sessionId;
    let resolvedSessionId = chatSessionId;

    setChatError(null);
    setIsTyping(true);

    try {
      for await (const chunk of streamChat(contextMessages, {
        sessionId:   chatSessionId,
        onSessionId: (id) => { resolvedSessionId = id; },
        signal:      streamController.signal,
        onRateLimit: (limit, remaining, resetAt) => {
          setRateLimitState({ limit, remaining, resetAt });
        },
      })) {
        finalContent += chunk;
        setChatData(buildState(finalContent));
      }
      if (!finalContent) throw new Error('Empty response from AI');
    } catch (err) {
      if (!wasAborted) {
        wasError = true;
        console.error('[IB AI Assistant] Retry send failed:', err.message);
        if (isConnectionLevelError(err)) {
          // Still can't reach the backend — re-enter reconnect state.
          setConnectionError({ fallbackMsg: classifyStreamError(err) });
        } else {
          if (err?.message === 'CREDITS_EXHAUSTED') onCreditExhausted?.();
          setChatError(classifyStreamError(err));
        }
        setChatData(chatData);
      }
    } finally {
      const shouldCommit = !wasAborted || userStopRef.current;
      userStopRef.current = false;
      if (shouldCommit) {
        if (!wasError && finalContent) {
          try {
            persist({
              ...chatData,
              chats: {
                ...chatData.chats,
                [activeChatId]: {
                  ...chatData.chats[activeChatId],
                  sessionId: resolvedSessionId,
                  messages: [
                    ...currentMessages,
                    { id: aiMsgId, role: 'assistant', content: finalContent, timestamp },
                  ],
                },
              },
            });
          } catch (persistErr) {
            console.error('[IB AI Assistant] Failed to persist retry state:', persistErr);
          }
        }
        setIsTyping(false);
      }
      sendingRef.current = false;
    }
  }, [chatData, activeChatId, persist, onCreditExhausted]);

  // ── Image edit send ────────────────────────────────────────────────────────
  // Called when user attaches an image AND types an edit-intent prompt.
  // Routes to /api/image/edit (HuggingFace instruct-pix2pix) — NOT Gemini.
  // Returns the edited image as a base64 data URL displayed inline in chat.
  const sendImageEdit = useCallback(async ({ base64, mimeType, filename, previewUrl }, editPrompt) => {
    if (!chatData || !activeChatId) return;

    const userMsg = {
      id: Date.now(),
      role: 'user',
      type: 'image-edit-request',
      content: editPrompt,
      imagePreview: previewUrl,
      filename,
      timestamp: new Date().toISOString(),
    };

    const currentMessages = chatData.chats[activeChatId]?.messages ?? [];
    const updatedMessages = [...currentMessages, userMsg];

    const currentTitle = chatData.chats[activeChatId]?.title;
    const autoTitle =
      currentTitle === 'New Chat'
        ? `Edit: ${editPrompt.slice(0, 32)}${editPrompt.length > 32 ? '...' : ''}`
        : currentTitle;

    const withUserMsg = {
      ...chatData,
      chats: {
        ...chatData.chats,
        [activeChatId]: {
          ...chatData.chats[activeChatId],
          title: autoTitle,
          messages: updatedMessages,
        },
      },
    };
    persist(withUserMsg);
    setIsTyping(true);

    const aiMsgId = Date.now() + 1;
    const timestamp = new Date().toISOString();
    let finalMessages = updatedMessages;

    try {
      const dataUrl = `data:${mimeType};base64,${base64}`;
      const result = await editImage(dataUrl, editPrompt);

      if (result.enhancementMode) {
        // Safe Enhancement Mode — FAL_KEY absent or fal.ai unavailable.
        // b64Image is "" — show AI suggestions as a text message instead of a
        // broken/empty image card.
        const header = result.falConfigured === false
          ? 'AI image editing requires a **FAL_KEY** secret (fal.ai) to be configured. Your original image is unchanged.\n\nHere are professional cinematic edit suggestions powered by Gemini AI:'
          : 'Fal.ai image editing is temporarily unavailable. Your original image is unchanged.\n\nHere are professional cinematic edit suggestions powered by Gemini AI:';

        const suggestionLines = (result.suggestions ?? [])
          .map((s, idx) => `${idx + 1}. ${s}`)
          .join('\n');

        const extras = [
          result.colorGrade       ? `**Color Grade:** ${result.colorGrade}` : '',
          result.lightingNotes    ? `**Lighting:** ${result.lightingNotes}` : '',
          result.compositionNotes ? `**Composition:** ${result.compositionNotes}` : '',
        ].filter(Boolean).join('\n');

        const content = [header, suggestionLines, extras].filter(Boolean).join('\n\n');

        finalMessages = [
          ...updatedMessages,
          { id: aiMsgId, role: 'assistant', content, timestamp },
        ];
      } else {
        finalMessages = [
          ...updatedMessages,
          {
            id: aiMsgId,
            role: 'assistant',
            type: 'image-edit-result',
            content: result.b64Image,
            timestamp,
          },
        ];
      }
    } catch (err) {
      console.error('[IB AI Assistant] Image edit failed:', err.message);
      const userFacingError = err.code === 'CREDITS_EXHAUSTED'
        ? "You've used all your image editing credits. Your balance resets every 24 hours."
        : `Image editing failed: ${err.message}`;
      finalMessages = [
        ...updatedMessages,
        { id: aiMsgId, role: 'assistant', content: userFacingError, timestamp },
      ];
    } finally {
      try {
        persist({
          ...withUserMsg,
          chats: {
            ...withUserMsg.chats,
            [activeChatId]: {
              ...withUserMsg.chats[activeChatId],
              messages: finalMessages,
            },
          },
        });
      } catch (persistErr) {
        console.error('[IB AI Assistant] Failed to persist image edit state:', persistErr);
      }
      setIsTyping(false);
    }
  }, [chatData, activeChatId, persist]);

  // ── Image analysis send ────────────────────────────────────────────────────
  const sendImageAnalysis = useCallback(async ({ base64, mimeType, filename }) => {
    if (!chatData || !activeChatId) return;

    const userMsg = {
      id: Date.now(),
      role: 'user',
      type: 'image',
      content: filename,
      timestamp: new Date().toISOString(),
    };

    const currentMessages = chatData.chats[activeChatId]?.messages ?? [];
    const updatedMessages = [...currentMessages, userMsg];

    const currentTitle = chatData.chats[activeChatId]?.title;
    const autoTitle =
      currentTitle === 'New Chat'
        ? `Image: ${filename.slice(0, 28)}`
        : currentTitle;

    const withUserMsg = {
      ...chatData,
      chats: {
        ...chatData.chats,
        [activeChatId]: {
          ...chatData.chats[activeChatId],
          title: autoTitle,
          messages: updatedMessages,
        },
      },
    };
    persist(withUserMsg);
    setIsTyping(true);

    const aiMsgId = Date.now() + 1;
    const timestamp = new Date().toISOString();

    let finalMessages = updatedMessages;

    try {
      const result = await analyzeImage(base64, mimeType);

      const aiMsg = {
        id: aiMsgId,
        role: 'assistant',
        type: 'image-analysis',
        content: JSON.stringify(result),
        timestamp,
      };
      finalMessages = [...updatedMessages, aiMsg];
    } catch (err) {
      console.error('[IB AI Assistant] Image analysis failed:', err.message);

      if (err.code === 'CREDITS_EXHAUSTED') {
        onCreditExhausted?.();
        finalMessages = [
          ...updatedMessages,
          {
            id: aiMsgId,
            role: 'assistant',
            content: "You've reached your free daily limit for image analysis. Upgrade to Pro to continue.",
            timestamp,
          },
        ];
      } else {
        finalMessages = [
          ...updatedMessages,
          {
            id: aiMsgId,
            role: 'assistant',
            content: classifyImageError(err),
            timestamp,
          },
        ];
      }
    } finally {
      try {
        persist({
          ...withUserMsg,
          chats: {
            ...withUserMsg.chats,
            [activeChatId]: {
              ...withUserMsg.chats[activeChatId],
              messages: finalMessages,
            },
          },
        });
      } catch (persistErr) {
        console.error('[IB AI Assistant] Failed to persist image analysis state:', persistErr);
      }
      setIsTyping(false);
    }
  }, [chatData, activeChatId, persist, onCreditExhausted]);

  const clearChat = useCallback(() => {
    if (!chatData || !activeChatId) return;
    setChatError(null);
    setConnectionError(null);
    persist({
      ...chatData,
      chats: {
        ...chatData.chats,
        [activeChatId]: { ...chatData.chats[activeChatId], messages: [] },
      },
    });
  }, [chatData, activeChatId, persist]);

  return {
    chats,
    activeChatId,
    messages,
    isTyping,
    rateLimitState,
    chatError,
    clearChatError,
    connectionError,
    clearConnectionError,
    sendMessage,
    stopGeneration,
    regenerateFrom,
    retrySend,
    sendImageAnalysis,
    sendImageEdit,
    clearChat,
    switchChat,
    newChat,
    deleteChat,
    renameChat,
  };
}
