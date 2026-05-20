/**
 * statsCounter.ts — IB AI Assistant
 *
 * In-memory daily counters for CEO dashboard stats.
 * Counters auto-reset at midnight (day boundary check on each increment).
 * Zero external dependencies — pure in-process memory.
 */

interface DayCounters {
  day: string;            // YYYY-MM-DD
  loginSuccess: number;
  loginFailure: number;
  signupSuccess: number;
  signupFailure: number;
  imageGenerated: number;
  imageGenerateFailed: number;
  imageEdited: number;
  imageEditFailed: number;
  imageAnalyzed: number;
  imageAnalysisFailed: number;
  systemErrors: number;
  authErrors: number;
  chatRequests: number;
  chatMessages: number;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function freshCounters(): DayCounters {
  return {
    day: todayKey(),
    loginSuccess: 0,
    loginFailure: 0,
    signupSuccess: 0,
    signupFailure: 0,
    imageGenerated: 0,
    imageGenerateFailed: 0,
    imageEdited: 0,
    imageEditFailed: 0,
    imageAnalyzed: 0,
    imageAnalysisFailed: 0,
    systemErrors: 0,
    authErrors: 0,
    chatRequests: 0,
    chatMessages: 0,
  };
}

let counters: DayCounters = freshCounters();

/** Ensure counters are for today — rolls over at midnight automatically. */
function ensureToday(): DayCounters {
  if (counters.day !== todayKey()) {
    counters = freshCounters();
  }
  return counters;
}

// ── Increment helpers ─────────────────────────────────────────────────────────

export function incLoginSuccess(): void    { ensureToday().loginSuccess++; }
export function incLoginFailure(): void    { ensureToday().loginFailure++; }
export function incSignupSuccess(): void   { ensureToday().signupSuccess++; }
export function incSignupFailure(): void   { ensureToday().signupFailure++; }
export function incImageGenerated(): void  { ensureToday().imageGenerated++; }
export function incImageGenFailed(): void  { ensureToday().imageGenerateFailed++; }
export function incImageEdited(): void     { ensureToday().imageEdited++; }
export function incImageEditFailed(): void { ensureToday().imageEditFailed++; }
export function incImageAnalyzed(): void   { ensureToday().imageAnalyzed++; }
export function incImageAnalysisFailed(): void { ensureToday().imageAnalysisFailed++; }
export function incSystemError(): void     { ensureToday().systemErrors++; }
export function incAuthError(): void       { ensureToday().authErrors++; }
export function incChatRequest(): void     { ensureToday().chatRequests++; }
export function incChatMessage(): void     { ensureToday().chatMessages++; }

// ── Read ──────────────────────────────────────────────────────────────────────

export function getTodayStats(): DayCounters {
  return { ...ensureToday() };
}

export function getTotalLoginsToday(): number {
  return ensureToday().loginSuccess;
}

export function getTotalChatsToday(): number {
  return ensureToday().chatRequests;
}

export function getTotalMessagesToday(): number {
  return ensureToday().chatMessages;
}

export function getTotalImagesGeneratedToday(): number {
  const c = ensureToday();
  return c.imageGenerated + c.imageEdited + c.imageAnalyzed;
}

export function getTotalErrorsToday(): number {
  const c = ensureToday();
  return c.loginFailure + c.imageGenerateFailed + c.imageEditFailed +
         c.imageAnalysisFailed + c.systemErrors + c.authErrors;
}
