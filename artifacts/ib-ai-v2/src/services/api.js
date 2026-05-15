import { getAuthHeaders } from '../auth/authService';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const CHAT_URL = `${BASE}/api/chat`;

// Total timeout covers both the initial TCP/TLS connection AND the full SSE
// stream read. Keeping one timer for the whole lifecycle prevents a stalled
// Gemini mid-stream from hanging the reader indefinitely.
const STREAM_TIMEOUT_MS = 55_000;

/**
 * Stream a chat completion from the API server.
 *
 * Yields string chunks as they arrive from the SSE stream.
 * Throws a typed Error on network errors, non-2xx responses, or server errors.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {AsyncGenerator<string>}
 */
export async function* streamChat(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ messages }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timer);
    const body = await response.text().catch(() => '');
    // Propagate 401/402 codes distinctly for the UI to handle
    if (response.status === 401) throw new Error('UNAUTHENTICATED');
    if (response.status === 402) throw new Error('CREDITS_EXHAUSTED');
    throw new Error(`API error ${response.status}: ${body}`);
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
