/**
 * Credits compatibility layer — IB AI Assistant.
 *
 * Re-exports CREDIT_COSTS from userStore so existing route imports
 * (imageAnalysis.ts etc.) continue to work without modification.
 *
 * All credit logic (checking, deducting, refilling) now lives in userStore.ts.
 * This file is kept thin on purpose — do not add new logic here.
 */
export {
  CREDIT_COSTS,
  FREE_CREDITS,
  RESET_INTERVAL_MS,
  hasCredits,
  deductCredits,
  getUserById,
  getUserByUsername,
} from "./userStore";
