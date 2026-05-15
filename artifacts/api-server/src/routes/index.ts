// ╔══════════════════════════════════════════════════════════════════╗
// ║  ROUTE IMMUTABILITY RULE — IB AI Assistant                     ║
// ║  /api/chat is the ONLY streaming AI execution endpoint.        ║
// ║  All streaming chat requests MUST route through POST /api/chat.║
// ║  /api/analyze-image is the vision analysis endpoint (separate).║
// ║  Do NOT add: /api/generate, /api/ai, /api/message, or any      ║
// ║  route that calls createChatStream() as a chat replacement.    ║
// ╚══════════════════════════════════════════════════════════════════╝
import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import chatRouter from "./chat";
import imageAnalysisRouter from "./imageAnalysis";
import creditsRouter from "./credits";
import imageGenRouter from "./imageGen";
import systemRouter from "./system";

const router: IRouter = Router();

router.use(healthRouter);
router.use(systemRouter);
router.use(authRouter);
router.use(chatRouter);
router.use(imageAnalysisRouter);
router.use(creditsRouter);
router.use(imageGenRouter);

export default router;
