// src/lib/glossary-types.ts
export interface FileData {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  size: number;
  fieldName: string; // form field name (e.g., 'file1', 'file2')
}

export interface ProcessedFile {
  fileData: FileData;
  columnPreview: ColumnPreview[];
  unstructuredText: string;
  warnings: string[];
  processingTime: number;
}

export interface MultiFileResult {
  totalFiles: number;
  successfulFiles: number;
  failedFiles: FailedFile[];
  totalTermsExtracted: number;
  totalProcessingTime: number;
  datasetId: string;
  results: SingleFileResult[];
  globalWarnings: string[];
}

export interface SingleFileResult {
  filename: string;
  termsExtracted: number;
  processingTime: number;
  terms: GlossaryTerm[];
  warnings: string[];
  status: 'success' | 'failed';
  error?: string;
}

export interface FailedFile {
  filename: string;
  error: string;
  size?: number;
}

export interface ColumnPreview {
  name: string;
  detectedType: DataType;
  samples: string[];
  nullCount: number;
  uniqueCount: number;
  sourceFile: string; // Track which file this column came from
  statistics?: {
    min?: number;
    max?: number;
    avg?: number;
  };
}

export interface GlossaryTerm {
  term: string;
  definition: string;
  source_columns: string[];
  source_files?: string[]; // Track which files contain this term
  data_types?: string[];
  sample_values?: string[];
  synonyms?: string[];
  category?: string;
  confidence: number;
}

export type DataType = "string" | "number" | "date" | "boolean" | "email" | "url" | "phone" | "id" | "unknown";

export interface ProcessingOptions {
  processingMode: 'parallel' | 'sequential';
  extractionMode: 'comprehensive' | 'basic';
  mergeTerms: boolean;
  businessContext?: string;
}

export interface DatabaseConfig {
  connectionString: string;
  maxConnections?: number;
  connectionTimeout?: number;
}

export interface AIConfig {
  model: string;
  maxRetries: number;
  retryDelay: number;
  requestTimeout: number;
}

