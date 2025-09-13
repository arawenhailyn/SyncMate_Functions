// src/routes/reportUpload.ts
import { Router, Request, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { parse } from "csv-parse/sync";
import pdfParse from "pdf-parse";
import { supabase } from "../lib/supabase"; // if you store raw files; safe to keep even if unused
import { query } from "../db";              // your PG helper: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
import { logger } from "../lib/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ------------------ Gemini Setup (from server.ts) ------------------
const apiKey = process.env.GEMINI_API_KEY;
let genAI: GoogleGenerativeAI | null = null;
if (apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);
} else {
  logger?.warn?.("GEMINI_API_KEY not set; falling back to simple extractor");
}

// ------------------ Types & helpers ------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

type ReportKind = "compliance" | "customers" | "transactions" | "risk";

type ExtractedRule = {
  rule_code?: string | null;
  rule_text: string;
  citations?: string[] | null;
  tags?: string[] | null;
  severity?: string | null;
  effective_date?: string | null;  // YYYY-MM-DD if present
  confidence?: number | null;      // 0..1
};

function sha256(buf: Buffer) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function toStr(v: unknown) { return v === null || v === undefined ? "" : String(v); }
function toNum(v: unknown) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function cleanHeaderKeys<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = {};
  Object.keys(row).forEach((k) => {
    const nk = k.replace(/^\uFEFF/, "").trim();
    out[nk] = (row as any)[k];
  });
  return out as T;
}

function detectCsvKind(filename: string): { kind: ReportKind; entityCode: string; period: string } {
  const base = filename.trim();
  const m = base.match(
    /^(.*?)__(compliance_report|customer_data_report|transaction_report|risk_assessment_report)__(\d{4}-\d{2}-\d{2})\.csv$/i
  );
  if (!m) {
    throw new Error(`CSV filename should match "<entity>__<type>__YYYY-MM-DD.csv": ${filename}`);
  }
  const entityCode = m[1];
  const type = m[2].toLowerCase();
  const period = m[3];
  const kind: ReportKind =
    type === "compliance_report" ? "compliance" :
    type === "customer_data_report" ? "customers" :
    type === "transaction_report" ? "transactions" : "risk";
  return { kind, entityCode, period };
}

function detectPdfMeta(filename: string) {
  // Preferred: "<entity>__policies__YYYY-MM-DD.pdf"
  const base = filename.trim();
  const m = base.match(/^(.*?)__policies__(\d{4}-\d{2}-\d{2})\.pdf$/i);
  if (m) {
    return { entityCode: m[1], period: m[2], title: base.replace(/\.pdf$/i, "") };
  }
  return { entityCode: null as string | null, period: null as string | null, title: base.replace(/\.pdf$/i, "") };
}

// ------------------ Gemini-based Extractor ------------------
async function geminiExtractPolicyRules(text: string): Promise<ExtractedRule[]> {
  if (!genAI) {
    throw new Error("Gemini not initialized");
  }

  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash" });

  const prompt = `
You are a policy extraction expert. Extract structured rules from the following compliance/policy text.
For each rule:
- rule_code: A short unique code (e.g., "SEC-4.2") if present; otherwise null.
- rule_text: The full text of the rule (1-5 sentences max).
- citations: Array of any referenced laws/codes (e.g., ["BSP Circular 123", "PD 456"]); empty array if none.
- tags: Array of keywords/categories (e.g., ["data_privacy", "aml"]); empty array if none.
- severity: "low", "medium", "high", or null.
- effective_date: YYYY-MM-DD if mentioned; otherwise null.
- confidence: 0.0 to 1.0 score of extraction accuracy.

Output ONLY a JSON array of objects matching this structure. No other text.
Limit to 200 rules max.

Text:
${text.slice(0, 100000)}  // Truncate if too long for model limits
`;

  try {
    const result = await model.generateContent(prompt);
    const jsonText = result.response.text().trim().replace(/^```json\n|\n```$/g, '');
    const rules: ExtractedRule[] = JSON.parse(jsonText);
    return rules.filter(r => r.rule_text?.trim());
  } catch (err: any) {
    logger?.error?.(`Gemini extraction failed: ${err.message}`);
    throw err;
  }
}

// Set up external extractor (use Gemini if available, else fallback)
let hasExternalExtractor = !!genAI;
let externalExtractor: (text: string) => Promise<ExtractedRule[]> = genAI ? geminiExtractPolicyRules : fallbackExtractPolicyRules;

// Simple fallback extractor (if Gemini not available)
async function fallbackExtractPolicyRules(text: string): Promise<ExtractedRule[]> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const chunks: string[] = [];
  let curr = "";
  for (const l of lines) {
    if (/^(\*|-|•|\d+[.)])\s+/.test(l) && curr) {
      chunks.push(curr.trim());
      curr = l;
    } else {
      curr = curr ? `${curr} ${l}` : l;
    }
  }
  if (curr) chunks.push(curr.trim());
  const rules = chunks
    .map((t, i) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 20 && /[.]/.test(t))
    .slice(0, 200) // safety cap
    .map((t, i) => ({
      rule_code: `R-${String(i + 1).padStart(3, "0")}`,
      rule_text: t,
      citations: [],
      tags: [],
      severity: null,
      effective_date: null,
      confidence: 0.6,
    }));
  return rules;
}

async function extractPolicyRules(text: string): Promise<ExtractedRule[]> {
  if (hasExternalExtractor && externalExtractor) {
    try { return await externalExtractor(text); } catch (e) { logger?.warn?.(`external extractor failed: ${e}`); }
  }
  return fallbackExtractPolicyRules(text);
}

// ------------------ CSV ingestion ------------------
async function batchInsert(
  textBuilder: (batchSize: number) => string,
  rows: any[],
  paramsBuilder: (row: any) => any[]
) {
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const sql = textBuilder(chunk.length);
    const params = chunk.flatMap(paramsBuilder);
    await query(sql, params);
  }
}

async function insertCompliance(records: Record<string, unknown>[], sourceFile: string) {
  const rows = records.map(cleanHeaderKeys);
  await batchInsert(
    (n) => `
      INSERT INTO compliance_reports (entity, issue_type, description, status, source_file, report_date)
      VALUES ${Array.from({ length: n }, (_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`).join(",")}
      ON CONFLICT (id) DO NOTHING  -- Adjust conflict clause if needed (e.g., on a unique column)
    `,
    rows,
    (r) => [
      toStr(r.entity),
      toStr(r.issue_type),
      toStr(r.description),
      toStr(r.status),
      sourceFile,
      toStr(r.report_date) || new Date().toISOString().slice(0, 10), // Default to current date if not provided
    ]
  );
}

async function insertCustomers(records: Record<string, unknown>[], sourceFile: string) {
  const rows = records.map(cleanHeaderKeys);
  await batchInsert(
    (n) => `
      INSERT INTO customer_data_reports (entity, customer_id, name, account_number, status, source_file, report_date)
      VALUES ${Array.from({ length: n }, (_, i) => `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`).join(",")}
      ON CONFLICT (customer_id) DO UPDATE SET
        entity = EXCLUDED.entity,
        name = EXCLUDED.name,
        account_number = EXCLUDED.account_number,
        status = EXCLUDED.status,
        source_file = EXCLUDED.source_file,
        report_date = EXCLUDED.report_date
    `,
    rows,
    (r) => [
      toStr(r.entity),
      toStr(r.customer_id),
      toStr(r.name),
      toStr(r.account_number),
      toStr(r.status),
      sourceFile,
      toStr(r.report_date) || new Date().toISOString().slice(0, 10), // Default to current date if not provided
    ]
  );
}

async function insertTransactions(records: Record<string, unknown>[], sourceFile: string) {
  const rows = records.map(cleanHeaderKeys);
  await batchInsert(
    (n) => `
      INSERT INTO transaction_data_reports (entity, transaction_id, amount, date, status, source_file, report_date)
      VALUES ${Array.from({ length: n }, (_, i) => `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`).join(",")}
      ON CONFLICT (transaction_id) DO UPDATE SET
        entity = EXCLUDED.entity,
        amount = EXCLUDED.amount,
        date = EXCLUDED.date,
        status = EXCLUDED.status,
        source_file = EXCLUDED.source_file,
        report_date = EXCLUDED.report_date
    `,
    rows,
    (r) => [
      toStr(r.entity),
      toStr(r.transaction_id),
      toNum(r.amount),
      toStr(r.date),
      toStr(r.status),
      sourceFile,
      toStr(r.report_date) || new Date().toISOString().slice(0, 10),
    ]
  );
}

async function insertRisk(records: Record<string, unknown>[], sourceFile: string) {
  const rows = records.map(cleanHeaderKeys);
  await batchInsert(
    (n) => `
      INSERT INTO risk_assessment_reports (entity, risk_id, risk_type, score, mitigation, source_file, report_date)
      VALUES ${Array.from({ length: n }, (_, i) => `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`).join(",")}
      ON CONFLICT (risk_id) DO UPDATE SET
        entity = EXCLUDED.entity,
        risk_type = EXCLUDED.risk_type,
        score = EXCLUDED.score,
        mitigation = EXCLUDED.mitigation,
        source_file = EXCLUDED.source_file,
        report_date = EXCLUDED.report_date
    `,
    rows,
    (r) => [
      toStr(r.entity),
      toStr(r.risk_id),
      toStr(r.risk_type),
      toNum(r.score),
      toStr(r.mitigation),
      sourceFile,
      toStr(r.report_date) || new Date().toISOString().slice(0, 10),
    ]
  );
}

// ------------------ PDF helpers ------------------
async function upsertUploadedFileRow({
  checksum,
  originalName,
  mime,
  size,
  storedPath,
  pageCount,
}: {
  checksum: string;
  originalName: string;
  mime: string;
  size: number;
  storedPath: string | null;
  pageCount: number | null;
}) {
  logger?.info?.(`Attempting to upsert file: ${originalName}, checksum: ${checksum}`);
  const { rows } = await query(
    `
      INSERT INTO uploaded_files (checksum, filename, mime_type, file_size, file_path, page_count)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (checksum) DO UPDATE SET
        filename = EXCLUDED.filename,
        mime_type = EXCLUDED.mime_type,
        file_size = EXCLUDED.file_size,
        file_path = EXCLUDED.file_path,
        page_count = EXCLUDED.page_count
      RETURNING id
    `,
    [checksum, originalName, mime, size, storedPath, pageCount ?? null]
  );
  logger?.info?.(`Upsert result: ${JSON.stringify(rows)}`);
  return rows[0]?.id as string;
}

async function insertPolicyRulesBulk(sourceFileId: string, sourceFilename: string, rules: ExtractedRule[]) {
  if (!rules.length) return;

  // Build parameterized bulk insert
  const cols = "(source_file_id, source_filename, rule_code, rule_text, citations, tags, severity, effective_date, confidence)";
  const batchSize = 500;
  for (let i = 0; i < rules.length; i += batchSize) {
    const chunk = rules.slice(i, i + batchSize);
    const values: string[] = [];
    const params: any[] = [];
    chunk.forEach((r, idx) => {
      const base = idx * 9;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`);
      params.push(
        sourceFileId,
        sourceFilename,
        r.rule_code ?? null,
        r.rule_text,
        (r.citations ?? []) as any,
        (r.tags ?? []) as any,
        r.severity ?? null,
        r.effective_date ?? null,
        r.confidence ?? null
      );
    });

    const sql = `
      INSERT INTO policy_rules ${cols}
      VALUES ${values.join(",")};
    `;
    await query(sql, params);
  }
}

// ------------------ Route ------------------
const router = Router();

/**
 * POST /api/reports/upload   (multipart/form-data, field: "file")
 * - CSVs → ingested to their respective tables
 * - PDFs → stored in uploaded_files + extracted rules → policy_rules
 */
router.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });

    const originalName = req.file.originalname || "upload.bin";
    const mime = req.file.mimetype || "application/octet-stream";
    const ext = (originalName.split(".").pop() || "").toLowerCase();
    const checksum = sha256(req.file.buffer);

    // Optional: upload the raw file to Supabase Storage
    let storedPath: string | null = null;
    try {
      const bucket = process.env.SUPABASE_BUCKET || "reports";
      storedPath = `uploads/${Date.now()}_${originalName}`;
      const { error } = await supabase.storage.from(bucket).upload(storedPath, req.file.buffer, {
        upsert: true,
        contentType: mime,
      });
      if (error) logger?.warn?.(`Supabase upload failed: ${error.message}`);
    } catch (e: any) {
      logger?.warn?.(`Supabase upload error: ${e?.message || e}`);
    }

    // PDF branch → extract rules → policy_rules
    const isPdf = mime === "application/pdf" || ext === "pdf";
    if (isPdf) {
      const parsed = await pdfParse(req.file.buffer);
      const text = (parsed.text || "").trim();
      if (!text) throw new Error("PDF_HAS_NO_SELECTABLE_TEXT");

      // upsert uploaded_files row (idempotent on checksum)
      const fileId = await upsertUploadedFileRow({
        checksum,
        originalName,
        mime,
        size: req.file.size,
        storedPath,
        pageCount: parsed.numpages ?? null,
      });

      // extract rules (Gemini or fallback)
      const rules = (await extractPolicyRules(text))
        .map((r) => ({
          ...r,
          rule_text: (r.rule_text || "").trim(),
          citations: r.citations ?? [],
          tags: r.tags ?? [],
          severity: r.severity ?? null,
          effective_date: r.effective_date ?? null,
          confidence: r.confidence ?? null,
        }))
        .filter((r) => r.rule_text.length > 0);

      // store into policy_rules
      await insertPolicyRulesBulk(fileId, originalName, rules);

      logger?.info?.(`PDF ingested: ${originalName} → ${rules.length} rules`);
      return res.json({
        ok: true,
        kind: "policies",
        filename: originalName,
        uploaded_file_id: fileId,
        pages: parsed.numpages ?? null,
        rules_inserted: rules.length,
        storedPath,
      });
    }

    // Otherwise → CSV to tables
    const { kind, entityCode, period } = detectCsvKind(originalName);

    const records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      trim: true,
    }) as Record<string, unknown>[];

    if (!records.length) return res.status(400).json({ ok: false, error: "EMPTY_CSV" });

    const sourceFile = storedPath || originalName;
    if (kind === "compliance") await insertCompliance(records, sourceFile);
    else if (kind === "customers") await insertCustomers(records, sourceFile);
    else if (kind === "transactions") await insertTransactions(records, sourceFile);
    else await insertRisk(records, sourceFile);

    logger?.info?.(`CSV ingested: ${records.length} ${kind} rows for ${entityCode} ${period}`);
    return res.json({ ok: true, kind, entityCode, period, rows: records.length, storedPath: sourceFile });

  } catch (err: any) {
    logger?.error?.(err);
    return res.status(500).json({ ok: false, error: err?.message || "UPLOAD_INGEST_ERROR" });
  }
});

export { router as reportUploadRouter };