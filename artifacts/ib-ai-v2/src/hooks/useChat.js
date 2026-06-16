import { useState, useEffect, useCallback, useRef } from 'react';
import { getChats, saveChats, createDefaultChats } from '../utils/storage';
import { streamChat } from '../services/api';
import { analyzeImage } from '../services/imageApi';
import { editImage } from '../services/imageToolsApi';
import { fetchLatestSession } from '../services/chatHistoryApi';

// ── UI error type system ──────────────────────────────────────────────────────
//
// Three-layer architecture:
//   1. UI_ERROR_MESSAGES  — the ONLY strings ever shown to users
//   2. mapBackendErrorToUI — maps backend AIErrorCode → UIErrorType key
//   3. classifyStreamError — maps any thrown error → user-safe string
//
// No raw error strings, HTTP codes, provider names, or system wording
// may reach the user through this layer.

/** @type {Record<string, string>} */
const UI_ERROR_MESSAGES = {
  TRY_AGAIN:  'Something went wrong. Please try again.',
  SLOW_DOWN:  "You're going a bit fast. Please wait a moment.",
  BLOCKED:    "I can't help with that request.",
  BAD_INPUT:  "That message doesn't look right. Try rephrasing it.",
  TEMP_DOWN:  'Service is temporarily unavailable. Please try again shortly.',
  UNKNOWN:    'Something went wrong. Please try again.',
};

/**
 * Maps a backend AIErrorCode to a UIErrorType key.
 * Covers every AIErrorCode value defined in aiOrchestrator.ts.
 * Add new cases here when the backend adds new codes.
 * @param {string} code
 * @returns {keyof typeof UI_ERROR_MESSAGES}
 */
function mapBackendErrorToUI(code) {
  switch (code) {
    case 'rate_limit':              return 'SLOW_DOWN';
    case 'safety_block':            return 'BLOCKED';
    case 'invalid_request':         return 'BAD_INPUT';
    case 'timeout':
    case 'provider_unavailable':
    case 'provider_not_configured': return 'TEMP_DOWN';
    case 'internal_error':          return 'TRY_AGAIN';
    default:                        return 'UNKNOWN';
  }
}

/**
 * Classifies any error thrown by streamChat() into a user-safe UI message.
 *
 * Three phases:
 *   pre-stream  — fetch / HTTP handshake errors (before SSE stream opens)
 *   stream      — STREAM_ERROR:code events emitted inside the SSE loop
 *   post-stream — errors thrown after the stream has closed
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
    ? (msg.split('STREAM_ERROR:')[1] ?? 'unknown')
    : null;

  // ── Debug log (never shown to users) ──────────────────────────────────────
  console.debug('[IB AI] classifyStreamError', {
    phase,
    code:    backendCode ?? (name || 'n/a'),
    message: msg,
  });

  // ── Pre-stream: HTTP / network layer ──────────────────────────────────────
  // These fire before the SSE stream opens. Raw technical details are never
  // forwarded — each condition maps to the nearest semantic UI type.
  if (name === 'AbortError' || msg.includes('aborted') || msg.includes('abort')) {
    return UI_ERROR_MESSAGES.TEMP_DOWN;
  }
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('network')) {
    return UI_ERROR_MESSAGES.TRY_AGAIN;
  }
  if (msg.startsWith('API error 5') || msg.includes('502') || msg.includes('503')) {
    return UI_ERROR_MESSAGES.TEMP_DOWN;
  }
  // Named codes emitted by api.js for specific HTTP statuses
  if (msg === 'UNAUTHENTICATED' || msg === 'CREDITS_EXHAUSTED') {
    return UI_ERROR_MESSAGES.UNKNOWN;   // auth / credit flows handle these separately
  }
  if (msg === 'RATE_LIMITED') {
    return UI_ERROR_MESSAGES.SLOW_DOWN;
  }
  // Remaining HTTP 4xx (400 validation, 403 recovery-session, etc.)
  if (msg.startsWith('API error 4')) {
    return UI_ERROR_MESSAGES.TRY_AGAIN;
  }

  // ── Stream-phase: backend AIErrorCode values via SSE ──────────────────────
  if (phase === 'stream') {
    return UI_ERROR_MESSAGES[mapBackendErrorToUI(backendCode)];
  }

  // ── Post-stream and catch-all ──────────────────────────────────────────────
  return UI_ERROR_MESSAGES.TRY_AGAIN;
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

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} username
 * @param {{ onCreditExhausted?: () => void }} [options]
 */
export function useChat(username, { onCreditExhausted } = {}) {
  const [chatData, setChatData] = useState(null);
  const [isTyping, setIsTyping] = useState(false);
  const [rateLimitState, setRateLimitState] = useState(null);
  const streamAbortRef = useRef(null);
  const userStopRef   = useRef(false); // true when user explicitly clicks Stop

  useEffect(() => {
    if (!username) return;

    let data = getChats(username);
    const isNewDevice = !data;

    if (!data) {
      data = createDefaultChats();
      saveChats(username, data);
    }

    setChatData(data);

    // ── New-device hydration ───────────────────────────────────────────────
    // If this device has no chat history at all, try to load the latest
    // session from the server. Best-effort — failures are silently ignored.
    if (isNewDevice) {
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

  const switchChat = useCallback((chatId) => {
    if (!chatData || !chatData.chats[chatId]) return;
    persist({ ...chatData, activeChatId: chatId });
  }, [chatData, persist]);

  const newChat = useCallback(() => {
    if (!chatData) return;
    const id = `chat_${Date.now()}`;
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

    let finalContent = '';
    // Track whether finalContent is an error string so we can tag it with
    // type: 'error'. Error messages tagged this way are excluded from the
    // contextMessages filter (!m.type || m.type === 'text') on the next send,
    // preventing error strings from contaminating the AI's conversation context
    // and causing the "stuck" state.
    let isErrorResponse = false;

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
        console.error('[IB AI Assistant] AI request failed:', err.message);
        finalContent = classifyStreamError(err);
        isErrorResponse = true;
      }
      // If user clicked Stop (wasAborted + userStopRef), finalContent keeps
      // whatever was streamed — no error message, partial content is committed.
    } finally {
      // Commit when: normal finish OR user explicitly stopped (not unmount/timeout abort)
      const shouldCommit = !wasAborted || userStopRef.current;
      userStopRef.current = false;
      if (shouldCommit) {
        try {
          const finalChatState = {
            ...withUserMsg,
            chats: {
              ...withUserMsg.chats,
              [activeChatId]: {
                ...withUserMsg.chats[activeChatId],
                sessionId: resolvedSessionId,
                messages: [
                  ...updatedMessages,
                  {
                    id: aiMsgId,
                    role: 'assistant',
                    content: finalContent,
                    timestamp,
                    ...(isErrorResponse ? { type: 'error' } : {}),
                  },
                ],
              },
            },
          };
          persist(finalChatState);
        } catch (persistErr) {
          console.error('[IB AI Assistant] Failed to persist message state:', persistErr);
        }
        setIsTyping(false);
      }
    }
  }, [chatData, activeChatId, persist]);

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
    let isErrorResponse    = false;

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
        console.error('[IB AI Assistant] Regeneration failed:', err.message);
        finalContent = classifyStreamError(err);
        isErrorResponse = true;
      }
    } finally {
      const shouldCommit = !wasAborted || userStopRef.current;
      userStopRef.current = false;
      if (shouldCommit) {
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
                  {
                    id: aiMsgId,
                    role: 'assistant',
                    content: finalContent,
                    timestamp,
                    ...(isErrorResponse ? { type: 'error' } : {}),
                  },
                ],
              },
            },
          });
        } catch (persistErr) {
          console.error('[IB AI Assistant] Failed to persist regenerated state:', persistErr);
        }
        setIsTyping(false);
      }
    }
  }, [chatData, activeChatId, persist]);

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
    sendMessage,
    stopGeneration,
    regenerateFrom,
    sendImageAnalysis,
    sendImageEdit,
    clearChat,
    switchChat,
    newChat,
    deleteChat,
    renameChat,
  };
}
