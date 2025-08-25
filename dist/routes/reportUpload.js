"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportUploadRouter = void 0;
// src/routes/reportUpload.ts
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const crypto_1 = __importDefault(require("crypto"));
const supabase_1 = require("../lib/supabase");
const db_1 = require("../db"); // your existing db connection helper
const backgroundGlossaryProcessor_1 = require("../lib/backgroundGlossaryProcessor");
const config_1 = require("../lib/config");
const router = (0, express_1.Router)();
exports.reportUploadRouter = router;
/**
 * Multer
 * - memory storage (so we can stream buffer directly to Supabase)
 * - 50MB limit (adjust if needed)
 */
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});
/** Accepted mimetypes (tweak as needed) */
const ACCEPTED_MIME = new Set([
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/pdf",
    "text/plain",
    "application/json",
]);
/**
 * POST /api/reports/upload
 * Form-Data:
 *   - file: File        (MUST be "file" to match upload.single("file"))
 *   - entity?: string
 *   - reportType?: string
 *   - period?: string (reporting period)
 *
 * Returns:
 *   { ok, fileId, processingStatus, path, signedUrl }
 */
router.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ ok: false, error: "NO_FILE" });
        }
        const { originalname, mimetype, size, buffer } = req.file;
        // Optional MIME guard
        if (ACCEPTED_MIME.size > 0 && !ACCEPTED_MIME.has(mimetype)) {
            return res.status(415).json({
                ok: false,
                error: "UNSUPPORTED_MEDIA_TYPE",
                mimetype,
                accepted: Array.from(ACCEPTED_MIME),
            });
        }
        // Request metadata (optional fields)
        const entity = (req.body?.entity ?? null) || null;
        const reportType = (req.body?.reportType ?? null) || null;
        const period = (req.body?.period ?? null) || null;
        // Build unique object path
        const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const rand = crypto_1.default.randomBytes(8).toString("hex");
        const sanitized = originalname.replace(/[^\w.\-]+/g, "_").slice(0, 180);
        const objectPath = `uploads/${yyyymmdd}/${rand}_${sanitized}`;
        // Upload to Supabase Storage
        const bucket = process.env.SUPABASE_BUCKET || "reports";
        const { error: upErr } = await supabase_1.supabase.storage
            .from(bucket)
            .upload(objectPath, buffer, {
            contentType: mimetype,
            upsert: false,
        });
        if (upErr) {
            config_1.logger.error("Supabase upload error", { error: upErr, objectPath });
            return res
                .status(502)
                .json({ ok: false, error: "STORAGE_UPLOAD_FAILED" });
        }
        // Short-lived signed URL (1h)
        const { data: signed, error: signErr } = await supabase_1.supabase.storage
            .from(bucket)
            .createSignedUrl(objectPath, 60 * 60);
        if (signErr) {
            config_1.logger.warn("Signed URL generation failed; continuing", {
                error: signErr,
                objectPath,
            });
        }
        // Insert DB record
        const insertSql = `
        INSERT INTO uploaded_files
          (filename, file_path, file_size, mime_type, processing_status, entity, report_type, period)
        VALUES
          ($1, $2, $3, $4, 'pending', $5, $6, $7)
        RETURNING id, filename, file_path, file_size, mime_type, processing_status
      `;
        const result = await (0, db_1.query)(insertSql, [
            originalname,
            objectPath,
            size,
            mimetype,
            entity,
            reportType,
            period,
        ]);
        if (!result.rows?.[0]) {
            config_1.logger.error("DB insert returned no rows");
            return res.status(500).json({ ok: false, error: "DB_INSERT_FAILED" });
        }
        const fileRecord = result.rows[0];
        const fileId = String(fileRecord.id);
        // Fire-and-forget background processing
        try {
            await (0, backgroundGlossaryProcessor_1.processFileInBackground)(fileId, objectPath);
            config_1.logger.info("Background processing triggered", { fileId, objectPath });
        }
        catch (e) {
            config_1.logger.warn("Failed to trigger background processor", {
                error: e,
                fileId,
            });
        }
        return res.status(200).json({
            ok: true,
            fileId,
            processingStatus: fileRecord.processing_status,
            path: objectPath,
            signedUrl: signed?.signedUrl ?? null,
        });
    }
    catch (err) {
        config_1.logger.error("Upload endpoint unexpected error", { error: err });
        return res.status(500).json({ ok: false, error: "UPLOAD_FAILED" });
    }
});
/**
 * GET /api/reports/upload/status/:fileId
 * Returns processing status for an uploaded file
 */
router.get("/upload/status/:fileId", async (req, res) => {
    try {
        const { fileId } = req.params;
        const statusQuery = `
      SELECT 
        processing_status,
        extracted_terms_count,
        error_message,
        processed_at,
        filename,
        upload_date
      FROM uploaded_files 
      WHERE id = $1
    `;
        const result = await (0, db_1.query)(statusQuery, [fileId]);
        if (!result.rows?.[0]) {
            return res.status(404).json({ ok: false, error: "FILE_NOT_FOUND" });
        }
        const fileData = result.rows[0];
        return res.json({
            ok: true,
            status: fileData.processing_status,
            extractedTerms: fileData.extracted_terms_count || 0,
            errorMessage: fileData.error_message,
            processedAt: fileData.processed_at,
            filename: fileData.filename,
            uploadDate: fileData.upload_date,
        });
    }
    catch (err) {
        config_1.logger.error("Status check error", {
            error: err,
            fileId: req.params.fileId,
        });
        return res.status(500).json({ ok: false, error: "STATUS_CHECK_FAILED" });
    }
});
/**
 * GET /api/reports/upload/terms/:fileId
 * Returns extracted glossary terms for the file
 */
router.get("/upload/terms/:fileId", async (req, res) => {
    try {
        const { fileId } = req.params;
        const termsQuery = `
      SELECT 
        term,
        definition,
        source_columns,
        data_types,
        sample_values,
        synonyms,
        category,
        confidence,
        created_at
      FROM data_glossary 
      WHERE source_file_id = $1
      ORDER BY confidence DESC, term ASC
    `;
        const result = await (0, db_1.query)(termsQuery, [fileId]);
        return res.json({
            ok: true,
            fileId,
            terms: result.rows,
            count: result.rows.length,
        });
    }
    catch (err) {
        config_1.logger.error("Terms retrieval error", {
            error: err,
            fileId: req.params.fileId,
        });
        return res.status(500).json({ ok: false, error: "TERMS_RETRIEVAL_FAILED" });
    }
});
/**
 * POST /api/reports/upload/debug-process/:fileId
 * TEMP helper — run extraction now. Since processFileInBackground
 * doesn’t return anything, we just return ok + fileId.
 */
router.post("/upload/debug-process/:fileId", async (req, res) => {
    const { fileId } = req.params;
    try {
        // Lookup file_path from uploaded_files
        const r = await (0, db_1.query)(`SELECT file_path FROM uploaded_files WHERE id = $1::uuid`, [fileId]);
        if (!r.rows?.[0]) {
            return res.status(404).json({ ok: false, error: "FILE_NOT_FOUND" });
        }
        const objectPath = r.rows[0].file_path;
        // Just call the background processor (2 args, no destructuring)
        await (0, backgroundGlossaryProcessor_1.processFileInBackground)(fileId, objectPath);
        return res.json({ ok: true, fileId });
    }
    catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
