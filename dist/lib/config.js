"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.CONFIG = void 0;
exports.validateEnvironment = validateEnvironment;
// src/lib/config.ts
const winston_1 = __importDefault(require("winston"));
// Configuration
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
    SUPABASE: {
        BUCKET: process.env.SUPABASE_BUCKET || "reports",
    }
};
// Logger setup
exports.logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.errors({ stack: true }), winston_1.default.format.json()),
    transports: [
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple())
        }),
        new winston_1.default.transports.File({
            filename: "logs/glossary-extractor.log",
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5
        }),
    ],
});
// Create logs directory if it doesn't exist
const fs_1 = __importDefault(require("fs"));
if (!fs_1.default.existsSync('logs')) {
    fs_1.default.mkdirSync('logs');
}
// Validation functions
function validateEnvironment() {
    const required = [
        'GOOGLE_AI_STUDIO_API_KEY',
        'DATABASE_URL'
    ];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}
