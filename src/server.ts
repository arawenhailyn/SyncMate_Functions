import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import * as admin from "firebase-admin";
import { Client } from "pg";
import { upsertUser, getUserRole } from "./userRepo";

// --- Firebase Admin init ---
try {
  if (admin.apps.length === 0) {
    // Uses GOOGLE_APPLICATION_CREDENTIALS locally, or platform ADC in cloud
    admin.initializeApp();
  }
} catch (e) {
  console.error("Failed to initialize firebase-admin:", e);
  process.exit(1);
}

const app = express();

// --- Config ---
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "__session";
const SESSION_COOKIE_DAYS = Number(process.env.SESSION_COOKIE_DAYS || 5);
const SESSION_COOKIE_MAX_AGE_MS = SESSION_COOKIE_DAYS * 24 * 60 * 60 * 1000;
const isProd = process.env.NODE_ENV === "production";

// --- CORS ---
const origins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/postman
      if (origins.length === 0 || origins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS not allowed"), false);
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// --- Auth middleware ---
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

// --- Routes ---

// 1) Exchange Firebase ID token -> httpOnly cookie, return role for redirect
app.post("/sessionLogin", async (req, res) => {
  const { idToken, password } = req.body as { idToken?: string; password?: string };
  if (!idToken) return res.status(400).json({ error: "idToken required" });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);

    // Save / update the user (password is optional; only for email+password flow in your demo)
    await upsertUser(decoded, { password });

    const sessionCookie = await admin
      .auth()
      .createSessionCookie(idToken, { expiresIn: SESSION_COOKIE_MAX_AGE_MS });

    res.cookie(SESSION_COOKIE_NAME, sessionCookie, {
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      httpOnly: true,
      secure: isProd, // HTTPS only in prod
      sameSite: "lax",
      path: "/",
    });

    const role = await getUserRole(decoded.uid); // <- fetch role for redirect
    res.json({ ok: true, uid: decoded.uid, role });
  } catch (e: any) {
    console.error("sessionLogin error:", e?.message || e);
    res.status(401).json({ error: "Invalid ID token" });
  }
});

// 2) Logout: clear cookie (+ revoke tokens best-effort)
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
  const role = await getUserRole(u.uid);
  res.json({
    uid: u.uid,
    email: u.email,
    name: u.name,
    email_verified: u.email_verified,
    provider: u.firebase?.sign_in_provider,
    role, // <-- include role
  });
});

// --- DB Test route ---
app.get("/dbping", async (_req, res) => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Supabase SSL
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

app.get("/healthz", (_, res) => res.send("ok"));

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
