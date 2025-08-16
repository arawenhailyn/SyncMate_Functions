// src/db.ts
import { Client } from "pg";

const client = new Client({
  connectionString: process.env.DATABASE_URL, 
});

let connected = false;
export async function db() {
  if (!connected) {
    await client.connect();
    connected = true;
  }
  return client;
}
