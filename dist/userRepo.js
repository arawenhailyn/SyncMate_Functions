"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertUser = upsertUser;
exports.getUserRole = getUserRole;
const db_1 = require("./db");
/**
 * Upserts the user from a Firebase decoded token.
 * - Sets role to 'dataTeam' by default on first insert.
 * - DOES NOT overwrite role on later logins unless you pass opts.role.
 * - Stores plain-text password only for demo (pw). Do not use in production.
 */
async function upsertUser(decoded, opts) {
    const email = decoded.email ?? null;
    const name = decoded.name ?? null;
    const emailVerified = decoded.email_verified ?? null;
    const provider = decoded.firebase?.sign_in_provider ?? null;
    const pw = opts?.password ?? null; // ⚠️ demo only (plain text)
    const role = opts?.role ?? null; // pass to change role on this login
    console.log(`Upserting user: ${decoded.uid}, email: ${email}, name: ${name}`);
    try {
        await (0, db_1.query)(`
  INSERT INTO public.users
    (firebase_uid, email, name, password, email_verified, provider, role, last_login_at)
  VALUES
    (
      $1, $2, $3, $4, $5, $6,
      CASE WHEN $7 IS NULL THEN 'dataTeam' ELSE $7 END,   -- default ON INSERT only
      NOW()
    )
  ON CONFLICT (firebase_uid) DO UPDATE
    SET
      email          = EXCLUDED.email,
      name           = EXCLUDED.name,
      password       = EXCLUDED.password,
      email_verified = EXCLUDED.email_verified,
      provider       = EXCLUDED.provider,
      -- only change role if a new one was explicitly provided this time
      role           = CASE
                         WHEN EXCLUDED.role IS NOT NULL THEN EXCLUDED.role
                         ELSE public.users.role
                       END,
      last_login_at  = NOW()
  RETURNING firebase_uid, email, role
  `, [decoded.uid, email, name, pw, emailVerified, provider, role]);
        console.log(`User upserted successfully: ${decoded.uid}`);
    }
    catch (error) {
        console.error(`Failed to upsert user ${decoded.uid}:`, error);
        throw error;
    }
}
/** Helper to read a user's role for redirects/guards */
async function getUserRole(firebaseUid) {
    try {
        console.log(`Fetching role for user: ${firebaseUid}`);
        const result = await (0, db_1.query)(`SELECT role FROM public.users WHERE firebase_uid = $1`, [firebaseUid]);
        const role = result.rows[0]?.role ?? null;
        console.log(`Role for user ${firebaseUid}: ${role}`);
        return role;
    }
    catch (error) {
        console.error(`Failed to get role for user ${firebaseUid}:`, error);
        throw error;
    }
}
