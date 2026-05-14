import { useState, useRef, useEffect } from 'react';
import { LogOut, Menu, X, Download, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

function exportChat(messages, title, format) {
  if (!messages || messages.length === 0) return;

  const safeTitle = (title || 'ib-ai-pro-chat').replace(/[^a-z0-9_\-\s]/gi, '').trim().replace(/\s+/g, '-').toLowerCase() || 'ib-ai-pro-chat';

  let content;
  if (format === 'md') {
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    content = `# ${title || 'IB AI Pro Chat'}\n_Exported on ${date}_\n\n---\n\n` +
      messages.map(m => `**${m.role === 'user' ? 'You' : 'IB AI Pro'}**:\n${m.content}`).join('\n\n---\n\n');
  } else {
    content = messages.map(m => `${m.role === 'user' ? 'You' : 'IB AI Pro'}: ${m.content}`).join('\n\n');
  }

  const blob = new Blob([content], { type: format === 'md' ? 'text/markdown' : 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeTitle}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

export function Header({ user, onLogout, currentMode, onMenuToggle, mobileSidebarOpen, activeTitle, messages }) {
  const [exportOpen, setExportOpen] = useState(false);
  const dropdownRef = useRef(null);
  const hasMessages = messages && messages.length > 0;

  useEffect(() => {
    if (!exportOpen) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportOpen]);

  const handleExport = (format) => {
    exportChat(messages, activeTitle, format);
    setExportOpen(false);
  };

  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-10 gap-3">
      {/* Mobile menu toggle */}
      <button
        onClick={onMenuToggle}
        data-testid="button-mobile-menu"
        className="md:hidden p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
      >
        {mobileSidebarOpen ? <X size={16} /> : <Menu size={16} />}
      </button>

      {/* Active chat title */}
      <div className="flex-1 flex items-center gap-2 min-w-0">
        {activeTitle && (
          <span className="text-sm font-medium text-foreground truncate">{activeTitle}</span>
        )}
      </div>

      {/* Mode badge */}
      <div className="flex-shrink-0">
        <AnimatePresence>
          {currentMode === 'prompt_engineering' && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="text-xs px-2.5 py-1 rounded-full border border-purple-500/40 bg-purple-500/10 text-purple-300 font-medium tracking-wide hidden sm:block"
            >
              Prompt Engineering
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Export + User + Logout */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Export dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => hasMessages && setExportOpen(o => !o)}
            data-testid="button-export"
            title={hasMessages ? 'Export chat' : 'No messages to export'}
            className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-md transition-colors ${
              hasMessages
                ? 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                : 'text-muted-foreground/30 cursor-not-allowed'
            }`}
          >
            <Download size={13} />
            <span className="hidden sm:block">Export</span>
          </button>

          <AnimatePresence>
            {exportOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -4 }}
                transition={{ duration: 0.12 }}
                className="absolute right-0 top-full mt-1.5 w-40 rounded-xl border border-border bg-card shadow-lg overflow-hidden z-50"
              >
                <button
                  onClick={() => handleExport('txt')}
                  data-testid="button-export-txt"
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-foreground hover:bg-secondary transition-colors text-left"
                >
                  <FileText size={12} className="text-muted-foreground shrink-0" />
                  Download as .txt
                </button>
                <div className="h-px bg-border mx-2" />
                <button
                  onClick={() => handleExport('md')}
                  data-testid="button-export-md"
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-foreground hover:bg-secondary transition-colors text-left"
                >
                  <FileText size={12} className="text-primary shrink-0" />
                  Download as .md
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <span className="text-xs text-muted-foreground hidden lg:block px-1">{user?.username}</span>

        <button
          onClick={onLogout}
          data-testid="button-logout"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded-md hover:bg-secondary"
        >
          <LogOut size={13} />
          <span className="hidden sm:block">Sign out</span>
        </button>
      </div>
    </header>
  );
}
