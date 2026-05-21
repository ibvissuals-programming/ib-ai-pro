/**
 * creatorAnalytics.ts — Creator Workflow Analytics (in-memory)
 *
 * Tracks creator usage patterns without DB writes.
 * Exposed via GET /api/creator/analytics for CEO observability.
 *
 * Funnel: upload → edit → voice → video → export
 */

export type FunnelStep = "upload" | "edit" | "voice" | "video" | "export";

interface Analytics {
  editModeUsage:   Record<string, number>;
  voiceUsage:      Record<string, number>;
  videoModeUsage:  Record<string, number>;
  funnelCounts:    Record<FunnelStep, number>;
  categoryUsage:   Record<string, number>;
  dailyActiveUsers: Set<string>;
  totalWorkflowSaves: number;
  mobileHints:     number;
  desktopHints:    number;
  lastUpdated:     number;
}

const state: Analytics = {
  editModeUsage:     {},
  voiceUsage:        {},
  videoModeUsage:    {},
  funnelCounts:      { upload: 0, edit: 0, voice: 0, video: 0, export: 0 },
  categoryUsage:     {},
  dailyActiveUsers:  new Set(),
  totalWorkflowSaves: 0,
  mobileHints:       0,
  desktopHints:      0,
  lastUpdated:       Date.now(),
};

export function trackEditMode(mode: string): void {
  state.editModeUsage[mode] = (state.editModeUsage[mode] ?? 0) + 1;
  trackFunnel("edit");
  state.lastUpdated = Date.now();
}

export function trackVoiceUsage(voiceStyle: string): void {
  state.voiceUsage[voiceStyle] = (state.voiceUsage[voiceStyle] ?? 0) + 1;
  trackFunnel("voice");
  state.lastUpdated = Date.now();
}

export function trackVideoMode(mode: string): void {
  state.videoModeUsage[mode] = (state.videoModeUsage[mode] ?? 0) + 1;
  trackFunnel("video");
  state.lastUpdated = Date.now();
}

export function trackFunnel(step: FunnelStep): void {
  state.funnelCounts[step] = (state.funnelCounts[step] ?? 0) + 1;
  state.lastUpdated = Date.now();
}

export function trackCategoryUsage(category: string): void {
  state.categoryUsage[category] = (state.categoryUsage[category] ?? 0) + 1;
  state.totalWorkflowSaves++;
  state.lastUpdated = Date.now();
}

export function trackActiveUser(userId: string): void {
  state.dailyActiveUsers.add(userId);
}

export function trackMobileHint(isMobile: boolean): void {
  if (isMobile) state.mobileHints++;
  else state.desktopHints++;
}

function topN(map: Record<string, number>, n = 5): Array<{ key: string; count: number }> {
  return Object.entries(map)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

export function getAnalytics() {
  const totalEdits = Object.values(state.editModeUsage).reduce((s, c) => s + c, 0);
  const totalVoice = Object.values(state.voiceUsage).reduce((s, c) => s + c, 0);
  const totalVideo = Object.values(state.videoModeUsage).reduce((s, c) => s + c, 0);

  const funnelConversion = state.funnelCounts.upload > 0
    ? Math.round((state.funnelCounts.export / state.funnelCounts.upload) * 100)
    : 0;

  return {
    topEditModes:    topN(state.editModeUsage, 5),
    topVoices:       topN(state.voiceUsage, 5),
    topVideoModes:   topN(state.videoModeUsage, 5),
    topCategories:   topN(state.categoryUsage, 6),
    funnel:          state.funnelCounts,
    funnelConversion,
    totals: {
      edits:           totalEdits,
      voiceGenerations: totalVoice,
      videoGenerations: totalVideo,
      workflowSaves:   state.totalWorkflowSaves,
      activeUsers:     state.dailyActiveUsers.size,
    },
    deviceSplit: {
      mobile:  state.mobileHints,
      desktop: state.desktopHints,
    },
    lastUpdated: state.lastUpdated,
  };
}
