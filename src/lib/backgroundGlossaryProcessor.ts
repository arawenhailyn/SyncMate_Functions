// src/lib/backgroundGlossaryProcessor.ts
import { supabase } from "./supabase";
import { CONFIG } from "./config";
import { createGlossaryExtractor } from "../services/glossaryExtractor";
import { logger } from "./config";
import type { GlossaryTerm, ColumnPreview } from "./glossary-types";

const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "reports";

export class BackgroundGlossaryProcessor {
  private static instance: BackgroundGlossaryProcessor;
  private glossaryExtractor: any = null;
  private processingQueue = new Set<string>();

  private constructor() {}

  static getInstance(): BackgroundGlossaryProcessor {
    if (!BackgroundGlossaryProcessor.instance) {
      BackgroundGlossaryProcessor.instance = new BackgroundGlossaryProcessor();
    }
    return BackgroundGlossaryProcessor.instance;
  }

  /**
   * Initialize the Gemini extractor
   */
  private async initializeExtractor(): Promise<void> {
    if (!this.glossaryExtractor) {
      try {
        this.glossaryExtractor = createGlossaryExtractor();
        logger.info("Glossary extractor initialized successfully");
      } catch (error) {
        logger.error("Failed to initialize glossary extractor", { error });
        throw error;
      }
    }
  }

  /**
   * Process file for glossary/rule extraction - main entry point
   */
  async processFileInBackground(fileId: string, storagePath: string): Promise<void> {
    // Prevent duplicate processing
    if (this.processingQueue.has(fileId)) {
      logger.warn("File already being processed", { fileId });
      return;
    }

    this.processingQueue.add(fileId);

    try {
      await this.initializeExtractor();

      logger.info("Starting background glossary processing", {
        fileId,
        storagePath,
      });

      // Update status to processing
      await this.updateProcessingStatus(fileId, "processing");

      // Download file from Supabase storage
      const fileBuffer = await this.downloadFileFromStorage(storagePath);

      // Get file metadata from database
      const fileMetadata = await this.getFileMetadata(fileId);
      if (!fileMetadata) {
        throw new Error(`File metadata not found for ID: ${fileId}`);
      }

      // Extract terms (and rules for PDFs / policy docs)
      const { terms: extractedTerms, rules: extractedRules, columnPreview, warnings } =
        await this.extractFromFile(fileBuffer, fileMetadata, fileId);

      // Save terms
      await this.saveExtractedTerms(fileId, extractedTerms, fileMetadata.filename);

      // Save rules (if any)
      const rulesInserted = await this.saveExtractedRules(
        fileId,
        extractedRules,
        fileMetadata.filename
      );

      // Update status to processed
      await this.updateProcessingStatus(fileId, "processed", {
        extracted_terms_count: extractedTerms.length,
        extracted_rules_count: rulesInserted,
        processed_at: new Date().toISOString(),
      });

      logger.info("Glossary processing completed successfully", {
        fileId,
        termsExtracted: extractedTerms.length,
        rulesExtracted: rulesInserted,
      });
    } catch (error) {
      logger.error("Background glossary processing failed", {
        fileId,
        storagePath,
        error: error instanceof Error ? error.message : error,
      });

      // Update status to failed
      await this.updateProcessingStatus(fileId, "failed", {
        error_message: error instanceof Error ? error.message : "Unknown error",
        processed_at: new Date().toISOString(),
      });
    } finally {
      this.processingQueue.delete(fileId);
    }
  }

  /**
   * Download file from Supabase storage
   */
  private async downloadFileFromStorage(storagePath: string): Promise<Buffer> {
    logger.debug("Downloading file from storage", { storagePath });

    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(storagePath);

    if (error || !data) {
      throw new Error(`Failed to download file: ${error?.message || "No data"}`);
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    logger.debug("File downloaded successfully", {
      storagePath,
      sizeBytes: buffer.length,
    });

    return buffer;
  }

  /**
   * Get file metadata from database
   */
  private async getFileMetadata(fileId: string): Promise<FileMetadata | null> {
    const { data, error } = await supabase
      .from("uploaded_files")
      .select("filename, mime_type, file_size")
      .eq("id", fileId)
      .single();

    if (error) {
      logger.error("Failed to get file metadata", { fileId, error });
      return null;
    }

    return {
      filename: data.filename,
      mimetype: data.mime_type,
      size: data.file_size,
    };
  }

  /**
   * Extract glossary terms and (optionally) policy rules from file using the extractor.
   * Your extractor should support PDFs and return { terms, rules, columnPreview, warnings }.
   */
  private async extractFromFile(
    fileBuffer: Buffer,
    metadata: FileMetadata,
    fileId: string
  ): Promise<{
    terms: GlossaryTerm[];
    rules: PolicyRule[];
    columnPreview?: ColumnPreview[];
    warnings: string[];
  }> {
    if (!this.glossaryExtractor) {
      throw new Error("Glossary extractor not initialized");
    }

    logger.info("Processing file for term extraction", {
      filename: metadata.filename,
      mimetype: metadata.mimetype,
      size: metadata.size,
    });

    // Hint: PDFs are often "policy" mode; CSV/XLS(X) are tabular
    const isPdf =
      metadata.mimetype?.toLowerCase().includes("pdf") ||
      metadata.filename?.toLowerCase().endsWith(".pdf");

    const result = await this.glossaryExtractor.extractFromFile(
      fileBuffer,
      {
        filename: metadata.filename,
        mimetype: metadata.mimetype,
        size: metadata.size,
      },
      `file_${fileId}`,
      this.inferBusinessContext(metadata.filename),
      this.determineExtractionMode(metadata),
      // optional: pass a mode hint if your extractor supports it
      isPdf ? { mode: "policy" } : { mode: "tabular" }
    );

    const terms: GlossaryTerm[] = Array.isArray(result?.terms) ? result.terms : [];
    const rules: PolicyRule[] = Array.isArray(result?.rules) ? result.rules : [];

    logger.info("Term extraction completed", {
      fileId,
      termsFound: terms.length,
    });

    if (rules.length) {
      logger.info("Policy rules extraction completed", {
        fileId,
        rulesFound: rules.length,
      });
    }

    return {
      terms,
      rules,
      columnPreview: result?.columnPreview,
      warnings: result?.warnings || [],
    };
  }

  /**
   * Save extracted terms to the database (data_glossary)
   * Requires columns:
   *   term, definition, source_columns, data_types, sample_values, synonyms, category, confidence,
   *   source_file_id, source_filename, dataset_id, created_at, updated_at
   */
  private async saveExtractedTerms(
    fileId: string,
    terms: GlossaryTerm[],
    sourceFilename: string
  ): Promise<void> {
    if (!terms.length) {
      logger.info("No terms to save", { fileId });
      return;
    }

    logger.info("Saving extracted terms to database", {
      fileId,
      termsCount: terms.length,
    });

    const nowIso = new Date().toISOString();
    const datasetId = `file_${fileId}`;

    const rows = terms.map((t) => ({
      term: t.term,
      definition: t.definition,
      source_columns: t.source_columns || [],
      data_types: t.data_types || [],
      sample_values: t.sample_values || [],
      synonyms: t.synonyms || [],
      category: t.category || "General",
      confidence: Math.max(0, Math.min(1, t.confidence ?? 0.6)),
      source_file_id: fileId,
      source_filename: sourceFilename,
      dataset_id: datasetId,
      created_at: nowIso,
      updated_at: nowIso,
    }));

    const { error } = await supabase
      .from("data_glossary")
      .upsert(rows, { onConflict: "term,dataset_id", ignoreDuplicates: false });

    if (error) {
      logger.error("Failed to save terms to database", { fileId, error: error.message });
      throw new Error(`Database insertion failed: ${error.message}`);
    }

    logger.info("Terms saved successfully", { fileId, termsCount: terms.length });
  }

  /**
   * Save extracted policy rules to the database (policy_rules)
   * Requires table policy_rules with columns:
   *   source_file_id, source_filename, rule_code, rule_text, citations, tags, severity, effective_date, confidence
   * Returns number of inserted rows.
   */
  private async saveExtractedRules(
    fileId: string,
    rules: PolicyRule[],
    sourceFilename: string
  ): Promise<number> {
    if (!rules?.length) return 0;

    logger.info("Saving extracted policy rules to database", {
      fileId,
      rulesCount: rules.length,
    });

    const rows = rules.map((r) => ({
      source_file_id: fileId,
      source_filename: sourceFilename,
      rule_code: r.rule_code ?? null,
      rule_text: r.rule_text ?? "",
      citations: r.citations || [],
      tags: r.tags || [],
      severity: r.severity ?? null,
      effective_date: r.effective_date ?? null, // "YYYY-MM-DD" string or null
      confidence: typeof r.confidence === "number" ? r.confidence : null,
    }));

    const { error } = await supabase.from("policy_rules").insert(rows);
    if (error) {
      logger.error("Failed to save rules to database", { fileId, error: error.message });
      throw new Error(`Rules insertion failed: ${error.message}`);
    }

    logger.info("Rules saved successfully", { fileId, rulesCount: rules.length });
    return rules.length;
  }

  /**
   * Update processing status in the database
   * Ex: status in ('pending','processing','processed','failed')
   */
  private async updateProcessingStatus(
    fileId: string,
    status: "processing" | "processed" | "failed",
    additionalData?: Record<string, any>
  ): Promise<void> {
    const updateData = {
      processing_status: status,
      updated_at: new Date().toISOString(), // make sure column exists (we added it)
      ...(additionalData || {}),
    };

    const { error } = await supabase.from("uploaded_files").update(updateData).eq("id", fileId);

    if (error) {
      logger.error("Failed to update processing status", {
        fileId,
        status,
        error: error.message,
      });
      throw error;
    }

    logger.debug("Processing status updated", { fileId, status });
  }

  /**
   * Infer business context from filename
   */
  private inferBusinessContext(filename: string): string {
    const lower = filename.toLowerCase();

    const contexts = [
      { keywords: ["customer", "client", "user"], context: "Customer Management" },
      { keywords: ["financial", "finance", "revenue", "payment"], context: "Financial Data" },
      { keywords: ["product", "inventory", "catalog"], context: "Product Management" },
      { keywords: ["sales", "order", "transaction"], context: "Sales & Transactions" },
      { keywords: ["employee", "staff", "hr"], context: "Human Resources" },
      { keywords: ["marketing", "campaign", "lead"], context: "Marketing" },
      { keywords: ["report", "analytics", "metrics"], context: "Business Analytics" },
      { keywords: ["policy", "guideline", "manual", "procedure"], context: "Policies & Compliance" },
    ];

    for (const { keywords, context } of contexts) {
      if (keywords.some((keyword) => lower.includes(keyword))) {
        return context;
      }
    }

    return "General Business Data";
  }

  /**
   * Determine extraction mode based on file characteristics
   */
  private determineExtractionMode(metadata: FileMetadata): "basic" | "comprehensive" {
    // Comprehensive for larger files, spreadsheets, or PDFs
    if (
      metadata.size > 1024 * 1024 || // > 1MB
      /excel|csv|spreadsheet/i.test(metadata.mimetype) ||
      /\.xlsx?$|\.csv$/i.test(metadata.filename) ||
      /pdf/i.test(metadata.mimetype) ||
      /\.pdf$/i.test(metadata.filename)
    ) {
      return "comprehensive";
    }
    return "basic";
  }

  /**
   * Get processing status for a file
   */
  async getProcessingStatus(fileId: string): Promise<ProcessingStatus | null> {
    const { data, error } = await supabase
      .from("uploaded_files")
      .select(
        `
        processing_status,
        extracted_terms_count,
        extracted_rules_count,
        error_message,
        processed_at,
        filename
      `
      )
      .eq("id", fileId)
      .single();

    if (error) {
      logger.error("Failed to get processing status", { fileId, error });
      return null;
    }

    return {
      status: data.processing_status,
      extractedTerms: data.extracted_terms_count || 0,
      extractedRules: data.extracted_rules_count || 0,
      errorMessage: data.error_message,
      processedAt: data.processed_at,
      filename: data.filename,
      isProcessing: this.processingQueue.has(fileId),
    };
  }

  /**
   * Get extracted terms for a file
   */
  async getExtractedTerms(fileId: string): Promise<GlossaryTerm[]> {
    const { data, error } = await supabase
      .from("data_glossary")
      .select("*")
      .eq("source_file_id", fileId)
      .order("confidence", { ascending: false });

    if (error) {
      logger.error("Failed to get extracted terms", { fileId, error });
      return [];
    }

    return (data || []).map((row: any) => ({
      term: row.term,
      definition: row.definition,
      source_columns: row.source_columns || [],
      data_types: row.data_types || [],
      sample_values: row.sample_values || [],
      synonyms: row.synonyms || [],
      category: row.category || "General",
      confidence: row.confidence || 0.5,
      source_files: row.source_filename ? [row.source_filename] : [],
    }));
  }
}

// Helper types
interface FileMetadata {
  filename: string;
  mimetype: string;
  size: number;
}

interface ProcessingStatus {
  status: "pending" | "processing" | "processed" | "failed";
  extractedTerms: number;
  extractedRules: number;
  errorMessage?: string;
  processedAt?: string;
  filename: string;
  isProcessing: boolean;
}

interface PolicyRule {
  rule_code?: string | null;
  rule_text: string; // REQUIRED
  citations?: string[];
  tags?: string[];
  severity?: string | null;
  effective_date?: string | null; // "YYYY-MM-DD" if parsed
  confidence?: number | null;
}

// Export singleton instance and convenience functions
const backgroundProcessor = BackgroundGlossaryProcessor.getInstance();

/**
 * Main function to trigger background processing
 */
export async function processFileInBackground(fileId: string, storagePath: string): Promise<void> {
  // Fire-and-forget; errors are logged inside the class
  backgroundProcessor.processFileInBackground(fileId, storagePath).catch((error) => {
    logger.error("Unhandled error in background processing", { fileId, error });
  });
}

/**
 * Get processing status for a file
 */
export async function getFileProcessingStatus(fileId: string): Promise<ProcessingStatus | null> {
  return backgroundProcessor.getProcessingStatus(fileId);
}

/**
 * Get extracted terms for a file
 */
export async function getFileExtractedTerms(fileId: string): Promise<GlossaryTerm[]> {
  return backgroundProcessor.getExtractedTerms(fileId);
}
