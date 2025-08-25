"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatbotRouter = void 0;
// routes/chatbot.ts
const express_1 = __importDefault(require("express"));
const generative_ai_1 = require("@google/generative-ai");
const db_1 = require("../db");
const admin = __importStar(require("firebase-admin"));
// ───────────────────────────────────────────────────────────────────────────────
// Gemini init
// ───────────────────────────────────────────────────────────────────────────────
const MODEL_ID = process.env.GEMINI_MODEL || "gemini-1.5-flash";
if (!process.env.GEMINI_API_KEY) {
    // Don’t throw at import-time to keep the server booting; we validate per-call.
    console.warn("[chatbot] GEMINI_API_KEY is missing. Requests will fail until it’s set.");
}
const genAI = new generative_ai_1.GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const requireAuth = async (req, res, next) => {
    const sessionCookieName = process.env.SESSION_COOKIE_NAME || "__session";
    const token = req.cookies?.[sessionCookieName] || "";
    try {
        const decoded = await admin.auth().verifySessionCookie(token, true);
        req.user = decoded;
        next();
    }
    catch {
        res.status(401).json({ error: "UNAUTHORIZED" });
    }
};
const router = express_1.default.Router();
exports.chatbotRouter = router;
// ───────────────────────────────────────────────────────────────────────────────
// DB bootstrap (id → uuid, requires pgcrypto for gen_random_uuid())
// ───────────────────────────────────────────────────────────────────────────────
async function initializeChatTables() {
    try {
        await (0, db_1.query)(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
        await (0, db_1.query)(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
        await (0, db_1.query)(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW()
      );
    `);
        await (0, db_1.query)(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);
    `);
        console.log("[chatbot] Chat tables initialized");
    }
    catch (error) {
        console.error("[chatbot] Error initializing chat tables:", error);
    }
}
initializeChatTables();
// ───────────────────────────────────────────────────────────────────────────────
// System prompt + context builders
// ───────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are SyncMate AI Assistant, an expert compliance and data governance assistant for BPI and Ayala Companies. You help users analyze compliance issues, explain resolution workflows, and provide insights about cross-entity data alignment.

Your expertise includes:
- Compliance analysis and resolution playbooks
- Data governance and quality management
- Cross-entity alignment (BPI, Ayala Land, Globe, AC Energy)
- Risk assessment and mitigation
- Data stewardship best practices
- Regulatory compliance (financial + real estate sectors)

Style:
- Clear, actionable steps
- Reference concrete frameworks/policies when helpful
- Prioritize by risk & impact
- Avoid hallucinating; if unknown, say what info is needed.

Current workspace: a Data Team Operational Dashboard tracking compliance issues across BPI/Ayala partnerships.`;
// Pull a compact “recent issues” context if you have such a table (optional)
async function getIssuesContext(userId) {
    try {
        const { rows } = await (0, db_1.query)(`
      SELECT issue_id, issue_type, status, severity
      FROM compliance_issues
      WHERE user_id = $1
      ORDER BY date_created DESC
      LIMIT 12
      `, [userId]);
        if (!rows?.length)
            return "";
        const bullets = rows
            .map((r) => `- ${r.issue_id}: ${r.issue_type} (severity: ${r.severity ?? "n/a"}, status: ${r.status})`)
            .join("\n");
        return `\n\nRecent compliance issues:\n${bullets}`;
    }
    catch {
        // Table may not exist. Keep silent; we’ll just return empty.
        return "";
    }
}
// Pull latest glossary terms to ground the assistant
async function getGlossaryBlock(userId) {
    try {
        const { rows } = await (0, db_1.query)(`
      SELECT term, definition, category
      FROM glossary_terms
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 30
      `, [userId]);
        if (!rows?.length)
            return "";
        const lines = rows
            .map((r) => `- ${r.term}: ${r.definition}${r.category ? ` [${r.category}]` : ""}`)
            .join("\n");
        return `\n\nData Glossary (recent terms):\n${lines}`;
    }
    catch (e) {
        // If the table isn’t present yet, just skip glossary.
        return "";
    }
}
// Static high-level context (you can replace with a DB-driven summary if desired)
async function getComplianceContext(userId) {
    const issues = await getIssuesContext(userId);
    return (`
Compliance landscape snapshot:
- ~23 active issues across BPI partnerships
- Key themes: duplicate records, SME definition mismatches, outdated thresholds
- Collab health: BPI–Ayala Land (92%), BPI–Globe (78%), BPI–AC Energy (95%)
- Resolution rate ~87% (avg 2.3 days)
- High priority: Customer ID reconciliation, unified SME classification, threshold updates
`.trim() + issues);
}
// Generate a short title from first user message
async function generateChatTitle(firstMessage) {
    try {
        if (!process.env.GEMINI_API_KEY)
            throw new Error("No GEMINI_API_KEY");
        const model = genAI.getGenerativeModel({ model: MODEL_ID });
        const result = await model.generateContent(`Generate a concise, descriptive chat title (≤6 words) for this conversation:\n\n"${firstMessage}"`);
        const title = result.response.text().trim().replace(/['"]/g, "");
        return title.slice(0, 50) || "Chat Session";
    }
    catch {
        const s = firstMessage.toLowerCase();
        if (s.includes("compliance"))
            return "Compliance Discussion";
        if (s.includes("issue"))
            return "Issue Resolution";
        if (s.includes("data"))
            return "Data Analysis";
        return "Chat Session";
    }
}
// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────
function sanitizeInput(s, max = 4000) {
    if (typeof s !== "string")
        return null;
    const trimmed = s.trim();
    if (!trimmed)
        return null;
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
// Build the final prompt with system + context + history + latest turn
async function buildPrompt(opts) {
    const { userId, latestUserMessage, history } = opts;
    const glossary = await getGlossaryBlock(userId);
    const comp = await getComplianceContext(userId);
    const formattedHistory = history
        .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
        .join("\n\n");
    return [
        SYSTEM_PROMPT,
        "",
        comp,
        glossary,
        "",
        "Conversation so far:",
        formattedHistory || "(no prior messages)",
        "",
        `Human: ${latestUserMessage}`,
        "Assistant: (Respond as SyncMate—concise, accurate, actionable. If you need data, ask precisely.)",
    ]
        .filter(Boolean)
        .join("\n");
}
// ───────────────────────────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────────────────────────
// 1) Create a new chat session
router.post("/sessions", requireAuth, async (req, res) => {
    try {
        const userId = req.user.uid;
        const titleRaw = typeof req.body?.title === "string" ? req.body.title : "New Chat";
        const title = titleRaw.trim().slice(0, 80) || "New Chat";
        const result = await (0, db_1.query)("INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING *", [userId, title]);
        res.json({ session: result.rows[0] });
    }
    catch (error) {
        console.error("[chatbot] create session:", error);
        res.status(500).json({ error: "Failed to create chat session" });
    }
});
// 2) List sessions (simple pagination: ?limit=20&offset=0)
router.get("/sessions", requireAuth, async (req, res) => {
    try {
        const userId = req.user.uid;
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
        const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
        const result = await (0, db_1.query)(`SELECT * FROM chat_sessions
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT $2 OFFSET $3`, [userId, limit, offset]);
        res.json({ sessions: result.rows });
    }
    catch (error) {
        console.error("[chatbot] list sessions:", error);
        res.status(500).json({ error: "Failed to fetch chat sessions" });
    }
});
// 3) Get messages for a session (pagination optional)
router.get("/sessions/:sessionId/messages", requireAuth, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { sessionId } = req.params;
        const sessionResult = await (0, db_1.query)("SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
        if (sessionResult.rows.length === 0) {
            return res.status(404).json({ error: "Session not found" });
        }
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1), 500);
        const result = await (0, db_1.query)(`SELECT id, role, content, timestamp, session_id, user_id
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY timestamp ASC
       LIMIT $2`, [sessionId, limit]);
        res.json({ messages: result.rows });
    }
    catch (error) {
        console.error("[chatbot] get messages:", error);
        res.status(500).json({ error: "Failed to fetch messages" });
    }
});
// 4) Send user message → get AI reply
router.post("/sessions/:sessionId/messages", requireAuth, async (req, res) => {
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
        }
        const userId = req.user.uid;
        const { sessionId } = req.params;
        const message = sanitizeInput(req.body?.message);
        if (!message) {
            return res.status(400).json({ error: "Message is required" });
        }
        // Check ownership
        const sessionResult = await (0, db_1.query)("SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
        if (sessionResult.rows.length === 0) {
            return res.status(404).json({ error: "Session not found" });
        }
        // Is this the first message?
        const countRes = await (0, db_1.query)("SELECT COUNT(*)::int AS c FROM chat_messages WHERE session_id = $1", [
            sessionId,
        ]);
        const isFirst = (countRes.rows?.[0]?.c ?? 0) === 0;
        // Save user message
        const userMsgRes = await (0, db_1.query)("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ($1, $2, $3, $4) RETURNING *", [sessionId, userId, "user", message]);
        const userMessage = userMsgRes.rows[0];
        // Fetch small history window for grounding (last 20 turns)
        const historyRes = await (0, db_1.query)(`SELECT role, content
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY timestamp ASC
       LIMIT 20`, [sessionId]);
        const history = historyRes.rows.map((r) => ({
            role: r.role,
            content: String(r.content || ""),
        }));
        // Compose prompt
        const prompt = await buildPrompt({
            userId,
            latestUserMessage: message,
            history,
        });
        // Call Gemini
        const model = genAI.getGenerativeModel({
            model: MODEL_ID,
            generationConfig: {
                temperature: 0.6,
                topK: 40,
                topP: 0.8,
                maxOutputTokens: 1024,
            },
        });
        const result = await model.generateContent(prompt);
        const aiText = (result.response?.text() || "").trim() || "I wasn’t able to find enough context to answer.";
        // Save assistant reply
        const aiMsgRes = await (0, db_1.query)("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ($1, $2, $3, $4) RETURNING *", [sessionId, userId, "assistant", aiText]);
        const aiMessage = aiMsgRes.rows[0];
        // Touch session updated_at
        await (0, db_1.query)("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", [sessionId]);
        // If first message, auto‑title session
        if (isFirst) {
            try {
                const newTitle = await generateChatTitle(message);
                await (0, db_1.query)("UPDATE chat_sessions SET title = $1 WHERE id = $2", [newTitle, sessionId]);
            }
            catch (e) {
                console.warn("[chatbot] title generation failed:", e);
            }
        }
        res.json({ userMessage, aiMessage });
    }
    catch (error) {
        console.error("[chatbot] process message:", error);
        res.status(500).json({ error: "Failed to process message" });
    }
});
// 5) Delete a session (and cascade messages)
router.delete("/sessions/:sessionId", requireAuth, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { sessionId } = req.params;
        const result = await (0, db_1.query)("DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2 RETURNING id", [sessionId, userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Session not found" });
        }
        res.json({ success: true });
    }
    catch (error) {
        console.error("[chatbot] delete session:", error);
        res.status(500).json({ error: "Failed to delete chat session" });
    }
});
// 6) Update session title
router.patch("/sessions/:sessionId", requireAuth, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { sessionId } = req.params;
        const title = sanitizeInput(req.body?.title, 120);
        if (!title) {
            return res.status(400).json({ error: "Title is required" });
        }
        const result = await (0, db_1.query)("UPDATE chat_sessions SET title = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *", [title, sessionId, userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Session not found" });
        }
        res.json({ session: result.rows[0] });
    }
    catch (error) {
        console.error("[chatbot] update title:", error);
        res.status(500).json({ error: "Failed to update session title" });
    }
});
// 7) Quick-actions for dashboard shortcuts
router.post("/quick-action", requireAuth, async (req, res) => {
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
        }
        const userId = req.user.uid;
        const action = sanitizeInput(req.body?.action || "", 80) || "general";
        const context = sanitizeInput(req.body?.context || "", 2000) || "";
        let prompt;
        switch (action) {
            case "explain-comp-001":
                prompt = "Explain the duplicate records issue COMP-001: causes, impacts, and step-by-step resolution.";
                break;
            case "resolution-timeline":
                prompt =
                    "Provide a typical resolution timeline for compliance issues, broken down by type and severity with RACI notes.";
                break;
            case "risk-assessment":
                prompt = "Analyze the current risk landscape from active issues and list 3–5 concrete mitigation actions.";
                break;
            case "best-practices":
                prompt =
                    "Share best practices for cross-entity data governance and compliance in financial + real estate contexts.";
                break;
            default:
                prompt = context || "Provide general guidance on compliance and data governance.";
        }
        const comp = await getComplianceContext(userId);
        const glossary = await getGlossaryBlock(userId);
        const model = genAI.getGenerativeModel({ model: MODEL_ID });
        const result = await model.generateContent([
            SYSTEM_PROMPT,
            "",
            comp,
            glossary,
            "",
            `User request: ${prompt}`,
            "Provide a focused, actionable response with short bullet points when useful.",
        ].join("\n"));
        const text = result.response?.text()?.trim() || "No response.";
        res.json({ response: text });
    }
    catch (error) {
        console.error("[chatbot] quick-action:", error);
        res.status(500).json({ error: "Failed to process quick action" });
    }
});
