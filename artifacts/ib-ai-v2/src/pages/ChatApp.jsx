import { useState } from 'react';
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
    // Refresh credits display after a successful plan change
    refreshCredits();
  };

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

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0">
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

      {/* Upgrade modal — rendered outside main flow so it never affects SSE state */}
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
