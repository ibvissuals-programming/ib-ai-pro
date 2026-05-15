import { useState, useCallback } from 'react';

/**
 * Manages multi-message selection state.
 * Selection mode can be entered via long-press (mobile) or programmatically.
 * Provides copy-to-clipboard and export-as-text for selected messages.
 *
 * Handles all message types safely:
 *   - text: renders as "Role:\nContent"
 *   - image: renders as "Role:\n[Image: filename]"
 *   - image-analysis: renders structured prompts as readable text
 */
export function useSelection(messages) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [copyState, setCopyState] = useState('idle'); // 'idle' | 'copied' | 'error'

  const enterSelectionMode = useCallback((initialId = null) => {
    setSelectionMode(true);
    setSelectedIds(initialId !== null ? new Set([initialId]) : new Set());
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setCopyState('idle');
  }, []);

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(messages.map((m) => m.id)));
  }, [messages]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // ── Type-safe text builder ─────────────────────────────────────────────────
  // Converts each selected message to human-readable text regardless of type.
  // Raw JSON is never exported directly — image-analysis results are rendered
  // as structured plain text so exports are readable.

  const buildText = useCallback(() => {
    return messages
      .filter((m) => selectedIds.has(m.id))
      .map((m) => {
        const role = m.role === 'user' ? 'You' : 'IB AI v3';

        if (m.type === 'image') {
          return `${role}:\n[Image: ${m.content}]`;
        }

        if (m.type === 'image-analysis') {
          try {
            const d = JSON.parse(m.content);
            const a = d?.analysis ?? {};
            const p = d?.prompts ?? {};
            const ie = p.imageEdit ?? {};
            const v = p.variants ?? {};

            const lines = [`${role}: [Visual Analysis]`];

            if (a.subject) lines.push(`Subject: ${a.subject}`);
            if (a.mood) lines.push(`Mood: ${a.mood}`);
            if (a.style) lines.push(`Style: ${a.style}`);

            if (ie.cinematic) lines.push(`\nCinematic Prompt:\n${ie.cinematic}`);
            if (ie.luxury) lines.push(`\nLuxury Prompt:\n${ie.luxury}`);
            if (ie.wallpaper) lines.push(`\nWallpaper Prompt:\n${ie.wallpaper}`);
            if (ie.canva) lines.push(`\nCanva Prompt:\n${ie.canva}`);
            if (ie.tiktok) lines.push(`\nTikTok Prompt:\n${ie.tiktok}`);
            if (p.videoEdit) lines.push(`\nVideo Edit Prompt:\n${p.videoEdit}`);
            if (v.viral) lines.push(`\nViral Variant:\n${v.viral}`);
            if (v.luxuryBrand) lines.push(`\nLuxury Brand Variant:\n${v.luxuryBrand}`);
            if (v.cinematic) lines.push(`\nCinematic Variant:\n${v.cinematic}`);
            if (v.aesthetic) lines.push(`\nAesthetic Variant:\n${v.aesthetic}`);

            return lines.join('\n');
          } catch {
            return `${role}:\n[Image Analysis Result]`;
          }
        }

        // Standard text message
        return `${role}:\n${m.content}`;
      })
      .join('\n\n---\n\n');
  }, [messages, selectedIds]);

  const copySelected = useCallback(async () => {
    if (!selectedIds.size) return;
    const text = buildText();
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2000);
    }
  }, [selectedIds, buildText]);

  const exportSelected = useCallback(() => {
    if (!selectedIds.size) return;
    const text = buildText();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-export-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [selectedIds, buildText]);

  const allSelected = messages.length > 0 && selectedIds.size === messages.length;

  return {
    selectionMode,
    selectedIds,
    selectedCount: selectedIds.size,
    allSelected,
    copyState,
    enterSelectionMode,
    exitSelectionMode,
    toggleSelect,
    selectAll,
    deselectAll,
    copySelected,
    exportSelected,
  };
}
