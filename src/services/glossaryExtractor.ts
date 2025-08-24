// src/lib/glossaryExtractor.ts
// npm i @google/generative-ai busboy xlsx csv-parse pdf-parse pg winston joi
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { Pool } from "pg";
import Busboy from "busboy";
import * as XLSX from "xlsx";
import { parse as csvParse } from "csv-parse/sync";
import pdfParse from "pdf-parse";
import winston from "winston";
import Joi from "joi";
import type { Request, Response } from "express";

// -------------------------------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------------------------------
export const CONFIG = {
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
} as const;

// -------------------------------------------------------------------------------------
// LOGGER
// -------------------------------------------------------------------------------------
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "glossary-extractor.log" }),
  ],
});

// -------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------
export type DataType =
  | "string"
  | "number"
  | "date"
  | "boolean"
  | "email"
  | "url"
  | "phone"
  | "id"
  | "unknown";

export interface ColumnPreview {
  name: string;
  detectedType: DataType;
  samples: string[];
  nullCount: number;
  uniqueCount: number;
  statistics?: {
    min?: number;
    max?: number;
    avg?: number;
  };
}

export interface FileMetadata {
  filename: string;
  mimetype: string;
  size: number;
  datasetId: string;
}

export interface GlossaryTerm {
  term: string;
  definition: string;
  source_columns: string[];
  data_types?: string[];
  sample_values?: string[];
  synonyms?: string[];
  category?: string;
  confidence: number;
  // Optional linkage fields you might set in the background worker:
  source_file_id?: string;
  source_filename?: string;
  dataset_id?: string;
}

export interface ProcessingResult {
  datasetId: string;
  termsExtracted: number;
  processingTime: number;
  fileMetadata: FileMetadata;
  terms: GlossaryTerm[];
  warnings?: string[];
}

export interface ExtractionResult {
  terms: GlossaryTerm[];
  warnings?: string[];
  columnPreview?: ColumnPreview[];
}

// -------------------------------------------------------------------------------------
// INPUT VALIDATION
// -------------------------------------------------------------------------------------
const uploadSchema = Joi.object({
  datasetId: Joi.string().min(1).max(100).required(),
  businessContext: Joi.string().max(1000).optional(),
  extractionMode: Joi.string().valid("comprehensive", "basic").default("comprehensive"),
});

// -------------------------------------------------------------------------------------
// AI CLIENT (with schema + retries)
// -------------------------------------------------------------------------------------
class EnhancedGeminiClient {
  private model: any;
  private genAI: GoogleGenerativeAI;

  constructor() {
    if (!process.env.GOOGLE_AI_STUDIO_API_KEY) {
      throw new Error("GOOGLE_AI_STUDIO_API_KEY environment variable is required");
    }

    this.genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API_KEY);
    this.model = this.genAI.getGenerativeModel({
      model: CONFIG.AI.MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: this.getResponseSchema(),
        temperature: 0.1,
        candidateCount: 1,
      },
    });
  }

private getResponseSchema(): any {
  return {
    type: SchemaType.OBJECT,
    properties: {
      terms: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            term: { type: SchemaType.STRING },
            definition: { type: SchemaType.STRING },
            source_columns: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            data_types: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            sample_values: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            synonyms: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            category: { type: SchemaType.STRING },
            confidence: { type: SchemaType.NUMBER },
          },
          required: ["term", "definition"],
        },
      },
      metadata: {
        type: SchemaType.OBJECT,
        properties: {
          total_terms_found: { type: SchemaType.NUMBER },
          processing_notes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
      },
    },
  } as const; // or just return as `any`
}

  async extractTermsWithRetry(prompt: string): Promise<{ terms: GlossaryTerm[]; metadata?: any }> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= CONFIG.AI.MAX_RETRIES; attempt++) {
      try {
        logger.info(`Gemini API call attempt ${attempt}/${CONFIG.AI.MAX_RETRIES}`);

        const startTime = Date.now();
        const result = await Promise.race([
          this.model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Request timeout")), CONFIG.AI.REQUEST_TIMEOUT)
          ),
        ]);

        const responseTime = Date.now() - startTime;
        logger.info(`Gemini API success in ${responseTime}ms`);

        const response = result as any;
        const text = response.response.text();
        const parsed = JSON.parse(text);
        return parsed;

      } catch (error) {
        lastError = error as Error;
        logger.warn(`Gemini API attempt ${attempt} failed: ${lastError?.message}`);

        if (attempt < CONFIG.AI.MAX_RETRIES) {
          const delay = CONFIG.AI.RETRY_DELAY * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Gemini API failed after ${CONFIG.AI.MAX_RETRIES} attempts: ${lastError?.message}`);
  }
}

// -------------------------------------------------------------------------------------
// DATABASE CLIENT (kept as in your source)
// -------------------------------------------------------------------------------------
class DatabaseClient {
  private pool: Pool;

  constructor() {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: CONFIG.DATABASE.CONNECTION_TIMEOUT,
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
    } finally {
      client.release();
    }
  }

  async batchUpsertTerms(terms: GlossaryTerm[], datasetId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (let i = 0; i < terms.length; i += CONFIG.DATABASE.MAX_BATCH_SIZE) {
        const batch = terms.slice(i, i + CONFIG.DATABASE.MAX_BATCH_SIZE);

        for (const term of batch) {
          await client.query(
            `INSERT INTO data_glossary
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
                   updated_at=NOW()`,
            [
              term.term.trim(),
              term.definition,
              term.source_columns,
              term.data_types || null,
              term.sample_values || null,
              term.synonyms || null,
              term.category || null,
              Math.max(0, Math.min(1, term.confidence || 0.6)),
              datasetId,
            ]
          );
        }

        logger.info(`Processed batch ${Math.floor(i / CONFIG.DATABASE.MAX_BATCH_SIZE) + 1}`);
      }

      await client.query("COMMIT");
      logger.info(`Successfully upserted ${terms.length} terms for dataset ${datasetId}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
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
export class FileProcessor {
  static async processFile(
    fileBuffer: Buffer,
    metadata: FileMetadata
  ): Promise<{ columnPreview: ColumnPreview[]; unstructuredText: string; warnings: string[] }> {
    const warnings: string[] = [];

    if (metadata.size > CONFIG.PROCESSING.MAX_FILE_SIZE) {
      throw new Error(`File too large: ${metadata.size} bytes (max: ${CONFIG.PROCESSING.MAX_FILE_SIZE})`);
    }

    if (this.looksTabular(metadata.filename, metadata.mimetype)) {
      logger.info("Processing as tabular data");
      try {
        const rows = await this.readTabular(fileBuffer, metadata.filename);
        const columnPreview = this.profileColumns(rows, CONFIG.PROCESSING.SAMPLE_VALUES_COUNT);

        if (rows.length > CONFIG.PROCESSING.MAX_ROWS_TO_ANALYZE) {
          warnings.push(`Large dataset: analyzed first ${CONFIG.PROCESSING.MAX_ROWS_TO_ANALYZE} rows of ${rows.length}`);
        }

        return { columnPreview, unstructuredText: "", warnings };
      } catch (error) {
        warnings.push(`Tabular processing failed: ${error}. Falling back to text processing.`);
        const text = await this.readUnstructured(fileBuffer, metadata.filename, metadata.mimetype);
        return { columnPreview: [], unstructuredText: text, warnings };
      }
    } else {
      logger.info("Processing as unstructured data");
      const text = await this.readUnstructured(fileBuffer, metadata.filename, metadata.mimetype);
      return { columnPreview: [], unstructuredText: text, warnings };
    }
  }

  private static looksTabular(filename: string, mimetype: string): boolean {
    const lower = filename.toLowerCase();
    const tabularExtensions = [".csv", ".xlsx", ".xls", ".tsv", ".json"];
    const tabularMimeTypes = ["csv", "excel", "sheet", "tab-separated", "json"];
    return (
      tabularExtensions.some((ext) => lower.endsWith(ext)) ||
      tabularMimeTypes.some((type) => mimetype?.toLowerCase().includes(type))
    );
  }

  private static async readTabular(buffer: Buffer, filename: string): Promise<any[]> {
    const lower = filename.toLowerCase();

    try {
      if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
        const delimiter = lower.endsWith(".tsv") ? "\t" : ",";
        return csvParse(buffer.toString("utf8"), {
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
    } catch (error) {
      throw new Error(`Failed to parse tabular data: ${error}`);
    }
  }

  private static profileColumns(rows: any[], sampleCount: number): ColumnPreview[] {
    if (!rows.length) return [];

    const columns = Object.keys(rows[0] || {});
    const analysisRows = rows.slice(0, CONFIG.PROCESSING.MAX_ROWS_TO_ANALYZE);

    return columns.map((name) => {
      const values = analysisRows.map((row) => String(row[name] ?? "")).filter((v) => v.trim());
      const allValues = analysisRows.map((row) => row[name]);

      const nullCount = allValues.filter((v) => v == null || v === "").length;
      const uniqueValues = new Set(values);
      const samples = Array.from(uniqueValues).slice(0, sampleCount);

      const detectedType = this.detectDataType(values.slice(0, CONFIG.PROCESSING.TYPE_DETECTION_SAMPLE_SIZE));
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

  private static detectDataType(values: string[]): DataType {
    if (!values.length) return "unknown";

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

    const scores: Record<string, number> = {
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
      if (patterns.email.test(trimmed)) scores.email++;
      else if (patterns.url.test(trimmed)) scores.url++;
      else if (patterns.phone.test(trimmed)) scores.phone++;
      else if (patterns.id.test(trimmed)) scores.id++;
      else if (patterns.number.test(trimmed)) scores.number++;
      else if (patterns.boolean.test(trimmed)) scores.boolean++;
      else if (!isNaN(Date.parse(trimmed)) && trimmed.length > 6) scores.date++;
    }

    const maxScore = Math.max(...Object.values(scores));
    const threshold = sampleSize * 0.6;

    if (maxScore < threshold) return "string";
    const winner = Object.entries(scores).find(([_, score]) => score === maxScore)?.[0];
    return (winner as DataType) || "string";
  }

  private static calculateStatistics(values: string[], type: DataType) {
    if (type !== "number" || !values.length) return undefined;
    const numbers = values.map(Number).filter((n) => !isNaN(n));
    if (!numbers.length) return undefined;

    return {
      min: Math.min(...numbers),
      max: Math.max(...numbers),
      avg: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    };
  }

  private static async readUnstructured(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
    const lower = filename.toLowerCase();

    try {
      if (lower.endsWith(".pdf") || mimetype?.includes("pdf")) {
        const { text } = await pdfParse(buffer);
        return this.truncateText(text, CONFIG.PROCESSING.MAX_TEXT_LENGTH);
      }

      const text = buffer.toString("utf8");
      return this.truncateText(text, CONFIG.PROCESSING.MAX_TEXT_LENGTH);
    } catch (error) {
      throw new Error(`Failed to extract text from file: ${error}`);
    }
  }

  private static truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const truncated = text.slice(0, maxLength);
    const lastSentence = truncated.lastIndexOf(".");
    return lastSentence > maxLength * 0.8 ? truncated.slice(0, lastSentence + 1) : truncated + "...";
  }
}

// -------------------------------------------------------------------------------------
// PROMPT BUILDER (unchanged, just kept here)
// -------------------------------------------------------------------------------------
class PromptBuilder {
  static buildEnhancedPrompt(options: {
    columnPreview: ColumnPreview[];
    unstructuredText: string;
    datasetId: string;
    businessContext?: string;
    extractionMode: string;
  }): string {
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
    } else {
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
export function deduplicateTerms(terms: GlossaryTerm[]): GlossaryTerm[] {
  const seen = new Map<string, GlossaryTerm>();

  for (const term of terms) {
    const normalizedTerm = term.term.trim().toLowerCase();

    if (!seen.has(normalizedTerm)) {
      seen.set(normalizedTerm, {
        ...term,
        term: term.term.trim(),
      });
    } else {
      const existing = seen.get(normalizedTerm)!;
      // keep higher confidence, merge sources
      const merged: GlossaryTerm = {
        ...existing,
        definition:
          (existing.definition?.length || 0) >= (term.definition?.length || 0)
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
export function createGlossaryExtractor() {
  const aiClient = new EnhancedGeminiClient();

  return {
    /**
     * Lightweight method for background workers:
     *  - Accepts a file buffer + minimal metadata
     *  - Auto-detects tabular vs unstructured
     *  - Builds prompt and calls Gemini
     *  - Returns terms + (optional) columnPreview + warnings
     */
    async extractFromFile(
      fileBuffer: Buffer,
      meta: { filename: string; mimetype: string; size: number },
      datasetId: string,
      businessContext?: string,
      extractionMode: "basic" | "comprehensive" = "comprehensive"
    ): Promise<ExtractionResult> {
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
      const deduped = deduplicateTerms((aiResponse?.terms as GlossaryTerm[]) || []);

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
export async function uploadAndExtractGlossary(req: Request, res: Response) {
  const startTime = Date.now();
  let tempFileMetadata: FileMetadata | null = null;

  try {
    logger.info("Starting glossary extraction process");

    // 1) Parse + validate
    const { fields, fileBuffer, filename, mimetype } = await readMultipartData(req);
    const validatedFields = await uploadSchema.validateAsync(fields);

    tempFileMetadata = {
      filename,
      mimetype,
      size: fileBuffer.length,
      datasetId: validatedFields.datasetId,
    };

    logger.info("File received", tempFileMetadata);

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
    logger.info(`Generated prompt (${prompt.length} characters)`);

    // 5) Gemini
    const aiResponse = await aiClient.extractTermsWithRetry(prompt);
    const deduplicatedTerms = deduplicateTerms(aiResponse.terms || []);
    logger.info(`Extracted ${deduplicatedTerms.length} unique terms`);

    // 6) Persist (optional if background job does this step)
    if (deduplicatedTerms.length > 0) {
      await dbClient.batchUpsertTerms(deduplicatedTerms, validatedFields.datasetId);
    }

    // 7) Respond
    const processingTime = Date.now() - startTime;
    const result: ProcessingResult = {
      datasetId: validatedFields.datasetId,
      termsExtracted: deduplicatedTerms.length,
      processingTime,
      fileMetadata: tempFileMetadata,
      terms: deduplicatedTerms,
      warnings: warnings.length ? warnings : undefined,
    };

    logger.info(`Glossary extraction completed successfully in ${processingTime}ms`);
    res.json(result);
  } catch (error: any) {
    const processingTime = Date.now() - startTime;
    logger.error("Glossary extraction failed", {
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
async function readMultipartData(req: Request): Promise<{
  fields: Record<string, unknown>;
  fileBuffer: Buffer;
  filename: string;
  mimetype: string;
}> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields: Record<string, unknown> = {};
    const chunks: Buffer[] = [];
    let filename = "";
    let mimetype = "";
    let fileReceived = false;

    busboy.on("file", (_fieldname, file, info) => {
      if (fileReceived) return reject(new Error("Multiple files not supported"));

      fileReceived = true;
      filename = info.filename;
      mimetype = info.mimeType;

      file.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        const currentSize = chunks.reduce((total, c) => total + c.length, 0);
        if (currentSize > CONFIG.PROCESSING.MAX_FILE_SIZE) {
          file.destroy();
          reject(new Error(`File too large (max: ${CONFIG.PROCESSING.MAX_FILE_SIZE} bytes)`));
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
      } else {
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
  logger.info("Shutting down gracefully");
  process.exit(0);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
});
