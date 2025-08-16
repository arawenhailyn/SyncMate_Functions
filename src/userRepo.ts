// userRepo.ts
import type { DecodedIdToken } from "firebase-admin/lib/auth/token-verifier";
import { Client } from "pg";

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
let connected = false;
async function getDb() {
  if (!connected) { await client.connect(); connected = true; }
  return client;
}

export async function upsertUser(decoded: DecodedIdToken, opts?: { password?: string }) {
  const db = await getDb();
  const email = decoded.email ?? null;
  const name = decoded.name ?? null;
  const emailVerified = decoded.email_verified ?? null;
  const provider = decoded.firebase?.sign_in_provider ?? null;
  const pw = opts?.password ?? null; // ⚠️ plain text for demo

  await db.query(
    `
    INSERT INTO public.users (firebase_uid, email, name, password, email_verified, provider, last_login_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (firebase_uid) DO UPDATE
      SET email          = EXCLUDED.email,
          name           = EXCLUDED.name,
          password       = EXCLUDED.password,
          email_verified = EXCLUDED.email_verified,
          provider       = EXCLUDED.provider,
          last_login_at  = NOW()
    `,
    [decoded.uid, email, name, pw, emailVerified, provider]
  );
}
