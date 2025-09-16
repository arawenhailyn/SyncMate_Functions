// server.ts
// Express + Firebase Admin + Postgres + Gemini Chatbot
import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import * as admin from "firebase-admin";
import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ⬇️ NEW: reports upload router (CSV + PDF policies)
import { reportUploadRouter } from "./routes/reportUpload"; // if you're ESM/NodeNext at runtime, use "./routes/reportUpload.js"

// --- App + config ------------------------------------------------------------
const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173"; // TODO: set for prod
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "__session";

// --- Postgres ---------------------------------------------------------------
const pg =
  process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : undefined,
      })
    : null;

// --- Firebase Admin init ----------------------------------------------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

// --- Middleware --------------------------------------------------------------
app.set("trust proxy", 1);
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);
app.use(helmet());
app.use(compression());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// --- Auth helper -------------------------------------------------------------
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const cookie = req.cookies?.[SESSION_COOKIE_NAME];
    if (!cookie) return res.status(401).json({ error: "No session cookie" });
    const decoded = await admin.auth().verifySessionCookie(cookie, true);
    (req as any).user = { uid: decoded.uid, email: decoded.email ?? null };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

// --- Chatbot router (Gemini + sessions/messages) -----------------------------
const chatbotRouter = Router();

// Create a new chat session
chatbotRouter.post("/sessions", requireAuth, async (req, res) => {
  const id = cryptoRandomId();
  res.json({ session: { id, title: req.body?.title ?? "New Chat" } });
});

// Send a message to Gemini
chatbotRouter.post("/sessions/:id/messages", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body as { message: string };
    if (!message?.trim()) return res.status(400).json({ error: "Empty message" });

    // -------- Build optional context from data_glossary ----------
    let glossaryBlock = "";
    if (pg && !process.env.SKIP_GLOSSARY) {
      try {
        const withUserJoin = await pg.query(
          `
          select dg.term, dg.definition, dg.category
          from data_glossary dg
          join uploaded_files uf on uf.id = dg.source_file_id
          where uf.user_id = $1
          order by dg.created_at desc
          limit 30
        `,
          [(req as any).user.uid]
        );
        if (withUserJoin.rows.length) {
          glossaryBlock =
            "\n\nData Glossary:\n" +
            withUserJoin.rows
              .map((r) => `- ${r.term}: ${r.definition}${r.category ? ` [${r.category}]` : ""}`)
              .join("\n");
        }
      } catch (e: any) {
        if (e?.code === "42703" || e?.code === "42P01") {
          try {
            const generic = await pg.query(
              `
              select term, definition, category
              from data_glossary
              order by created_at desc
              limit 30
            `
            );
            if (generic.rows.length) {
              glossaryBlock =
                "\n\nData Glossary:\n" +
                generic.rows
                  .map((r) => `- ${r.term}: ${r.definition}${r.category ? ` [${r.category}]` : ""}`)
                  .join("\n");
            }
          } catch (e2: any) {
            if (e2?.code !== "42P01") throw e2;
          }
        } else {
          throw e;
        }
      }
    }

    // TODO: replace with your own context fetch
    const issuesContext = "Recent compliance context goes here…";

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash" });

    const prompt = [
      "You are a compliance assistant.",
      "Be concise and actionable.",
      `Context:\n${issuesContext}${glossaryBlock || ""}`,
      `User: ${message}`,
    ].join("\n\n");

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    res.json({ sessionId: id, response: text });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Chat error" });
  }
});

// Helper to generate opaque ids
function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// Mount chatbot router
app.use("/api/chatbot", chatbotRouter);

// --- ⬇️ NEW: mount the reports upload router BEFORE 404 ----------------------
app.use("/api/reports", reportUploadRouter);
// This exposes: POST /api/reports/upload   (field name: "file")

// --- Glossary read API (matches data_glossary shape) -------------------------
if (pg) {
  app.get("/api/glossary", requireAuth, async (req, res) => {
    try {
      try {
        const { rows } = await pg.query(
          `
          select
            dg.id,
            dg.term,
            dg.definition,
            dg.category,
            dg.source_file_id,
            dg.source_columns,
            dg.data_types,
            dg.sample_values,
            dg.synonyms,
            dg.confidence,
            dg.created_at
          from data_glossary dg
          join uploaded_files uf on uf.id = dg.source_file_id
          where uf.user_id = $1
          order by dg.created_at desc
          limit 100
        `,
          [(req as any).user.uid]
        );
        return res.json({ terms: rows });
      } catch (e: any) {
        if (e?.code === "42703" || e?.code === "42P01") {
          const { rows } = await pg.query(
            `
            select
              id, term, definition, category, source_file_id,
              source_columns, data_types, sample_values, synonyms,
              confidence, created_at
            from data_glossary
            order by created_at desc
            limit 100
          `
          );
          return res.json({ terms: rows });
        }
        throw e;
      }
    } catch (e: any) {
      if (e?.code === "42P01") return res.json({ terms: [] });
      res.status(500).json({ error: e?.message ?? "Failed to load glossary" });
    }
  });
}

// --- Health ------------------------------------------------------------------
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

// --- 404 & error handlers ----------------------------------------------------
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[UNCAUGHT]", err);
  res.status(500).json({ error: "Unexpected server error" });
});

// --- Start -------------------------------------------------------------------
const port = Number(process.env.PORT || PORT || 4000);
app.listen(port, () => {
  console.log(`🚀 API server listening on http://localhost:${port}`);
  console.log(`🤖 Chatbot API available at http://localhost:${port}/api/chatbot`);
  console.log(`📤 Reports upload at         http://localhost:${port}/api/reports/upload`);
});
