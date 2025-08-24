// server.ts
// Express + Firebase Admin + Postgres + Multer (uploads) + Supabase Storage + Gemini Chatbot

import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import * as admin from "firebase-admin";
import { Client } from "pg";
import { upsertUser, getUserRole } from "./userRepo";
import { reportUploadRouter } from "./routes/reportUpload";
import { chatbotRouter } from "./routes/chatbot";

// ---------- Firebase Admin init ----------
try {
  if (admin.apps.length === 0) {
    admin.initializeApp();
  }
} catch (e) {
  console.error("Failed to initialize firebase-admin:", e);
  process.exit(1);
}

const app = express();

// If behind a proxy (Render/Heroku/Nginx), keep this so secure cookies work
app.set("trust proxy", 1);

// ---------- Config ----------
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "__session";
const SESSION_COOKIE_DAYS = Number(process.env.SESSION_COOKIE_DAYS || 5);
const SESSION_COOKIE_MAX_AGE_MS = SESSION_COOKIE_DAYS * 24 * 60 * 60 * 1000;
const isProd = process.env.NODE_ENV === "production";

// Validate required environment variables
const requiredEnvVars = ['GEMINI_API_KEY', 'DATABASE_URL'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// ---------- CORS ----------
const origins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow SSR / curl / same-origin proxy (no Origin header)
      if (!origin) return cb(null, true);
      if (origins.length === 0 || origins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS not allowed"), false);
    },
    credentials: true,
  })
);

// ---------- Body / Cookie parsers ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true })); // good for form posts
app.use(cookieParser());

// ---------- Auth middleware ----------
type AuthedReq = express.Request & { user?: admin.auth.DecodedIdToken };

const requireAuth: express.RequestHandler = async (req: AuthedReq, res, next) => {
  const token = req.cookies[SESSION_COOKIE_NAME] || "";
  try {
    const decoded = await admin.auth().verifySessionCookie(token, true);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED" });
  }
};

// ============================================================================
// Routes
// ============================================================================

// 1) Exchange Firebase ID token -> httpOnly cookie, return role for redirect
app.post("/sessionLogin", async (req, res) => {
  const { idToken, password } = req.body as { idToken?: string; password?: string };
  if (!idToken) return res.status(400).json({ error: "idToken required" });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("Firebase token verified for user:", decoded.uid, decoded.email);

    try {
      await upsertUser(decoded, { password });
      console.log("User upserted successfully:", decoded.uid);
    } catch (dbError: any) {
      console.error("Database upsert error:", dbError);
    }

    const sessionCookie = await admin
      .auth()
      .createSessionCookie(idToken, { expiresIn: SESSION_COOKIE_MAX_AGE_MS });

    res.cookie(SESSION_COOKIE_NAME, sessionCookie, {
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      httpOnly: true,
      secure: isProd,      // set true in production (HTTPS)
      sameSite: "lax",     // "none" if you serve API on a different top-level site with HTTPS
      path: "/",
    });

    let role = "dataTeam";
    try {
      const fetchedRole = await getUserRole(decoded.uid);
      if (fetchedRole) role = fetchedRole;
    } catch (roleError) {
      console.error("Error fetching user role:", roleError);
    }

    res.json({ ok: true, uid: decoded.uid, role });
  } catch (e: any) {
    console.error("sessionLogin error:", e?.message || e);
    res.status(401).json({ error: "Invalid ID token" });
  }
});

// 2) Logout
app.post("/logout", async (req, res) => {
  const cookie = req.cookies[SESSION_COOKIE_NAME];
  if (cookie) {
    try {
      const decoded = await admin.auth().verifySessionCookie(cookie, true);
      await admin.auth().revokeRefreshTokens(decoded.sub);
    } catch {
      // ignore
    }
  }
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
  });
  res.json({ ok: true });
});

// 3) Protected route example (now includes role)
app.get("/me", requireAuth, async (req: AuthedReq, res) => {
  const u = req.user!;
  try {
    const role = await getUserRole(u.uid);
    const payload = {
      uid: u.uid,
      email: u.email,
      name: u.name,
      email_verified: u.email_verified,
      provider: u.firebase?.sign_in_provider,
      role,
    };
    console.log("👉 /me response:", payload);
    res.json(payload);
  } catch (error) {
    console.error("Error in /me route:", error);
    res.status(500).json({ error: "Failed to fetch user data" });
  }
});

// ---------- DB Test route ----------
app.get("/dbping", async (_req, res) => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    const r = await client.query("select now()");
    await client.end();
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e: any) {
    console.error("DB connection failed:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

// ============================================================================
// API Routes
// ============================================================================

// File Upload Routes
app.use("/api/reports", reportUploadRouter);

// Chatbot Routes
app.use("/api/chatbot", chatbotRouter);

// Optional: 404 for unknown API paths (helps spot wrong URLs)
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// ============================================================================
// Error handler (after routes & multer)
// ============================================================================
app.use(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled error:", err?.message || err);
    if (err?.message === "Unsupported file type") {
      return res.status(415).json({ error: "Unsupported file type. Use CSV, Excel, or PDF." });
    }
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large (> 50MB)" });
    }
    if (err?.message === "CORS not allowed") {
      return res.status(403).json({ error: "CORS policy violation" });
    }
    return res.status(500).json({ error: "Internal Server Error" });
  }
);

// ---------- Graceful shutdown ----------
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// ---------- Start ----------
const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`🚀 API server listening on http://localhost:${port}`);
  console.log(`🤖 Chatbot API available at http://localhost:${port}/api/chatbot`);
  console.log(`📊 Dashboard integration ready`);
});