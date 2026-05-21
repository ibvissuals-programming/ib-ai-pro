import { useState, useEffect, useCallback, useRef } from 'react';
import { getChats, saveChats, createDefaultChats } from '../utils/storage';
import { streamChat } from '../services/api';
import { analyzeImage } from '../services/imageApi';
import { editImage } from '../services/imageToolsApi';
import { fetchLatestSession } from '../services/chatHistoryApi';

// ── Structured error classifiers ──────────────────────────────────────────────

function classifyStreamError(err) {
  const msg = err?.message ?? '';
  const name = err?.name ?? '';
  if (name === 'AbortError' || msg.includes('aborted') || msg.includes('abort')) {
    return 'Request timed out — the AI took too long to respond. Please try again.';
  }
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('network')) {
    return 'Network error. Check your connection and try again.';
  }
  if (msg.startsWith('API error 5') || msg.includes('502') || msg.includes('503')) {
    return 'AI service temporarily unavailable. Please try again in a moment.';
  }
  if (msg === 'UNAUTHENTICATED') {
    return 'Your session has expired. Please sign in again.';
  }
  if (msg === 'CREDITS_EXHAUSTED') {
    return "You've used all available credits.";
  }
  if (msg === 'RATE_LIMITED') {
    return 'Too many requests. Please wait a moment and try again.';
  }
  if (msg.startsWith('API error 4')) {
    return 'Request rejected by the AI service. Please try again.';
  }
  if (msg.includes('STREAM_ERROR')) {
    const code = msg.split('STREAM_ERROR:')[1] ?? 'unknown';
    if (code === 'provider_unavailable') return 'The AI provider is temporarily unavailable. Please try again.';
    if (code === 'provider_not_configured') return 'This feature requires additional API access.';
    if (code === 'network_timeout') return 'The request took too long. Please retry.';
    return 'AI generation error. Please try again.';
  }
  if (msg.includes('Empty response')) {
    return 'AI returned an empty response. Please try again.';
  }
  if (msg.includes('AI_PROVIDER_VIOLATION')) {
    return 'AI service configuration error. Please contact support.';
  }
  return 'Could not reach the AI. Please check your connection and try again.';
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
      }
    } finally {
      if (!wasAborted) {
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
                  { id: aiMsgId, role: 'assistant', content: finalContent, timestamp },
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
  }, [chatData, activeChatId, persist, username, onCreditExhausted]);

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
    sendImageAnalysis,
    sendImageEdit,
    clearChat,
    switchChat,
    newChat,
    deleteChat,
    renameChat,
  };
}
