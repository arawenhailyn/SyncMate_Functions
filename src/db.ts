// src/db.ts - Unified database connection
import { Client } from "pg";

// Determine SSL configuration based on environment
const getSSLConfig = () => {
  // For services like Supabase, Heroku Postgres, etc., you typically need SSL
  if (process.env.DATABASE_URL?.includes('supabase') || 
      process.env.DATABASE_URL?.includes('amazonaws') ||
      process.env.NODE_ENV === 'production') {
    return { rejectUnauthorized: false };
  }
  // For local development, usually no SSL needed
  return false;
};

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: getSSLConfig(),
});

let connected = false;

export async function db() {
  if (!connected) {
    try {
      await client.connect();
      connected = true;
      console.log("Database connected successfully");
    } catch (error) {
      console.error("Failed to connect to database:", error);
      console.error("Database URL:", process.env.DATABASE_URL ? "Set" : "Not set");
      throw error;
    }
  }
  return client;
}

// Helper function to execute queries with error handling
export async function query(text: string, params?: any[]) {
  const dbClient = await db();
  try {
    const result = await dbClient.query(text, params);
    return result;
  } catch (error) {
    console.error("Database query error:", error);
    console.error("Query:", text);
    console.error("Params:", params);
    throw error;
  }
}

// Optional: Add a cleanup function for graceful shutdown
export async function closeDb() {
  if (connected) {
    await client.end();
    connected = false;
    console.log("Database connection closed");
  }
}

// Handle process termination gracefully
process.on('SIGINT', async () => {
  await closeDb();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeDb();
  process.exit(0);
});