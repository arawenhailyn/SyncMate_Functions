// src/lib/config.ts
import winston from "winston";

// Configuration
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
  SUPABASE: {
    BUCKET: process.env.SUPABASE_BUCKET || "reports",
  }
} as const;

// Logger setup
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ 
      filename: "logs/glossary-extractor.log",
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    }),
  ],
});

// Create logs directory if it doesn't exist
import fs from 'fs';
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

// Validation functions
export function validateEnvironment() {
  const required = [
    'GOOGLE_AI_STUDIO_API_KEY',
    'DATABASE_URL'
  ];
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}