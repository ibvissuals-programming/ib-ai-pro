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
import imageHistoryRouter from "./imageHistory";
import systemRouter from "./system";
import adminRouter from "./admin";
import adminSystemRouter from "./adminSystem";
import aiStatusRouter from "./aiStatus";
import chatHistoryRouter from "./chatHistory";
import memoryRouter from "./memory";
import { trackActivity } from "../middleware/trackActivity";

const router: IRouter = Router();

// Update lastSeenAt for every request that carries a valid token
router.use(trackActivity);

router.use(healthRouter);
router.use(systemRouter);
router.use(authRouter);
router.use(chatRouter);
router.use(imageAnalysisRouter);
router.use(creditsRouter);
router.use(imageGenRouter);
router.use(imageHistoryRouter);
router.use(adminRouter);
router.use(adminSystemRouter);
router.use(aiStatusRouter);
router.use(chatHistoryRouter);
router.use(memoryRouter);

export default router;
