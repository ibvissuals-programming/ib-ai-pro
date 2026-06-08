import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Clock, WifiOff } from 'lucide-react';
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

function RateLimitBadge({ remaining, resetAt }) {
  const secLeft = Math.max(0, Math.ceil((resetAt * 1000 - Date.now()) / 1000));
  const isBlocked = remaining === 0;
  return (
    <div className="px-4 pb-1">
      <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border ${
        isBlocked
          ? 'text-rose-400 bg-rose-500/10 border-rose-400/20'
          : 'text-amber-400 bg-amber-500/10 border-amber-400/20'
      }`}>
        <Clock size={9} />
        {isBlocked
          ? `Rate limited — resets in ${secLeft}s`
          : `${remaining} message${remaining === 1 ? '' : 's'} left this minute`}
      </span>
    </div>
  );
}

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
  } = useChat(user?.username, {
    onCreditExhausted: () => setUpgradeModalOpen(true),
  });

  const currentMode = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return detectMode(messages[i].content);
    }
    return 'chat';
  }, [messages]);

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

  // ── Offline detection ──────────────────────────────────────────────────────
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const goOnline  = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener('online',  goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online',  goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

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

        {isOffline && (
          <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/10 border-b border-yellow-400/15 text-[11px] text-yellow-400 shrink-0">
            <WifiOff size={10} />
            Connection interrupted. Retrying…
          </div>
        )}

        <ChatWindow key={activeChatId} messages={messages} isTyping={isTyping} onEditMessage={regenerateFrom} />

        {rateLimitState && rateLimitState.remaining <= 5 && (
          <RateLimitBadge remaining={rateLimitState.remaining} resetAt={rateLimitState.resetAt} />
        )}

        <InputBox
          onSend={sendMessage}
          onSendImage={sendImageAnalysis}
          onSendImageEdit={sendImageEdit}
          onClear={clearChat}
          onStop={stopGeneration}
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
