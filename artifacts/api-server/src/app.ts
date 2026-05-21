import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import healthRouter from "./routes/health";
import { logger } from "./lib/logger";

const app: Express = express();

// Trust the first hop (Replit's reverse proxy) so req.ip returns the real
// client IP instead of the proxy address — required for rate limiting.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Raise JSON body limit to 8 MB to accommodate base64 image payloads sent
// to /api/analyze-image. Default of 100 kb causes 413 on any real image.
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

// ── LAYER 6: Health check — always responds, never behind /api ────────────────
// Mounted before the /api router so monitors and deployment health checks
// always get an accurate connectivity report even if /api middleware fails.
app.use(healthRouter);

app.use("/api", router);

// ── JSON 404 handler ──────────────────────────────────────────────────────────
// Catches any /api/* path that no route matched and returns JSON — never HTML.
// Must be placed AFTER all routes but BEFORE the error handler.
app.use((_req: Request, res: Response): void => {
  res.status(404).json({ error: "Not found" });
});

// ── Global JSON error handler ─────────────────────────────────────────────────
// Catches body-parser SyntaxErrors (malformed request JSON) and any other
// unhandled errors. Ensures every error response is valid JSON — never HTML.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: Request, res: Response, _next: NextFunction): void => {
  // body-parser signals JSON parse failures with type "entity.parse.failed"
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    logger.warn({ err: err.message }, "[app] malformed JSON body rejected");
    res.status(400).json({ error: "Invalid JSON in request body" });
    return;
  }

  const status = err.status ?? err.statusCode ?? 500;
  logger.error({ err: err.message, status }, "[app] unhandled error");
  res.status(status).json({ error: err.message || "Internal server error" });
});

export default app;
