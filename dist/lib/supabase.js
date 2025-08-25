"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SIGNED_URL_TTL = exports.SUPABASE_BUCKET = exports.supabase = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
exports.supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, // server-only
{ auth: { persistSession: false, autoRefreshToken: false } });
exports.SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "reports";
exports.SIGNED_URL_TTL = Number(process.env.SUPABASE_SIGNED_URL_TTL || 3600);
