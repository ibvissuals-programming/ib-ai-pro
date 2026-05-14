import { useState, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '../hooks/useAuth';
import { useChat } from '../hooks/useChat';
import { useCredits } from '../hooks/useCredits';
import { Header } from '../components/Header';
import { ChatWindow } from '../components/ChatWindow';
import { InputBox } from '../components/InputBox';
import { Sidebar, MobileSidebar } from '../components/Sidebar';
import { UpgradeModal } from '../components/UpgradeModal';
import { detectMode } from '../services/aiEngine';

const SWIPE_EDGE_PX = 24;   // touch must start within this many px from left edge
const SWIPE_MIN_DX = 60;    // must swipe at least this far right to open

export default function ChatApp() {
  const [, setLocation] = useLocation();
  const { user, logout } = useAuth();

  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const { credits, refresh: refreshCredits } = useCredits(user?.username);

  const {
    chats,
    activeChatId,
    messages,
    isTyping,
    sendMessage,
    sendImageAnalysis,
    clearChat,
    switchChat,
    newChat,
    deleteChat,
    renameChat,
  } = useChat(user?.username, {
    onCreditExhausted: () => setUpgradeModalOpen(true),
  });

  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  const currentMode = lastUserMessage ? detectMode(lastUserMessage.content) : 'chat';

  const handleLogout = () => {
    logout();
    setLocation('/login');
  };

  const handleSwitchChat = (id) => {
    switchChat(id);
    setMobileSidebarOpen(false);
  };

  const handleUpgradeSuccess = () => {
    refreshCredits();
  };

  // ── Swipe-from-left-edge gesture (mobile sidebar) ─────────────────────────
  const swipeTouchStartX = useRef(null);
  const swipeTouchStartY = useRef(null);

  const handleTouchStart = useCallback((e) => {
    const touch = e.touches[0];
    if (touch.clientX <= SWIPE_EDGE_PX) {
      swipeTouchStartX.current = touch.clientX;
      swipeTouchStartY.current = touch.clientY;
    } else {
      swipeTouchStartX.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback((e) => {
    if (swipeTouchStartX.current === null) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - swipeTouchStartX.current;
    const dy = Math.abs(touch.clientY - swipeTouchStartY.current);
    // Only open if it was a primarily horizontal swipe
    if (dx >= SWIPE_MIN_DX && dy < dx * 0.8) {
      setMobileSidebarOpen(true);
    }
    swipeTouchStartX.current = null;
    swipeTouchStartY.current = null;
  }, []);

  const sidebarContent = (
    <Sidebar
      chats={chats}
      activeChatId={activeChatId}
      onSwitch={handleSwitchChat}
      onNew={() => { newChat(); setMobileSidebarOpen(false); }}
      onDelete={deleteChat}
      onRename={renameChat}
      user={user}
      credits={credits}
      onUpgradeClick={() => setUpgradeModalOpen(true)}
    />
  );

  return (
    <div className="flex h-screen bg-background overflow-hidden" data-testid="chat-app">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        {sidebarContent}
      </div>

      {/* Mobile sidebar */}
      <MobileSidebar open={mobileSidebarOpen} onClose={() => setMobileSidebarOpen(false)}>
        {sidebarContent}
      </MobileSidebar>

      {/* Main content — swipe listener for mobile sidebar */}
      <div
        className="flex flex-col flex-1 min-w-0"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <Header
          user={user}
          onLogout={handleLogout}
          currentMode={currentMode}
          onMenuToggle={() => setMobileSidebarOpen(o => !o)}
          mobileSidebarOpen={mobileSidebarOpen}
          activeTitle={activeChatId ? chats[activeChatId]?.title : undefined}
          messages={messages}
        />

        <ChatWindow key={activeChatId} messages={messages} isTyping={isTyping} />

        <InputBox
          onSend={sendMessage}
          onSendImage={sendImageAnalysis}
          onClear={clearChat}
          disabled={isTyping}
        />
      </div>

      {/* Upgrade modal */}
      <UpgradeModal
        open={upgradeModalOpen}
        onClose={() => setUpgradeModalOpen(false)}
        username={user?.username}
        currentPlan={credits?.plan ?? 'free'}
        creditsRemaining={credits?.creditsRemaining ?? 0}
        onUpgradeSuccess={handleUpgradeSuccess}
      />
    </div>
  );
}
