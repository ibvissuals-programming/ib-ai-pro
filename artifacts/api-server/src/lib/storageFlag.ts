/**
 * storageFlag — re-exports dynamic isPostgresEnabled() from systemConfig.
 *
 * Previously exported a static const USE_POSTGRES. Replaced with a runtime-
 * togglable function so storage mode can be changed via the Control Center
 * without restarting the server.
 *
 * Callers that import directly from this file continue to work unchanged.
 */
export { isPostgresEnabled } from "./systemConfig";
