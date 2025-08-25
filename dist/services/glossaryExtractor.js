"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileProcessor = exports.logger = exports.CONFIG = void 0;
exports.deduplicateTerms = deduplicateTerms;
exports.createGlossaryExtractor = createGlossaryExtractor;
exports.uploadAndExtractGlossary = uploadAndExtractGlossary;
// src/lib/glossaryExtractor.ts
// npm i @google/generative-ai busboy xlsx csv-parse pdf-parse pg winston joi
const generative_ai_1 = require("@google/generative-ai");
const pg_1 = require("pg");
const busboy_1 = __importDefault(require("busboy"));
const XLSX = __importStar(require("xlsx"));
const sync_1 = require("csv-parse/sync");
const pdf_parse_1 = __importDefault(require("pdf-parse"));
const winston_1 = __importDefault(require("winston"));
const joi_1 = __importDefault(require("joi"));
// -------------------------------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------------------------------
exports.CONFIG = {
    AI: {
        MODEL: "gemini-2.0-flash-exp",
        MAX_RETRIES: 3,
        RETRY_DELAY: 1000,
        REQUEST_TIMEOUT: 30000,
    },
    PROCESSING: {
        MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
        MAX_TEXT_LENGTH: 100000,
        MAX_ROWS_TO_ANALYZE: 1000,
        SAMPLE_VALUES_COUNT: 8,
        TYPE_DETECTION_SAMPLE_SIZE: 100,
    },
    DATABASE: {
        MAX_BATCH_SIZE: 100,
        CONNECTION_TIMEOUT: 5000,
    },
};
// -------------------------------------------------------------------------------------
// LOGGER
// -------------------------------------------------------------------------------------
exports.logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.errors({ stack: true }), winston_1.default.format.json()),
    transports: [
        new winston_1.default.transports.Console(),
        new winston_1.default.transports.File({ filename: "glossary-extractor.log" }),
    ],
});
// -------------------------------------------------------------------------------------
// INPUT VALIDATION
// -------------------------------------------------------------------------------------
const uploadSchema = joi_1.default.object({
    datasetId: joi_1.default.string().min(1).max(100).required(),
    businessContext: joi_1.default.string().max(1000).optional(),
    extractionMode: joi_1.default.string().valid("comprehensive", "basic").default("comprehensive"),
});
// -------------------------------------------------------------------------------------
// AI CLIENT (with schema + retries)
// -------------------------------------------------------------------------------------
class EnhancedGeminiClient {
    model;
    genAI;
    constructor() {
        if (!process.env.GOOGLE_AI_STUDIO_API_KEY) {
            throw new Error("GOOGLE_AI_STUDIO_API_KEY environment variable is required");
        }
        this.genAI = new generative_ai_1.GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API_KEY);
        this.model = this.genAI.getGenerativeModel({
            model: exports.CONFIG.AI.MODEL,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: this.getResponseSchema(),
                temperature: 0.1,
                candidateCount: 1,
            },
        });
    }
    getResponseSchema() {
        return {
            type: generative_ai_1.SchemaType.OBJECT,
            properties: {
                terms: {
                    type: generative_ai_1.SchemaType.ARRAY,
                    items: {
                        type: generative_ai_1.SchemaType.OBJECT,
                        properties: {
                            term: { type: generative_ai_1.SchemaType.STRING },
                            definition: { type: generative_ai_1.SchemaType.STRING },
                            source_columns: { type: generative_ai_1.SchemaType.ARRAY, items: { type: generative_ai_1.SchemaType.STRING } },
                            data_types: { type: generative_ai_1.SchemaType.ARRAY, items: { type: generative_ai_1.SchemaType.STRING } },
                            sample_values: { type: generative_ai_1.SchemaType.ARRAY, items: { type: generative_ai_1.SchemaType.STRING } },
                            synonyms: { type: generative_ai_1.SchemaType.ARRAY, items: { type: generative_ai_1.SchemaType.STRING } },
                            category: { type: generative_ai_1.SchemaType.STRING },
                            confidence: { type: generative_ai_1.SchemaType.NUMBER },
                        },
                        required: ["term", "definition"],
                    },
                },
                metadata: {
                    type: generative_ai_1.SchemaType.OBJECT,
                    properties: {
                        total_terms_found: { type: generative_ai_1.SchemaType.NUMBER },
                        processing_notes: { type: generative_ai_1.SchemaType.ARRAY, items: { type: generative_ai_1.SchemaType.STRING } },
                    },
                },
            },
        }; // or just return as `any`
    }
    async extractTermsWithRetry(prompt) {
        let lastError = null;
        for (let attempt = 1; attempt <= exports.CONFIG.AI.MAX_RETRIES; attempt++) {
            try {
                exports.logger.info(`Gemini API call attempt ${attempt}/${exports.CONFIG.AI.MAX_RETRIES}`);
                const startTime = Date.now();
                const result = await Promise.race([
                    this.model.generateContent({
                        contents: [{ role: "user", parts: [{ text: prompt }] }],
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Request timeout")), exports.CONFIG.AI.REQUEST_TIMEOUT)),
                ]);
                const responseTime = Date.now() - startTime;
                exports.logger.info(`Gemini API success in ${responseTime}ms`);
                const response = result;
                const text = response.response.text();
                const parsed = JSON.parse(text);
                return parsed;
            }
            catch (error) {
                lastError = error;
                exports.logger.warn(`Gemini API attempt ${attempt} failed: ${lastError?.message}`);
                if (attempt < exports.CONFIG.AI.MAX_RETRIES) {
                    const delay = exports.CONFIG.AI.RETRY_DELAY * Math.pow(2, attempt - 1);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        throw new Error(`Gemini API failed after ${exports.CONFIG.AI.MAX_RETRIES} attempts: ${lastError?.message}`);
    }
}
// -------------------------------------------------------------------------------------
// DATABASE CLIENT (kept as in your source)
// -------------------------------------------------------------------------------------
class DatabaseClient {
    pool;
    constructor() {
        if (!process.env.DATABASE_URL) {
            throw new Error("DATABASE_URL environment variable is required");
        }
        this.pool = new pg_1.Pool({
            connectionString: process.env.DATABASE_URL,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: exports.CONFIG.DATABASE.CONNECTION_TIMEOUT,
        });
    }
    async ensureSchema() {
        const client = await this.pool.connect();
        try {
            await client.query(`
        CREATE TABLE IF NOT EXISTS data_glossary (
          id SERIAL PRIMARY KEY,
          term VARCHAR(255) NOT NULL,
          definition TEXT NOT NULL,
          source_columns TEXT[],
          data_types TEXT[],
          sample_values TEXT[],
          synonyms TEXT[],
          category VARCHAR(100),
          confidence DECIMAL(3,2),
          dataset_id VARCHAR(100) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(term, dataset_id)
        );

        CREATE INDEX IF NOT EXISTS idx_data_glossary_dataset ON data_glossary(dataset_id);
        CREATE INDEX IF NOT EXISTS idx_data_glossary_term ON data_glossary(term);
        CREATE INDEX IF NOT EXISTS idx_data_glossary_category ON data_glossary(category);
      `);
        }
        finally {
            client.release();
        }
    }
    async batchUpsertTerms(terms, datasetId) {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            for (let i = 0; i < terms.length; i += exports.CONFIG.DATABASE.MAX_BATCH_SIZE) {
                const batch = terms.slice(i, i + exports.CONFIG.DATABASE.MAX_BATCH_SIZE);
                for (const term of batch) {
                    await client.query(`INSERT INTO data_glossary
              (term, definition, source_columns, data_types, sample_values, synonyms, category, confidence, dataset_id, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
             ON CONFLICT (term, dataset_id) DO UPDATE
               SET definition=EXCLUDED.definition,
                   source_columns=EXCLUDED.source_columns,
                   data_types=EXCLUDED.data_types,
                   sample_values=EXCLUDED.sample_values,
                   synonyms=EXCLUDED.synonyms,
                   category=EXCLUDED.category,
                   confidence=EXCLUDED.confidence,
                   updated_at=NOW()`, [
                        term.term.trim(),
                        term.definition,
                        term.source_columns,
                        term.data_types || null,
                        term.sample_values || null,
                        term.synonyms || null,
                        term.category || null,
                        Math.max(0, Math.min(1, term.confidence || 0.6)),
                        datasetId,
                    ]);
                }
                exports.logger.info(`Processed batch ${Math.floor(i / exports.CONFIG.DATABASE.MAX_BATCH_SIZE) + 1}`);
            }
            await client.query("COMMIT");
            exports.logger.info(`Successfully upserted ${terms.length} terms for dataset ${datasetId}`);
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async close() {
        await this.pool.end();
    }
}
// -------------------------------------------------------------------------------------
// FILE PROCESSOR (exported so the background worker can import it directly)
// -------------------------------------------------------------------------------------
class FileProcessor {
    static async processFile(fileBuffer, metadata) {
        const warnings = [];
        if (metadata.size > exports.CONFIG.PROCESSING.MAX_FILE_SIZE) {
            throw new Error(`File too large: ${metadata.size} bytes (max: ${exports.CONFIG.PROCESSING.MAX_FILE_SIZE})`);
        }
        if (this.looksTabular(metadata.filename, metadata.mimetype)) {
            exports.logger.info("Processing as tabular data");
            try {
                const rows = await this.readTabular(fileBuffer, metadata.filename);
                const columnPreview = this.profileColumns(rows, exports.CONFIG.PROCESSING.SAMPLE_VALUES_COUNT);
                if (rows.length > exports.CONFIG.PROCESSING.MAX_ROWS_TO_ANALYZE) {
                    warnings.push(`Large dataset: analyzed first ${exports.CONFIG.PROCESSING.MAX_ROWS_TO_ANALYZE} rows of ${rows.length}`);
                }
                return { columnPreview, unstructuredText: "", warnings };
            }
            catch (error) {
                warnings.push(`Tabular processing failed: ${error}. Falling back to text processing.`);
                const text = await this.readUnstructured(fileBuffer, metadata.filename, metadata.mimetype);
                return { columnPreview: [], unstructuredText: text, warnings };
            }
        }
        else {
            exports.logger.info("Processing as unstructured data");
            const text = await this.readUnstructured(fileBuffer, metadata.filename, metadata.mimetype);
            return { columnPreview: [], unstructuredText: text, warnings };
        }
    }
    static looksTabular(filename, mimetype) {
        const lower = filename.toLowerCase();
        const tabularExtensions = [".csv", ".xlsx", ".xls", ".tsv", ".json"];
        const tabularMimeTypes = ["csv", "excel", "sheet", "tab-separated", "json"];
        return (tabularExtensions.some((ext) => lower.endsWith(ext)) ||
            tabularMimeTypes.some((type) => mimetype?.toLowerCase().includes(type)));
    }
    static async readTabular(buffer, filename) {
        const lower = filename.toLowerCase();
        try {
            if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
                const delimiter = lower.endsWith(".tsv") ? "\t" : ",";
                return (0, sync_1.parse)(buffer.toString("utf8"), {
                    columns: true,
                    skip_empty_lines: true,
                    delimiter,
                    trim: true,
                    relax_column_count: true,
                });
            }
            if (lower.endsWith(".json")) {
                const data = JSON.parse(buffer.toString("utf8"));
                return Array.isArray(data) ? data : (data.rows || data.data || []);
            }
            const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            return XLSX.utils.sheet_to_json(worksheet, { defval: "" });
        }
        catch (error) {
            throw new Error(`Failed to parse tabular data: ${error}`);
        }
    }
    static profileColumns(rows, sampleCount) {
        if (!rows.length)
            return [];
        const columns = Object.keys(rows[0] || {});
        const analysisRows = rows.slice(0, exports.CONFIG.PROCESSING.MAX_ROWS_TO_ANALYZE);
        return columns.map((name) => {
            const values = analysisRows.map((row) => String(row[name] ?? "")).filter((v) => v.trim());
            const allValues = analysisRows.map((row) => row[name]);
            const nullCount = allValues.filter((v) => v == null || v === "").length;
            const uniqueValues = new Set(values);
            const samples = Array.from(uniqueValues).slice(0, sampleCount);
            const detectedType = this.detectDataType(values.slice(0, exports.CONFIG.PROCESSING.TYPE_DETECTION_SAMPLE_SIZE));
            const statistics = this.calculateStatistics(values, detectedType);
            return {
                name: name.trim(),
                detectedType,
                samples,
                nullCount,
                uniqueCount: uniqueValues.size,
                statistics,
            };
        });
    }
    static detectDataType(values) {
        if (!values.length)
            return "unknown";
        const patterns = {
            email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            url: /^https?:\/\/.+/i,
            phone: /^\+?[\d\s\-\(\)]{7,}$/,
            id: /^[A-Z0-9\-_]{6,}$/i,
            number: /^\s*-?\d+(\.\d+)?\s*$/,
            boolean: /^(true|false|yes|no|y|n|0|1)$/i,
        };
        const sampleSize = Math.min(50, values.length);
        const sample = values.slice(0, sampleSize);
        const scores = {
            email: 0,
            url: 0,
            phone: 0,
            id: 0,
            number: 0,
            date: 0,
            boolean: 0,
        };
        for (const value of sample) {
            const trimmed = value.trim();
            if (patterns.email.test(trimmed))
                scores.email++;
            else if (patterns.url.test(trimmed))
                scores.url++;
            else if (patterns.phone.test(trimmed))
                scores.phone++;
            else if (patterns.id.test(trimmed))
                scores.id++;
            else if (patterns.number.test(trimmed))
                scores.number++;
            else if (patterns.boolean.test(trimmed))
                scores.boolean++;
            else if (!isNaN(Date.parse(trimmed)) && trimmed.length > 6)
                scores.date++;
        }
        const maxScore = Math.max(...Object.values(scores));
        const threshold = sampleSize * 0.6;
        if (maxScore < threshold)
            return "string";
        const winner = Object.entries(scores).find(([_, score]) => score === maxScore)?.[0];
        return winner || "string";
    }
    static calculateStatistics(values, type) {
        if (type !== "number" || !values.length)
            return undefined;
        const numbers = values.map(Number).filter((n) => !isNaN(n));
        if (!numbers.length)
            return undefined;
        return {
            min: Math.min(...numbers),
            max: Math.max(...numbers),
            avg: numbers.reduce((a, b) => a + b, 0) / numbers.length,
        };
    }
    static async readUnstructured(buffer, filename, mimetype) {
        const lower = filename.toLowerCase();
        try {
            if (lower.endsWith(".pdf") || mimetype?.includes("pdf")) {
                const { text } = await (0, pdf_parse_1.default)(buffer);
                return this.truncateText(text, exports.CONFIG.PROCESSING.MAX_TEXT_LENGTH);
            }
            const text = buffer.toString("utf8");
            return this.truncateText(text, exports.CONFIG.PROCESSING.MAX_TEXT_LENGTH);
        }
        catch (error) {
            throw new Error(`Failed to extract text from file: ${error}`);
        }
    }
    static truncateText(text, maxLength) {
        if (text.length <= maxLength)
            return text;
        const truncated = text.slice(0, maxLength);
        const lastSentence = truncated.lastIndexOf(".");
        return lastSentence > maxLength * 0.8 ? truncated.slice(0, lastSentence + 1) : truncated + "...";
    }
}
exports.FileProcessor = FileProcessor;
// -------------------------------------------------------------------------------------
// PROMPT BUILDER (unchanged, just kept here)
// -------------------------------------------------------------------------------------
class PromptBuilder {
    static buildEnhancedPrompt(options) {
        const { columnPreview, unstructuredText, datasetId, businessContext, extractionMode } = options;
        const baseInstructions = [
            "You are an expert data ontology assistant specialized in creating business glossaries.",
            "Your task is to extract meaningful business terms and create clear, actionable definitions.",
            "",
            "CRITICAL RULES:",
            "- Focus on business-relevant terms, not technical implementation details",
            "- Definitions should be clear to business users, not just data analysts",
            "- Avoid circular definitions (don't define a term using itself)",
            "- Expand acronyms and abbreviations when possible",
            "- Merge similar terms to avoid duplication",
            "- Assign realistic confidence scores (0.0-1.0)",
            "- Categorize terms logically (e.g., 'Customer Data', 'Financial Metrics', 'Operational KPIs')",
            "",
            `Dataset Context: ${datasetId}`,
            businessContext ? `Business Context: ${businessContext}` : "",
            `Extraction Mode: ${extractionMode}`,
            "",
        ];
        if (columnPreview.length > 0) {
            const comprehensiveMode = extractionMode === "comprehensive";
            return [
                ...baseInstructions,
                "TABULAR DATA ANALYSIS:",
                `Found ${columnPreview.length} columns. Extract business terms from column names, data patterns, and relationships.`,
                "",
                "Column Details:",
                ...columnPreview.map((col) => {
                    const stats = col.statistics
                        ? ` (range: ${col.statistics.min}-${col.statistics.max}, avg: ${col.statistics.avg?.toFixed(2)})`
                        : "";
                    return [
                        `• ${col.name} (${col.detectedType}${stats})`,
                        `  - Unique values: ${col.uniqueCount}, Null count: ${col.nullCount}`,
                        `  - Sample values: ${col.samples.slice(0, 5).map((s) => `"${s}"`).join(", ")}`,
                    ].join("\n");
                }),
                "",
                comprehensiveMode
                    ? "COMPREHENSIVE MODE: Extract detailed terms including derived concepts, relationships, and business rules."
                    : "BASIC MODE: Focus on primary entities and key business concepts only.",
                "",
                "Examples of good terms:",
                "- Column 'cust_id' → Term: 'Customer Identifier', Definition: 'Unique identifier assigned to each customer account'",
                "- Pattern in 'order_status' → Term: 'Order Status', Definition: 'Current processing stage of a customer order'",
                "- High cardinality in 'product_sku' → Term: 'Stock Keeping Unit', Definition: 'Unique code identifying individual products in inventory'",
            ].join("\n");
        }
        else {
            return [
                ...baseInstructions,
                "DOCUMENT ANALYSIS:",
                "Extract business terms, definitions, acronyms, and domain-specific concepts from the following document.",
                "Look for:",
                "- Explicitly defined terms and their definitions",
                "- Business processes and their components",
                "- Metrics, KPIs, and measurements",
                "- Domain-specific jargon and acronyms",
                "- Code lists and categorical values",
                "",
                "Document Content:",
                "---",
                unstructuredText,
                "---",
            ].join("\n");
        }
    }
}
// -------------------------------------------------------------------------------------
// PUBLIC UTIL: DEDUPLICATION (exported)
// -------------------------------------------------------------------------------------
function deduplicateTerms(terms) {
    const seen = new Map();
    for (const term of terms) {
        const normalizedTerm = term.term.trim().toLowerCase();
        if (!seen.has(normalizedTerm)) {
            seen.set(normalizedTerm, {
                ...term,
                term: term.term.trim(),
            });
        }
        else {
            const existing = seen.get(normalizedTerm);
            // keep higher confidence, merge sources
            const merged = {
                ...existing,
                definition: (existing.definition?.length || 0) >= (term.definition?.length || 0)
                    ? existing.definition
                    : term.definition,
                source_columns: Array.from(new Set([...(existing.source_columns || []), ...(term.source_columns || [])])),
                data_types: Array.from(new Set([...(existing.data_types || []), ...(term.data_types || [])])),
                sample_values: Array.from(new Set([...(existing.sample_values || []), ...(term.sample_values || [])])),
                synonyms: Array.from(new Set([...(existing.synonyms || []), ...(term.synonyms || [])])),
                category: existing.category || term.category,
                confidence: Math.max(existing.confidence ?? 0, term.confidence ?? 0),
                source_file_id: existing.source_file_id ?? term.source_file_id,
                source_filename: existing.source_filename ?? term.source_filename,
                dataset_id: existing.dataset_id ?? term.dataset_id,
            };
            seen.set(normalizedTerm, merged);
        }
    }
    return Array.from(seen.values()).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}
// -------------------------------------------------------------------------------------
// FACTORY for background worker (exported)
// -------------------------------------------------------------------------------------
function createGlossaryExtractor() {
    const aiClient = new EnhancedGeminiClient();
    return {
        /**
         * Lightweight method for background workers:
         *  - Accepts a file buffer + minimal metadata
         *  - Auto-detects tabular vs unstructured
         *  - Builds prompt and calls Gemini
         *  - Returns terms + (optional) columnPreview + warnings
         */
        async extractFromFile(fileBuffer, meta, datasetId, businessContext, extractionMode = "comprehensive") {
            const { columnPreview, unstructuredText, warnings = [] } = await FileProcessor.processFile(fileBuffer, {
                filename: meta.filename,
                mimetype: meta.mimetype,
                size: meta.size,
                datasetId,
            });
            const prompt = PromptBuilder.buildEnhancedPrompt({
                columnPreview,
                unstructuredText,
                datasetId,
                businessContext,
                extractionMode,
            });
            const aiResponse = await aiClient.extractTermsWithRetry(prompt);
            const deduped = deduplicateTerms(aiResponse?.terms || []);
            return {
                terms: deduped,
                warnings,
                columnPreview: columnPreview.length ? columnPreview : undefined,
            };
        },
    };
}
// -------------------------------------------------------------------------------------
// MAIN HTTP HANDLER (kept for your direct upload→extract endpoint)
// -------------------------------------------------------------------------------------
async function uploadAndExtractGlossary(req, res) {
    const startTime = Date.now();
    let tempFileMetadata = null;
    try {
        exports.logger.info("Starting glossary extraction process");
        // 1) Parse + validate
        const { fields, fileBuffer, filename, mimetype } = await readMultipartData(req);
        const validatedFields = await uploadSchema.validateAsync(fields);
        tempFileMetadata = {
            filename,
            mimetype,
            size: fileBuffer.length,
            datasetId: validatedFields.datasetId,
        };
        exports.logger.info("File received", tempFileMetadata);
        // 2) Initialize services (DB optional if you're saving immediately here)
        const aiClient = new EnhancedGeminiClient();
        const dbClient = new DatabaseClient();
        await dbClient.ensureSchema();
        // 3) Preprocess file
        const { columnPreview, unstructuredText, warnings } = await FileProcessor.processFile(fileBuffer, tempFileMetadata);
        // 4) Prompt
        const prompt = PromptBuilder.buildEnhancedPrompt({
            columnPreview,
            unstructuredText,
            datasetId: validatedFields.datasetId,
            businessContext: validatedFields.businessContext,
            extractionMode: validatedFields.extractionMode,
        });
        exports.logger.info(`Generated prompt (${prompt.length} characters)`);
        // 5) Gemini
        const aiResponse = await aiClient.extractTermsWithRetry(prompt);
        const deduplicatedTerms = deduplicateTerms(aiResponse.terms || []);
        exports.logger.info(`Extracted ${deduplicatedTerms.length} unique terms`);
        // 6) Persist (optional if background job does this step)
        if (deduplicatedTerms.length > 0) {
            await dbClient.batchUpsertTerms(deduplicatedTerms, validatedFields.datasetId);
        }
        // 7) Respond
        const processingTime = Date.now() - startTime;
        const result = {
            datasetId: validatedFields.datasetId,
            termsExtracted: deduplicatedTerms.length,
            processingTime,
            fileMetadata: tempFileMetadata,
            terms: deduplicatedTerms,
            warnings: warnings.length ? warnings : undefined,
        };
        exports.logger.info(`Glossary extraction completed successfully in ${processingTime}ms`);
        res.json(result);
    }
    catch (error) {
        const processingTime = Date.now() - startTime;
        exports.logger.error("Glossary extraction failed", {
            error: error.message,
            stack: error.stack,
            fileMetadata: tempFileMetadata,
            processingTime,
        });
        const status = error.message.includes("validation") ? 400 : 500;
        res.status(status).json({
            error: error.message,
            processingTime,
            fileMetadata: tempFileMetadata,
        });
    }
}
// -------------------------------------------------------------------------------------
// HELPERS (unchanged)
// -------------------------------------------------------------------------------------
async function readMultipartData(req) {
    return new Promise((resolve, reject) => {
        const busboy = (0, busboy_1.default)({ headers: req.headers });
        const fields = {};
        const chunks = [];
        let filename = "";
        let mimetype = "";
        let fileReceived = false;
        busboy.on("file", (_fieldname, file, info) => {
            if (fileReceived)
                return reject(new Error("Multiple files not supported"));
            fileReceived = true;
            filename = info.filename;
            mimetype = info.mimeType;
            file.on("data", (chunk) => {
                chunks.push(chunk);
                const currentSize = chunks.reduce((total, c) => total + c.length, 0);
                if (currentSize > exports.CONFIG.PROCESSING.MAX_FILE_SIZE) {
                    file.destroy();
                    reject(new Error(`File too large (max: ${exports.CONFIG.PROCESSING.MAX_FILE_SIZE} bytes)`));
                }
            });
            file.on("end", () => {
                // no-op; concat on close
            });
            file.on("error", reject);
        });
        busboy.on("field", (name, value) => {
            fields[name] = value;
        });
        busboy.on("close", () => {
            if (!fileReceived) {
                reject(new Error("No file provided"));
            }
            else {
                resolve({ fields, fileBuffer: Buffer.concat(chunks), filename, mimetype });
            }
        });
        busboy.on("error", reject);
        setTimeout(() => reject(new Error("Upload timeout")), 60000);
        req.pipe(busboy);
    });
}
// -------------------------------------------------------------------------------------
// PROCESS SIGNALS
// -------------------------------------------------------------------------------------
process.on("SIGTERM", async () => {
    exports.logger.info("Shutting down gracefully");
    process.exit(0);
});
process.on("unhandledRejection", (reason, promise) => {
    exports.logger.error("Unhandled Rejection at:", promise, "reason:", reason);
});
