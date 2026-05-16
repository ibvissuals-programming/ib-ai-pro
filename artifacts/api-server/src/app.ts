import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getBootState } from "./lib/bootState";

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

// ── LAYER 6: Root health check — always responds, never behind /api ───────────
// Satisfies external monitors that probe GET /health without the /api prefix.
app.get(["/health", "/healthz"], (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    boot: getBootState(),
  });
});

app.use("/api", router);

export default app;
