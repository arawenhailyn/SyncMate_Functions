// src/lib/backgroundGlossaryProcessor.ts
import { supabase } from "./supabase";
import { CONFIG } from "./config";
import { createGlossaryExtractor, deduplicateTerms, FileProcessor } from "../services/glossaryExtractor";
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
   * Process file for glossary extraction - main entry point
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
        storagePath 
      });

      // Update status to processing
      await this.updateProcessingStatus(fileId, 'processing');

      // Download file from Supabase storage
      const fileBuffer = await this.downloadFileFromStorage(storagePath);
      
      // Get file metadata from database
      const fileMetadata = await this.getFileMetadata(fileId);
      
      if (!fileMetadata) {
        throw new Error(`File metadata not found for ID: ${fileId}`);
      }

      // Process file and extract terms
      const { terms: extractedTerms, columnPreview, warnings } = await this.extractTermsFromFile(
        fileBuffer, 
        fileMetadata,
        fileId
      );

      // Save terms to database
      await this.saveExtractedTerms(fileId, extractedTerms, fileMetadata.filename);

      // Update status to completed
      await this.updateProcessingStatus(fileId, 'completed', {
        extracted_terms_count: extractedTerms.length,
        processed_at: new Date().toISOString()
      });

      logger.info("Glossary processing completed successfully", {
        fileId,
        termsExtracted: extractedTerms.length
      });

    } catch (error) {
      logger.error("Background glossary processing failed", {
        fileId,
        storagePath,
        error: error instanceof Error ? error.message : error
      });

      // Update status to failed
      await this.updateProcessingStatus(fileId, 'failed', {
        error_message: error instanceof Error ? error.message : 'Unknown error'
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
    
    const { data, error } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .download(storagePath);

    if (error || !data) {
      throw new Error(`Failed to download file: ${error?.message || 'No data'}`);
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    logger.debug("File downloaded successfully", { 
      storagePath, 
      sizeBytes: buffer.length 
    });

    return buffer;
  }

  /**
   * Get file metadata from database
   */
  private async getFileMetadata(fileId: string): Promise<FileMetadata | null> {
    const { data, error } = await supabase
      .from('uploaded_files')
      .select('filename, mime_type, file_size')
      .eq('id', fileId)
      .single();

    if (error) {
      logger.error("Failed to get file metadata", { fileId, error });
      return null;
    }

    return {
      filename: data.filename,
      mimetype: data.mime_type,
      size: data.file_size
    };
  }

  /**
   * Extract glossary terms from file using Gemini
   */
  private async extractTermsFromFile(
    fileBuffer: Buffer, 
    metadata: FileMetadata,
    fileId: string
  ): Promise<{ terms: GlossaryTerm[]; columnPreview?: ColumnPreview[]; warnings: string[] }> {
    if (!this.glossaryExtractor) {
      throw new Error("Glossary extractor not initialized");
    }

    logger.info("Processing file for term extraction", {
      filename: metadata.filename,
      size: metadata.size,
      mimetype: metadata.mimetype
    });

    // Use the extractor's extractFromFile method
    const result = await this.glossaryExtractor.extractFromFile(
      fileBuffer,
      {
        filename: metadata.filename,
        mimetype: metadata.mimetype,
        size: metadata.size
      },
      `file_${fileId}`,
      this.inferBusinessContext(metadata.filename),
      this.determineExtractionMode(metadata)
    );

    logger.info("Term extraction completed", {
      fileId,
      termsFound: result.terms.length
    });

    return {
      terms: result.terms,
      columnPreview: result.columnPreview,
      warnings: result.warnings || []
    };
  }

  /**
   * Save extracted terms to the database
   */
  private async saveExtractedTerms(
    fileId: string, 
    terms: GlossaryTerm[], 
    sourceFilename: string
  ): Promise<void> {
    if (terms.length === 0) {
      logger.info("No terms to save", { fileId });
      return;
    }

    logger.info("Saving extracted terms to database", {
      fileId,
      termsCount: terms.length
    });

    // Prepare terms for database insertion
    const termsToInsert = terms.map(term => ({
      term: term.term,
      definition: term.definition,
      source_columns: term.source_columns,
      data_types: term.data_types || [],
      sample_values: term.sample_values || [],
      synonyms: term.synonyms || [],
      category: term.category || 'General',
      confidence: Math.max(0, Math.min(1, term.confidence || 0.6)),
      source_file_id: fileId,
      source_filename: sourceFilename,
      dataset_id: `file_${fileId}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));

    // Insert terms into data_glossary table
    const { error } = await supabase
      .from('data_glossary')
      .upsert(termsToInsert, {
        onConflict: 'term,dataset_id',
        ignoreDuplicates: false
      });

    if (error) {
      logger.error("Failed to save terms to database", { 
        fileId, 
        error: error.message 
      });
      throw new Error(`Database insertion failed: ${error.message}`);
    }

    logger.info("Terms saved successfully", { fileId, termsCount: terms.length });
  }

  /**
   * Update processing status in the database
   */
  private async updateProcessingStatus(
    fileId: string, 
    status: 'processing' | 'completed' | 'failed',
    additionalData?: Record<string, any>
  ): Promise<void> {
    const updateData = {
      processing_status: status,
      updated_at: new Date().toISOString(),
      ...additionalData
    };

    const { error } = await supabase
      .from('uploaded_files')
      .update(updateData)
      .eq('id', fileId);

    if (error) {
      logger.error("Failed to update processing status", { 
        fileId, 
        status, 
        error: error.message 
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
      { keywords: ['customer', 'client', 'user'], context: 'Customer Management' },
      { keywords: ['financial', 'finance', 'revenue', 'payment'], context: 'Financial Data' },
      { keywords: ['product', 'inventory', 'catalog'], context: 'Product Management' },
      { keywords: ['sales', 'order', 'transaction'], context: 'Sales & Transactions' },
      { keywords: ['employee', 'staff', 'hr'], context: 'Human Resources' },
      { keywords: ['marketing', 'campaign', 'lead'], context: 'Marketing' },
      { keywords: ['report', 'analytics', 'metrics'], context: 'Business Analytics' },
    ];

    for (const { keywords, context } of contexts) {
      if (keywords.some(keyword => lower.includes(keyword))) {
        return context;
      }
    }

    return 'General Business Data';
  }

  /**
   * Determine extraction mode based on file characteristics
   */
  private determineExtractionMode(metadata: FileMetadata): 'basic' | 'comprehensive' {
    // Use comprehensive mode for larger files or specific types
    if (metadata.size > 1024 * 1024 || // Files > 1MB
        metadata.mimetype.includes('excel') ||
        metadata.mimetype.includes('csv')) {
      return 'comprehensive';
    }
    return 'basic';
  }

  /**
   * Get processing status for a file
   */
  async getProcessingStatus(fileId: string): Promise<ProcessingStatus | null> {
    const { data, error } = await supabase
      .from('uploaded_files')
      .select(`
        processing_status,
        extracted_terms_count,
        error_message,
        processed_at,
        filename
      `)
      .eq('id', fileId)
      .single();

    if (error) {
      logger.error("Failed to get processing status", { fileId, error });
      return null;
    }

    return {
      status: data.processing_status,
      extractedTerms: data.extracted_terms_count || 0,
      errorMessage: data.error_message,
      processedAt: data.processed_at,
      filename: data.filename,
      isProcessing: this.processingQueue.has(fileId)
    };
  }

  /**
   * Get extracted terms for a file
   */
  async getExtractedTerms(fileId: string): Promise<GlossaryTerm[]> {
    const { data, error } = await supabase
      .from('data_glossary')
      .select('*')
      .eq('source_file_id', fileId)
      .order('confidence', { ascending: false });

    if (error) {
      logger.error("Failed to get extracted terms", { fileId, error });
      return [];
    }

    return data.map(row => ({
      term: row.term,
      definition: row.definition,
      source_columns: row.source_columns || [],
      data_types: row.data_types || [],
      sample_values: row.sample_values || [],
      synonyms: row.synonyms || [],
      category: row.category || 'General',
      confidence: row.confidence || 0.5,
      source_files: [row.source_filename]
    }));
  }
}

// Helper interfaces
interface FileMetadata {
  filename: string;
  mimetype: string;
  size: number;
}

interface ProcessingStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  extractedTerms: number;
  errorMessage?: string;
  processedAt?: string;
  filename: string;
  isProcessing: boolean;
}

// Export singleton instance and convenience functions
const backgroundProcessor = BackgroundGlossaryProcessor.getInstance();

/**
 * Main function to trigger background processing
 */
export async function processFileInBackground(fileId: string, storagePath: string): Promise<void> {
  // Don't await - let it run in background
  backgroundProcessor.processFileInBackground(fileId, storagePath).catch(error => {
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
