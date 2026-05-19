/**
 * storageFlag — IB AI PostgreSQL storage feature flag.
 *
 * Set USE_POSTGRES_STORAGE=true in the environment to activate PostgreSQL
 * as the primary persistence layer for users and image history.
 *
 * When false (default):  full JSON file system — no change to existing behaviour.
 * When true:             PostgreSQL primary, JSON file fallback on PG error.
 */
export const USE_POSTGRES: boolean =
  process.env["USE_POSTGRES_STORAGE"] === "true";
