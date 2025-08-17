// src/userRepo.ts
import type { DecodedIdToken } from "firebase-admin/lib/auth/token-verifier";
import { db, query } from "./db";

type Role = "dataTeam" | "teamLead";

/**
 * Upserts the user from a Firebase decoded token.
 * - Sets role to 'dataTeam' by default on first insert.
 * - DOES NOT overwrite role on later logins unless you pass opts.role.
 * - Stores plain-text password only for demo (pw). Do not use in production.
 */
export async function upsertUser(
  decoded: DecodedIdToken,
  opts?: { password?: string; role?: Role }
) {
  const email = decoded.email ?? null;
  const name = decoded.name ?? null;
  const emailVerified = decoded.email_verified ?? null;
  const provider = decoded.firebase?.sign_in_provider ?? null;
  const pw = opts?.password ?? null; // ⚠️ demo only (plain text)
  const role = opts?.role ?? null;   // pass to change role on this login

  console.log(`Upserting user: ${decoded.uid}, email: ${email}, name: ${name}`);

  try {
    await query(
      `
      INSERT INTO public.users
        (firebase_uid, email, name, password, email_verified, provider, role, last_login_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, COALESCE($7, 'dataTeam'), NOW())
      ON CONFLICT (firebase_uid) DO UPDATE
        SET email          = EXCLUDED.email,
            name           = EXCLUDED.name,
            password       = EXCLUDED.password,
            email_verified = EXCLUDED.email_verified,
            provider       = EXCLUDED.provider,
            -- keep existing role unless a new non-null role is provided
            role           = COALESCE(EXCLUDED.role, public.users.role),
            last_login_at  = NOW()
      `,
      [decoded.uid, email, name, pw, emailVerified, provider, role]
    );
    console.log(`User upserted successfully: ${decoded.uid}`);
  } catch (error) {
    console.error(`Failed to upsert user ${decoded.uid}:`, error);
    throw error;
  }
}

/** Helper to read a user's role for redirects/guards */
export async function getUserRole(firebaseUid: string): Promise<Role | null> {
  try {
    console.log(`Fetching role for user: ${firebaseUid}`);
    const result = await query(
      `SELECT role FROM public.users WHERE firebase_uid = $1`,
      [firebaseUid]
    );
    const role = result.rows[0]?.role ?? null;
    console.log(`Role for user ${firebaseUid}: ${role}`);
    return role;
  } catch (error) {
    console.error(`Failed to get role for user ${firebaseUid}:`, error);
    throw error;
  }
}