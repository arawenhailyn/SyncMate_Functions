"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGeminiModel = getGeminiModel;
// src/lib/gemini.ts
const generative_ai_1 = require("@google/generative-ai");
const genAI = new generative_ai_1.GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
function getGeminiModel() {
    return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
}
