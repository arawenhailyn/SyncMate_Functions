// src/routes/reportUpload.ts
import { Router, Request, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { parse } from "csv-parse/sync";
import pdfParse from "pdf-parse";
import { supabase } from "../lib/supabase"; // if you store raw files; safe to keep even if unused
import { query } from "../db";              // your PG helper: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
import { logger } from "../lib/config";

// If you already have an extractor, adapt it here:
let hasExternalExtractor = false;
let externalExtractor: null | ((text: string) => Promise<ExtractedRule[]>) = null;

try {
  // Example: either glossaryExtractor exposes createGlossaryExtractor().extractPolicyRules
  // or backgroundGlossaryProcessor exposes a static extraction util.
  // Wire whichever exists in your codebase.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createGlossaryExtractor } = require("../services/glossaryExtractor");
  const gx = createGlossaryExtractor?.();
  if (gx?.extractPolicyRules) {
    hasExternalExtractor = true;
    externalExtractor = async (text: string) => {
      const out = await gx.extractPolicyRules(text);
      // normalize shape below if needed
      return Array.isArray(out) ? out : [];
    };
  }
} catch {
  /* no-op: we’ll fall back to a simple splitter */
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

// Simple fallback extractor (if you haven’t wired your own yet).
// Splits by lines starting with a bullet/number and keeps 1–5 sentence chunks.
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

// ------------------ CSV ingestion (unchanged from your previous version) ------------------
async function batchInsert(
  textBuilder: (batchSize: number) => string,
  rows: any[],
  valuesBuilder: (r: any) => any[],
  batchSize = 1000
) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    if (!chunk.length) continue;
    const sql = textBuilder(chunk.length);
    const params: any[] = [];
    chunk.forEach((r) => params.push(...valuesBuilder(r)));
    await query(sql, params);
  }
}

async function insertCompliance(rows: any[], sourceFile: string) {
  const normalized = rows.map(cleanHeaderKeys).map((r) => ({
    check_id: toStr(r["Check_ID"]),
    policy: toStr(r["Policy"]),
    status: toStr(r["Status"]),
    severity: toStr(r["Severity"]),
    notes: toStr(r["Notes"]),
    checked_by: toStr(r["Checked_By"]),
    checked_at: toStr(r["Checked_At"]),
    entity: toStr(r["Entity"]),
    period: toStr(r["Period"]),
    source_file: sourceFile,
  }));

  await batchInsert(
    (n) => {
      const cols = "(check_id,policy,status,severity,notes,checked_by,checked_at,entity,period,source_file)";
      const groups = Array.from({ length: n }, (_, i) => {
        const base = i * 10;
        return `(${Array.from({ length: 10 }, (_, j) => `$${base + j + 1}`).join(",")})`;
      }).join(",");
      return `
        INSERT INTO compliance_reports ${cols} VALUES ${groups}
        ON CONFLICT (check_id) DO UPDATE
        SET policy=EXCLUDED.policy,
            status=EXCLUDED.status,
            severity=EXCLUDED.severity,
            notes=EXCLUDED.notes,
            checked_by=EXCLUDED.checked_by,
            checked_at=EXCLUDED.checked_at,
            entity=EXCLUDED.entity,
            period=EXCLUDED.period,
            source_file=EXCLUDED.source_file,
            loaded_at=now();
      `;
    },
    normalized,
    (r) => [r.check_id, r.policy, r.status, r.severity, r.notes, r.checked_by, r.checked_at, r.entity, r.period, r.source_file]
  );
}

async function insertCustomers(rows: any[], sourceFile: string) {
  const normalized = rows.map(cleanHeaderKeys).map((r) => ({
    customer_id: toStr(r["Customer_ID"]),
    name: toStr(r["Name"]),
    email: toStr(r["Email"]),
    phone: toStr(r["Phone"]),
    dob: toStr(r["DOB"]),
    account_status: toStr(r["Account_Status"]),
    entity: toStr(r["Entity"]),
    period: toStr(r["Period"]),
    source_file: sourceFile,
  }));

  await batchInsert(
    (n) => {
      const cols = "(customer_id,name,email,phone,dob,account_status,entity,period,source_file)";
      const groups = Array.from({ length: n }, (_, i) => {
        const base = i * 9;
        return `(${Array.from({ length: 9 }, (_, j) => `$${base + j + 1}`).join(",")})`;
      }).join(",");
      return `
        INSERT INTO customer_data_reports ${cols} VALUES ${groups}
        ON CONFLICT (customer_id) DO UPDATE
        SET name=EXCLUDED.name,
            email=EXCLUDED.email,
            phone=EXCLUDED.phone,
            dob=EXCLUDED.dob,
            account_status=EXCLUDED.account_status,
            entity=EXCLUDED.entity,
            period=EXCLUDED.period,
            source_file=EXCLUDED.source_file,
            loaded_at=now();
      `;
    },
    normalized,
    (r) => [r.customer_id, r.name, r.email, r.phone, r.dob, r.account_status, r.entity, r.period, r.source_file]
  );
}

async function insertTransactions(rows: any[], sourceFile: string) {
  const normalized = rows.map(cleanHeaderKeys).map((r) => ({
    txn_id: toStr(r["Txn_ID"]),
    date: toStr(r["Date"]),
    account_id: toStr(r["Account_ID"]),
    amount: toNum(r["Amount"]),
    currency: toStr(r["Currency"]),
    txn_type: toStr(r["Txn_Type"]),
    status: toStr(r["Status"]),
    counterparty: toStr(r["Counterparty"]),
    entity: toStr(r["Entity"]),
    period: toStr(r["Period"]),
    source_file: sourceFile,
  }));

  await batchInsert(
    (n) => {
      const cols = "(txn_id,date,account_id,amount,currency,txn_type,status,counterparty,entity,period,source_file)";
      const groups = Array.from({ length: n }, (_, i) => {
        const base = i * 11;
        return `(${Array.from({ length: 11 }, (_, j) => `$${base + j + 1}`).join(",")})`;
      }).join(",");
      return `
        INSERT INTO transaction_reports ${cols} VALUES ${groups}
        ON CONFLICT (txn_id) DO UPDATE
        SET date=EXCLUDED.date,
            account_id=EXCLUDED.account_id,
            amount=EXCLUDED.amount,
            currency=EXCLUDED.currency,
            txn_type=EXCLUDED.txn_type,
            status=EXCLUDED.status,
            counterparty=EXCLUDED.counterparty,
            entity=EXCLUDED.entity,
            period=EXCLUDED.period,
            source_file=EXCLUDED.source_file,
            loaded_at=now();
      `;
    },
    normalized,
    (r) => [r.txn_id, r.date, r.account_id, r.amount, r.currency, r.txn_type, r.status, r.counterparty, r.entity, r.period, r.source_file]
  );
}

async function insertRisk(rows: any[], sourceFile: string) {
  const normalized = rows.map(cleanHeaderKeys).map((r) => ({
    risk_id: toStr(r["Risk_ID"]),
    risk_category: toStr(r["Risk_Category"]),
    description: toStr(r["Description"]),
    likelihood: toNum(r["Likelihood"]),
    impact: toNum(r["Impact"]),
    score: toNum(r["Score"]),
    owner: toStr(r["Owner"]),
    mitigation: toStr(r["Mitigation"]),
    review_date: toStr(r["Review_Date"]),
    entity: toStr(r["Entity"]),
    period: toStr(r["Period"]),
    source_file: sourceFile,
  }));

  await batchInsert(
    (n) => {
      const cols = "(risk_id,risk_category,description,likelihood,impact,score,owner,mitigation,review_date,entity,period,source_file)";
      const groups = Array.from({ length: n }, (_, i) => {
        const base = i * 12;
        return `(${Array.from({ length: 12 }, (_, j) => `$${base + j + 1}`).join(",")})`;
      }).join(",");
      return `
        INSERT INTO risk_assessment_reports ${cols} VALUES ${groups}
        ON CONFLICT (risk_id) DO UPDATE
        SET risk_category=EXCLUDED.risk_category,
            description=EXCLUDED.description,
            likelihood=EXCLUDED.likelihood,
            impact=EXCLUDED.impact,
            score=EXCLUDED.score,
            owner=EXCLUDED.owner,
            mitigation=EXCLUDED.mitigation,
            review_date=EXCLUDED.review_date,
            entity=EXCLUDED.entity,
            period=EXCLUDED.period,
            source_file=EXCLUDED.source_file,
            loaded_at=now();
      `;
    },
    normalized,
    (r) => [r.risk_id, r.risk_category, r.description, r.likelihood, r.impact, r.score, r.owner, r.mitigation, r.review_date, r.entity, r.period, r.source_file]
  );
}

// ------------------ uploaded_files helpers ------------------
async function upsertUploadedFileRow(args: {
  checksum: string;
  originalName: string;
  mime: string;
  size: number;
  storedPath: string | null;
  pageCount?: number | null;
}) {
  const { checksum, originalName, mime, size, storedPath, pageCount } = args;

  // If you already have more columns, extend here.
  const sql = `
    INSERT INTO uploaded_files (checksum, filename, mime_type, byte_size, storage_path, page_count, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (checksum) DO UPDATE
       SET filename = EXCLUDED.filename,
           mime_type = EXCLUDED.mime_type,
           byte_size = EXCLUDED.byte_size,
           storage_path = EXCLUDED.storage_path,
           page_count = COALESCE(EXCLUDED.page_count, uploaded_files.page_count)
    RETURNING id;
  `;
  const { rows } = await query(sql, [checksum, originalName, mime, size, storedPath, pageCount ?? null]);
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

      // extract rules (external or fallback)
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
