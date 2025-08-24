// routes/chatbot.ts
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { query } from "../db";
import * as admin from "firebase-admin";

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Type definitions
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  session_id: string;
  user_id: string;
}

interface ChatSession {
  id: string;
  user_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

// Auth middleware
type AuthedReq = express.Request & { user?: admin.auth.DecodedIdToken };

const requireAuth: express.RequestHandler = async (req: AuthedReq, res, next) => {
  const sessionCookieName = process.env.SESSION_COOKIE_NAME || "__session";
  const token = req.cookies[sessionCookieName] || "";
  
  try {
    const decoded = await admin.auth().verifySessionCookie(token, true);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED" });
  }
};

const router = express.Router();

// Initialize database tables if they don't exist
async function initializeChatTables() {
  try {
    // Create chat_sessions table
    await query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create chat_messages table
    await query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create indexes for better performance
    await query(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages(user_id);
    `);

    console.log("Chat tables initialized successfully");
  } catch (error) {
    console.error("Error initializing chat tables:", error);
  }
}

// Initialize tables on module load
initializeChatTables();

// System prompt for SyncMate AI Assistant
const SYSTEM_PROMPT = `You are SyncMate AI Assistant, an expert compliance and data governance assistant for BPI and Ayala Companies. You help users analyze compliance issues, explain resolution workflows, and provide insights about cross-entity data alignment.

Your expertise includes:
- Compliance issue analysis and resolution
- Data governance and quality management
- Cross-entity data alignment (BPI, Ayala Land, Globe, AC Energy)
- Risk assessment and mitigation strategies
- Data stewardship best practices
- Regulatory compliance across financial and real estate sectors

You should:
- Provide clear, actionable insights
- Reference specific compliance frameworks when relevant
- Suggest practical solutions for data quality issues
- Explain complex compliance concepts in accessible terms
- Prioritize recommendations based on risk and impact

Current context: The user is working with a Data Team Operational Dashboard that tracks compliance issues across BPI and Ayala Company partnerships.`;

// Get compliance context for better responses
async function getComplianceContext(userId: string): Promise<string> {
  try {
    // This would fetch recent compliance issues, user role, etc.
    // For now, return static context based on the dashboard data
    return `
Recent compliance landscape:
- 23 active compliance issues across BPI partnerships
- Primary concerns: Duplicate records (15% of joint applications), SME definition mismatches, outdated thresholds
- Entity collaboration health: BPI-Ayala Land (92%), BPI-Globe (78%), BPI-AC Energy (95%)
- Current resolution rate: 87% with average resolution time of 2.3 days
- High priority: Customer ID reconciliation, unified SME classification, credit scoring threshold updates
    `;
  } catch (error) {
    console.error("Error fetching compliance context:", error);
    return "";
  }
}

// Generate title for chat session based on first message
async function generateChatTitle(firstMessage: string): Promise<string> {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const prompt = `Generate a concise, descriptive title (max 6 words) for this chat conversation. First message: "${firstMessage}"`;
    
    const result = await model.generateContent(prompt);
    const title = result.response.text().trim();
    
    // Clean up the title and ensure it's not too long
    return title.replace(/['"]/g, '').substring(0, 50);
  } catch (error) {
    console.error("Error generating chat title:", error);
    // Fallback to a generic title based on content
    if (firstMessage.toLowerCase().includes('compliance')) return 'Compliance Discussion';
    if (firstMessage.toLowerCase().includes('issue')) return 'Issue Resolution';
    if (firstMessage.toLowerCase().includes('data')) return 'Data Analysis';
    return 'Chat Session';
  }
}

// Routes

// 1. Create new chat session
router.post('/sessions', requireAuth, async (req: AuthedReq, res) => {
  try {
    const userId = req.user!.uid;
    const { title = 'New Chat' } = req.body;

    const result = await query(
      'INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING *',
      [userId, title]
    );

    res.json({ session: result.rows[0] });
  } catch (error) {
    console.error('Error creating chat session:', error);
    res.status(500).json({ error: 'Failed to create chat session' });
  }
});

// 2. Get all chat sessions for user
router.get('/sessions', requireAuth, async (req: AuthedReq, res) => {
  try {
    const userId = req.user!.uid;

    const result = await query(
      'SELECT * FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 20',
      [userId]
    );

    res.json({ sessions: result.rows });
  } catch (error) {
    console.error('Error fetching chat sessions:', error);
    res.status(500).json({ error: 'Failed to fetch chat sessions' });
  }
});

// 3. Get messages for a specific session
router.get('/sessions/:sessionId/messages', requireAuth, async (req: AuthedReq, res) => {
  try {
    const userId = req.user!.uid;
    const { sessionId } = req.params;

    // Verify session belongs to user
    const sessionResult = await query(
      'SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const messagesResult = await query(
      'SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY timestamp ASC',
      [sessionId]
    );

    res.json({ messages: messagesResult.rows });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// 4. Send message and get AI response
router.post('/sessions/:sessionId/messages', requireAuth, async (req: AuthedReq, res) => {
  try {
    const userId = req.user!.uid;
    const { sessionId } = req.params;
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Verify session belongs to user
    const sessionResult = await query(
      'SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Check if this is the first message and update title if needed
    const messageCountResult = await query(
      'SELECT COUNT(*) FROM chat_messages WHERE session_id = $1',
      [sessionId]
    );
    
    const isFirstMessage = parseInt(messageCountResult.rows[0].count) === 0;

    // Save user message
    const userMessageResult = await query(
      'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [sessionId, userId, 'user', message]
    );

    // Get conversation history
    const historyResult = await query(
      'SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY timestamp ASC LIMIT 20',
      [sessionId]
    );

    // Build conversation context
    const conversationHistory = historyResult.rows
      .map(msg => `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');

    // Get compliance context
    const complianceContext = await getComplianceContext(userId);

    // Generate AI response
    const model = genAI.getGenerativeModel({ 
      model: "gemini-pro",
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.8,
        maxOutputTokens: 1024,
      },
    });

    const fullPrompt = `${SYSTEM_PROMPT}

${complianceContext}

Conversation History:
${conversationHistory}

Please provide a helpful, accurate response as SyncMate AI Assistant. Be specific about compliance issues, data governance practices, and cross-entity collaboration when relevant.`;

    const result = await model.generateContent(fullPrompt);
    const aiResponse = result.response.text();

    // Save AI response
    const aiMessageResult = await query(
      'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [sessionId, userId, 'assistant', aiResponse]
    );

    // Update session timestamp
    await query(
      'UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1',
      [sessionId]
    );

    // Update session title if this is the first message
    if (isFirstMessage) {
      try {
        const newTitle = await generateChatTitle(message);
        await query(
          'UPDATE chat_sessions SET title = $1 WHERE id = $2',
          [newTitle, sessionId]
        );
      } catch (error) {
        console.error('Error updating session title:', error);
      }
    }

    res.json({
      userMessage: userMessageResult.rows[0],
      aiMessage: aiMessageResult.rows[0]
    });

  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// 5. Delete chat session
router.delete('/sessions/:sessionId', requireAuth, async (req: AuthedReq, res) => {
  try {
    const userId = req.user!.uid;
    const { sessionId } = req.params;

    const result = await query(
      'DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2 RETURNING id',
      [sessionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting chat session:', error);
    res.status(500).json({ error: 'Failed to delete chat session' });
  }
});

// 6. Update session title
router.patch('/sessions/:sessionId', requireAuth, async (req: AuthedReq, res) => {
  try {
    const userId = req.user!.uid;
    const { sessionId } = req.params;
    const { title } = req.body;

    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = await query(
      'UPDATE chat_sessions SET title = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
      [title, sessionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ session: result.rows[0] });
  } catch (error) {
    console.error('Error updating session title:', error);
    res.status(500).json({ error: 'Failed to update session title' });
  }
});

// 7. Quick action endpoints for the dashboard
router.post('/quick-action', requireAuth, async (req: AuthedReq, res) => {
  try {
    const userId = req.user!.uid;
    const { action, context } = req.body;

    let prompt = '';
    
    switch (action) {
      case 'explain-comp-001':
        prompt = 'Explain the duplicate records issue COMP-001 in detail, including causes and resolution steps.';
        break;
      case 'resolution-timeline':
        prompt = 'Provide a typical resolution timeline for compliance issues, broken down by issue type and severity.';
        break;
      case 'risk-assessment':
        prompt = 'Analyze the current risk landscape based on active compliance issues and provide mitigation recommendations.';
        break;
      case 'best-practices':
        prompt = 'Share best practices for cross-entity data governance and compliance management.';
        break;
      default:
        prompt = context || 'Provide general guidance on compliance and data governance.';
    }

    const complianceContext = await getComplianceContext(userId);
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const fullPrompt = `${SYSTEM_PROMPT}

${complianceContext}

User request: ${prompt}

Provide a focused, actionable response.`;

    const result = await model.generateContent(fullPrompt);
    const response = result.response.text();

    res.json({ response });
  } catch (error) {
    console.error('Error processing quick action:', error);
    res.status(500).json({ error: 'Failed to process quick action' });
  }
});

export { router as chatbotRouter };