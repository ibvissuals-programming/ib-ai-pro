/**
 * invariant.ts — System-level invariant enforcement.
 *
 * Call logInvariantViolation() whenever a condition that must always be true
 * is found to be false at runtime. These are not expected errors — they
 * indicate a logic bug or data corruption that needs investigation.
 *
 * All violations are logged at ERROR level with the SYSTEM_INVARIANT_VIOLATION
 * prefix so they can be found instantly in any log aggregator.
 *
 * assertInvariant(condition, message) is the zero-throw version:
 * it logs the violation and returns, never crashing the request path.
 */
import { logger } from "./logger";

export function logInvariantViolation(
  message: string,
  context?: Record<string, unknown>,
): void {
  logger.error(
    { INVARIANT: true, ...context },
    `[SYSTEM_INVARIANT_VIOLATION] ${message}`,
  );
}

/**
 * Soft invariant — logs SYSTEM_INVARIANT_VIOLATION but does NOT throw.
 * Use when you want to detect a violation without crashing the request.
 */
export function assertInvariant(
  condition: boolean,
  message: string,
  context?: Record<string, unknown>,
): void {
  if (!condition) {
    logInvariantViolation(message, context);
  }
}

/**
 * Hard invariant — throws if the condition is false.
 * Use only at startup or in paths where continuing is unsafe.
 */
export function requireInvariant(
  condition: boolean,
  message: string,
  context?: Record<string, unknown>,
): asserts condition {
  if (!condition) {
    logInvariantViolation(message, context);
    throw new Error(`SYSTEM_INVARIANT_VIOLATION: ${message}`);
  }
}
