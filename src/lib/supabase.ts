import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // server-only
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "reports";
export const SIGNED_URL_TTL = Number(process.env.SUPABASE_SIGNED_URL_TTL || 3600);
