// ╔══════════════════════════════════════════════════════════════════╗
// ║  ROUTE IMMUTABILITY RULE — IB AI Pro                           ║
// ║  /api/chat is the ONLY streaming AI execution endpoint.        ║
// ║  All streaming chat requests MUST route through POST /api/chat.║
// ║  /api/analyze-image is the vision analysis endpoint (separate).║
// ║  Do NOT add: /api/generate, /api/ai, /api/message, or any      ║
// ║  route that calls createChatStream() as a chat replacement.    ║
// ╚══════════════════════════════════════════════════════════════════╝
import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import imageAnalysisRouter from "./imageAnalysis";
import creditsRouter from "./credits";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chatRouter);
router.use(imageAnalysisRouter);
router.use(creditsRouter);

export default router;
