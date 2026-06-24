import { getAuthHeaders } from '../auth/authService';

const BASE = (import.meta.env.BASE_URL ?? '').replace(/\/$/, '');
const CHAT_URL = `${BASE}/api/chat`;

/**
 * Transcribe a TikTok video via the backend /api/tiktok/transcribe endpoint.
 *
 * ⚠️ BEST-EFFORT — depends on unofficial tikwm.com download proxy.
 * Throws an error with { code: 'feature_unavailable' } when the proxy is down.
 *
 * @param {string} url  Full TikTok URL
 * @returns {Promise<{ success: true, transcript: string, meta: { title: string, author: string, url: string } }>}
 */
export async function transcribeTikTok(url) {
  const response = await fetch(`${BASE}/api/tiktok/transcribe`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body:    JSON.stringify({ url }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.success) {
    const err = Object.assign(
      new Error(data.error ?? 'TikTok transcription unavailable'),
      { code: data.code ?? 'feature_unavailable' },
    );
    throw err;
  }

  return data;
}

// Total timeout covers both the initial TCP/TLS connection AND the full SSE
// stream read. Keeping one timer for the whole lifecycle prevents a stalled
// Gemini mid-stream from hanging the reader indefinitely.
const STREAM_TIMEOUT_MS = 55_000;

/**
 * Stream a chat completion from the API server.
 *
 * Yields string chunks as they arrive from the SSE stream.
 * Calls options.onSessionId(id) when the server emits a session event.
 * Throws a typed Error on network errors, non-2xx responses, or server errors.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ sessionId?: string, onSessionId?: (id: string) => void }} [options]
 * @returns {AsyncGenerator<string>}
 */
export async function* streamChat(messages, options = {}) {
  const { sessionId, onSessionId, signal: externalSignal, onRateLimit } = options;

  // Unique trace ID for this request — logged end-to-end on frontend, backend, and LLM.
  // Retry ownership: ONLY backend llm.ts may retry Gemini. Frontend never retries.
  const requestId = crypto.randomUUID();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  // Link external signal (e.g. unmount cleanup) to our internal controller
  if (externalSignal) {
    if (externalSignal.aborted) { clearTimeout(timer); return; }
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  console.debug('[IB AI] streamChat start', { requestId, sessionId });

  let response;
  try {
    response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
        ...getAuthHeaders(),
      },
      body: JSON.stringify({
        messages,
        ...(sessionId ? { sessionId } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }

  // NOTE: No frontend retry — ONLY backend llm.ts is authorised to retry Gemini.
  // If the backend returns 429, propagate it immediately so the error banner shows.

  if (!response.ok) {
    clearTimeout(timer);
    // Propagate 401/402/429 codes distinctly for the UI to handle.
    // All other failures are mapped to a STREAM_ERROR code — never expose
    // raw HTTP body text to the caller or UI.
    if (response.status === 401) throw new Error('UNAUTHENTICATED');
    if (response.status === 402) throw new Error('CREDITS_EXHAUSTED');
    if (response.status === 429) throw new Error('RATE_LIMITED');
    if (response.status === 400) throw new Error('STREAM_ERROR:invalid_request');
    if (response.status === 403) throw new Error('STREAM_ERROR:provider_not_configured');
    if (response.status === 503) throw new Error('STREAM_ERROR:connection_error');
    if (response.status >= 500)  throw new Error('STREAM_ERROR:provider_unavailable');
    throw new Error('STREAM_ERROR:internal_error');
  }

  // Extract rate-limit headers while we still have the response object
  const rlLimit     = response.headers.get('X-RateLimit-Limit');
  const rlRemaining = response.headers.get('X-RateLimit-Remaining');
  const rlReset     = response.headers.get('X-RateLimit-Reset');
  if (onRateLimit && rlLimit && rlRemaining && rlReset) {
    onRateLimit(parseInt(rlLimit, 10), parseInt(rlRemaining, 10), parseInt(rlReset, 10));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        // SSE comments (e.g. ": connected") — ignore, they are keepalive signals
        if (trimmed.startsWith(':')) continue;

        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        if (parsed.error) {
          throw new Error(`STREAM_ERROR:${parsed.code ?? 'unknown'}`);
        }

        // Session ID event — call callback, do not yield as content
        if (parsed.sessionId && typeof parsed.sessionId === 'string') {
          onSessionId?.(parsed.sessionId);
          continue;
        }

        if (typeof parsed.content === 'string') {
          yield parsed.content;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
