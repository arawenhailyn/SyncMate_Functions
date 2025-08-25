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
// server.ts
// Express + Firebase Admin + Postgres + Multer (uploads) + Supabase Storage + Gemini Chatbot
// server.ts
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const morgan_1 = __importDefault(require("morgan"));
const path_1 = __importDefault(require("path"));
const admin = __importStar(require("firebase-admin"));
// --- App + config ------------------------------------------------------------
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT ?? 3000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173"; // TODO: set for prod
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "__session";
// If you use Postgres directly from the API (optional glossary endpoint below)
const pg_1 = require("pg");
const pg = process.env.DATABASE_URL
    ? new pg_1.Pool({
        connectionString: process.env.DATABASE_URL,
        // optional TLS in prod:
        ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : undefined,
    })
    : null;
// --- Firebase Admin init (for cookie-auth’d endpoints like /api/chatbot) -----
if (!admin.apps.length) {
    admin.initializeApp({
        // In local dev, this uses GOOGLE_APPLICATION_CREDENTIALS if set
        credential: admin.credential.applicationDefault(),
    });
}
// --- Middleware --------------------------------------------------------------
app.set("trust proxy", 1); // if behind a proxy (Railway, Render, etc.)
app.use((0, cors_1.default)({
    origin: FRONTEND_ORIGIN,
    credentials: true, // allow cookies
}));
app.use((0, helmet_1.default)());
app.use((0, compression_1.default)());
app.use((0, morgan_1.default)("dev"));
app.use(express_1.default.json({ limit: "2mb" }));
app.use(express_1.default.urlencoded({ extended: false }));
app.use((0, cookie_parser_1.default)());
// --- Auth helper (verifies Firebase session cookie) --------------------------
async function requireAuth(req, res, next) {
    try {
        const cookie = req.cookies?.[SESSION_COOKIE_NAME];
        if (!cookie)
            return res.status(401).json({ error: "No session cookie" });
        const decoded = await admin.auth().verifySessionCookie(cookie, true);
        // attach user info for routes
        req.user = { uid: decoded.uid, email: decoded.email ?? null };
        next();
    }
    catch (err) {
        res.status(401).json({ error: "Invalid or expired session" });
    }
}
// --- Chatbot router (Gemini + sessions/messages) -----------------------------
// Make sure your existing routes/chatbot exports a router named `chatbotRouter`
const express_2 = require("express");
const generative_ai_1 = require("@google/generative-ai");
// You may already have a chatbot router file. If yes, replace this block with:
//   import { chatbotRouter } from "./routes/chatbot";
// and delete the inline router below.
// ----------------- Inline minimal router (use yours if you have one) --------
const chatbotRouter = (0, express_2.Router)();
// Example: POST /api/chatbot/sessions -> create a new chat session
chatbotRouter.post("/sessions", requireAuth, async (req, res) => {
    // Persist a session in your DB here if you want; returning a generated id is fine for demo
    const id = cryptoRandomId();
    res.json({ session: { id, title: req.body?.title ?? "New Chat" } });
});
// Example: POST /api/chatbot/sessions/:id/messages -> send a message to Gemini
chatbotRouter.post("/sessions/:id/messages", requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { message } = req.body;
        if (!message?.trim())
            return res.status(400).json({ error: "Empty message" });
        // Pull last issues/glossary for context (optional)
        let glossaryBlock = "";
        if (pg) {
            const { rows } = await pg.query(`select term, definition, category
         from glossary_terms
         where user_id = $1
         order by updated_at desc
         limit 30`, [req.user.uid]);
            if (rows.length) {
                glossaryBlock =
                    "\n\nData Glossary:\n" +
                        rows.map((r) => `- ${r.term}: ${r.definition}${r.category ? ` [${r.category}]` : ""}`).join("\n");
            }
        }
        // TODO: pull recent compliance issues or other context you want:
        const issuesContext = "Recent compliance context goes here…"; // replace with your own fetch
        // Gemini call
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey)
            return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
        const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash" });
        const prompt = [
            "You are a compliance assistant.",
            "Be concise and actionable.",
            `Context:\n${issuesContext}${glossaryBlock || ""}`,
            `User: ${message}`,
        ].join("\n\n");
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        // TODO: persist user message + assistant message to chat_messages table keyed by session id
        // await pg.query('insert into chat_messages ...', [...])
        res.json({ sessionId: id, response: text });
    }
    catch (err) {
        res.status(500).json({ error: err?.message ?? "Chat error" });
    }
});
// Helper to generate opaque ids for demo; replace with DB ids if you prefer
function cryptoRandomId() {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
// ----------------- End inline router ----------------------------------------
app.use("/api/chatbot", chatbotRouter);
// --- Optional: lightweight glossary read API (frontend can use if needed) ---
if (pg) {
    app.get("/api/glossary", requireAuth, async (req, res) => {
        try {
            const { rows } = await pg.query(`select id, term, definition, category, updated_at
         from glossary_terms
         where user_id = $1
         order by updated_at desc
         limit 100`, [req.user.uid]);
            res.json({ terms: rows });
        }
        catch (e) {
            res.status(500).json({ error: e?.message ?? "Failed to load glossary" });
        }
    });
}
// --- Health + diagnostics ----------------------------------------------------
app.get("/healthz", (_req, res) => {
    res.json({
        ok: true,
        env: {
            NODE_ENV: process.env.NODE_ENV ?? "dev",
            hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
            hasDatabase: Boolean(process.env.DATABASE_URL),
        },
        time: new Date().toISOString(),
    });
});
// --- (Optional) serve your built SPA (Vite/Next export) ---------------------
const __dirname = path_1.default.dirname(__filename);
const STATIC_DIR = path_1.default.join(__dirname, "dist"); // TODO: adjust if your build folder differs
// If you build a SPA into /dist, uncomment below to serve it:
// app.use(express.static(STATIC_DIR));
// app.get("*", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));
// --- 404 & error handlers ----------------------------------------------------
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err, _req, res, _next) => {
    console.error("[UNCAUGHT]", err);
    res.status(500).json({ error: "Unexpected server error" });
});
// --- Start -------------------------------------------------------------------
// ---------- Start ----------
const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
    console.log(`🚀 API server listening on http://localhost:${port}`);
    console.log(`🤖 Chatbot API available at http://localhost:${port}/api/chatbot`);
    console.log(`📊 Dashboard integration ready`);
});
