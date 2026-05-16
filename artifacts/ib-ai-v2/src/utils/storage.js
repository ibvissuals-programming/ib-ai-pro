// ─── Constants ────────────────────────────────────────────────────────────────

/** Target ceiling for the serialised chat payload written to localStorage.
 *  Browser limit is nominally 5 MB per origin; we stay well below it. */
const SAFE_BYTES = 3 * 1024 * 1024; // 3 MB

/** Hard limit on chat thread count.  Oldest threads are evicted first. */
const MAX_CHATS = 20;

// ─── Generic storage primitives ───────────────────────────────────────────────

export const storage = {
  get: (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  // NOTE: raw set is intentionally kept; quota-safe writes go through saveChats below.
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
  remove: (key) => localStorage.removeItem(key),
};

// ─── Key helpers ──────────────────────────────────────────────────────────────

const chatsKey = (username) => `ib_chats_${username}`;

// ─── Image-payload stripping ──────────────────────────────────────────────────
// Large binary data must never reach localStorage.  These helpers transform
// messages before serialisation so only lightweight metadata is stored.
// The caller's React state is left untouched so in-session display is unaffected.

/** Strip large binary fields from a single message.  Idempotent. */
function stripMessagePayload(msg) {
  // Edited-image result — the output image is often 700 KB – 2 MB
  if (msg.type === 'image-edit-result') {
    if (msg.contentExpired) return msg; // already stripped
    const { content: _dropped, ...rest } = msg;
    return { ...rest, content: null, contentExpired: true };
  }
  // Edit request — imagePreview is the full input image data URL
  if (msg.type === 'image-edit-request') {
    if (!msg.imagePreview) return msg; // already stripped
    const { imagePreview: _dropped, ...rest } = msg;
    return rest;
  }
  return msg;
}

/** Apply stripMessagePayload across every message in every chat thread. */
function stripAllImagePayloads(data) {
  const chats = {};
  for (const [id, chat] of Object.entries(data.chats ?? {})) {
    chats[id] = {
      ...chat,
      messages: (chat.messages ?? []).map(stripMessagePayload),
    };
  }
  return { ...data, chats };
}

// ─── Size-based pruning ───────────────────────────────────────────────────────

/** Serialised byte count of an arbitrary value. */
function byteSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Remove oldest chat threads (by createdAt) until the payload fits targetBytes.
 *  The active chat is always preserved. */
function pruneToFit(data, targetBytes) {
  const pruned = { ...data, chats: { ...data.chats } };

  const sorted = Object.entries(pruned.chats).sort(
    ([, a], [, b]) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );

  for (const [id] of sorted) {
    if (byteSize(pruned) <= targetBytes) break;
    if (id === pruned.activeChatId) continue; // never evict the active chat
    delete pruned.chats[id];
  }

  return pruned;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getChats(username) {
  return storage.get(chatsKey(username)) || null;
}

/**
 * Persist chat state to localStorage with full quota protection:
 *   1. Strip large image payloads (image data URLs) from every message.
 *   2. Enforce MAX_CHATS — evict oldest threads first.
 *   3. Prune further if serialised size still exceeds SAFE_BYTES.
 *   4. Wrap setItem in try/catch; on QuotaExceededError keep only the
 *      active chat and retry once.  A second failure is swallowed —
 *      the UI must never crash because of storage.
 */
export function saveChats(username, data) {
  // Step 1 — strip image binary data
  let safe = stripAllImagePayloads(data);

  // Step 2 — enforce thread-count ceiling (evict oldest)
  const entries = Object.entries(safe.chats ?? {});
  if (entries.length > MAX_CHATS) {
    const sorted = entries.sort(
      ([, a], [, b]) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
    const toEvict = new Set(
      sorted.slice(0, entries.length - MAX_CHATS).map(([id]) => id),
    );
    const trimmed = {};
    for (const [id, chat] of Object.entries(safe.chats)) {
      if (!toEvict.has(id) || id === safe.activeChatId) trimmed[id] = chat;
    }
    safe = { ...safe, chats: trimmed };
  }

  // Step 3 — prune by size if still over the safe threshold
  if (byteSize(safe) > SAFE_BYTES) {
    safe = pruneToFit(safe, SAFE_BYTES);
  }

  // Step 4 — write with quota-error recovery
  //
  // Strategy: remove the old value BEFORE writing the new one.
  // This is essential when localStorage is currently full of old image data —
  // some browsers check (total + new_size > limit) without first subtracting
  // the size of the key being replaced, so the setItem would fail even though
  // the net change is a reduction.  Removing first guarantees free space.
  const key = chatsKey(username);
  const serialized = JSON.stringify(safe);
  try {
    localStorage.removeItem(key);   // free space from old (potentially large) value
    localStorage.setItem(key, serialized);
  } catch (err) {
    const isQuota =
      err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.code === 22;

    if (isQuota) {
      console.warn('[IB storage] QuotaExceededError — emergency prune; keeping active chat only');
      try {
        const emergency = {
          ...safe,
          chats:
            safe.activeChatId && safe.chats[safe.activeChatId]
              ? { [safe.activeChatId]: safe.chats[safe.activeChatId] }
              : {},
        };
        localStorage.removeItem(key);
        localStorage.setItem(key, JSON.stringify(emergency));
      } catch (retryErr) {
        console.error('[IB storage] Emergency save also failed — storage unavailable:', retryErr);
        // Swallow: the app keeps running with in-memory state only.
      }
    } else {
      console.error('[IB storage] Unexpected setItem error:', err);
    }
  }
}

export function setActiveChat(username, chatId) {
  const data = getChats(username);
  if (data) {
    data.activeChatId = chatId;
    saveChats(username, data);
  }
}

export function createDefaultChats() {
  const firstId = `chat_${Date.now()}`;
  return {
    chats: {
      [firstId]: { title: 'New Chat', messages: [], createdAt: Date.now() },
    },
    activeChatId: firstId,
  };
}
