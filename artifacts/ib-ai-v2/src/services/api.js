const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const CHAT_URL = `${BASE}/api/chat`;

// Total timeout covers both the initial TCP/TLS connection AND the full SSE
// stream read. Keeping one timer for the whole lifecycle prevents a stalled
// Gemini mid-stream from hanging the reader indefinitely.
// 55 s gives Gemini enough time to stream long responses while still bounding
// worst-case wait time for the user.
const STREAM_TIMEOUT_MS = 55_000;

/**
 * Stream a chat completion from the API server.
 *
 * Yields string chunks as they arrive from the SSE stream.
 * Throws a typed Error on network errors, non-2xx responses, or server errors.
 *
 * The AbortController timer is kept alive through the entire stream read so
 * a stalled Gemini stream cannot hang the reader forever.
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: controller.signal,
    });
  } catch (err) {
    // Initial connection failed — clean up and propagate
    clearTimeout(timer);
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timer);
    const body = await response.text().catch(() => '');
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
    // Timer is cleared here — after the full stream — not after the initial
    // fetch. This keeps the AbortController live for the entire read lifecycle.
    clearTimeout(timer);
    reader.releaseLock();
  }
}
