/**
 * loadEnv.ts — Load .env file before any other module reads process.env.
 *
 * This module MUST be imported as the very first import in index.ts.
 *
 * Load order:
 *   1. Project root .env  (../../.env relative to artifacts/api-server/)
 *   2. Local .env         (./env relative to artifacts/api-server/)
 *
 * override: false — existing process.env values (Replit Secrets) always win.
 * Never throws — missing .env files are silently skipped.
 */

import dotenv from "dotenv";
import { resolve } from "node:path";

const cwd = process.cwd();

dotenv.config({ path: resolve(cwd, "../../.env"), override: false });
dotenv.config({ path: resolve(cwd, ".env"),        override: false });
