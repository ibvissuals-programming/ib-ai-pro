export const storage = {
  get: (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
  remove: (key) => localStorage.removeItem(key),
};

const chatsKey = (username) => `ib_chats_${username}`;

export function getChats(username) {
  return storage.get(chatsKey(username)) || null;
}

export function saveChats(username, chats) {
  storage.set(chatsKey(username), chats);
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
