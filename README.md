# SyncMate Functions

Server-side services for SyncMate: a TypeScript/Express API that powers

* a **Gemini‑backed chatbot** (analytics/compliance assistant),
* **file upload + automated glossary extraction** from CSV/XLSX/PDF,
* data persistence via **Postgres/Supabase**,
* background processing to keep a structured **Data Glossary** in sync with uploaded content.

> Tech: Node.js, TypeScript, Express, Gemini, Postgres/Supabase.
> Optional: Firebase Admin (if you enable it in `server.ts`).

---

## Features

* **Chatbot API** (`/api/chatbot`): Routes questions to Google **Gemini** with relevant context (e.g., recent issues, glossary terms).
* **Report Upload API** (`/api/reports/upload`): Accepts CSV/XLSX/PDF uploads; extracts schema/terms and enqueues background processing.
* **Background Glossary Processor**: Deduplicates and normalizes terms; writes structured entries to your glossary tables.
* **Postgres/Supabase integration**: Simple repo layer for users/terms/issues.
* **Typed config** + environment-driven deployment.

---

## Project Structure

```
SYNCMATE_FUNCTIONS/
├─ dist/                       # compiled JS output (tsc)
├─ logs/                       # runtime logs
├─ node_modules/
├─ src/
│  ├─ lib/
│  │  ├─ backgroundGlossaryProcessor.ts  # queue/worker for glossary extraction
│  │  ├─ chatbot-service.ts              # orchestrates Gemini calls + context building
│  │  ├─ config.ts                       # CONFIG object + env guards
│  │  ├─ gemini.ts                       # Gemini client factory
│  │  ├─ glossary-types.ts               # shared types/interfaces
│  │  └─ supabase.ts                     # Supabase client (service or anon)
│  ├─ routes/
│  │  ├─ chatbot.ts                      # /api/chatbot routes
│  │  └─ reportUpload.ts                 # /api/reports/upload routes
│  ├─ services/
│  │  ├─ db.ts                           # pg pool / DB helpers
│  │  └─ userRepo.ts                     # example repository layer
│  └─ server.ts                          # Express app bootstrap
├─ .env.example                           # sample env (create your own .env)
├─ .env.production                        # production sample
├─ glossary-extractor.log                 # extractor logs (gitignored in prod)
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

## Requirements

* Node.js **18+** (recommended 20.x)
* A Postgres database (NeonDB/Supabase/Cloud SQL/etc.)
* Google Gemini API key
* (Optional) Firebase Admin credentials if you enable Firebase features

---

## Environment Variables

Create a `.env` in the project root. Use this as a starting point:

```bash
# Server
PORT=3000
FRONTEND_ORIGIN=http://localhost:5173
SESSION_COOKIE_NAME=__session
NODE_ENV=development
LOG_LEVEL=info

# Postgres / Supabase
DATABASE_URL=postgresql://USER:PASS@HOST:PORT/DB
PGSSL=require                       # set to "require" if your hosting needs SSL
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE=your_service_role_key     # only if you use service ops server-side
SUPABASE_BUCKET=reports

# Gemini
GEMINI_API_KEY=your_google_generative_ai_key
GEMINI_MODEL=gemini-2.0-flash-exp              # or your preferred model id

# (Optional) Firebase Admin
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_CLIENT_EMAIL=service-account@project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

> Tip: On Windows, keep `FIREBASE_PRIVATE_KEY` quotes and newline escapes (`\n`).
> If you don’t use Firebase here, you can omit those three variables.

---

## Install & Run

```bash
# 1) Install dependencies
npm install

# 2) Build TypeScript -> dist/
npm run build

# 3) Start (runs dist/server.js)
npm start
```

**Suggested package.json scripts** (adjust if yours differ):

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "ts-node-dev --respawn --transpile-only src/server.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

---

## API

### Chatbot

**POST** `/api/chatbot/ask`
Ask the compliance/analytics assistant. The service uses recent records (e.g., issues/glossary) as context before calling Gemini.

**Request**

```json
{
  "question": "What are the top blocking issues this week?",
  "userId": "optional-user-id"
}
```

**Response (example)**

```json
{
  "answer": "Two high-severity issues remain open for Entity X...",
  "metadata": {
    "model": "gemini-2.0-flash-exp",
    "tokensUsed": 1234
  }
}
```

---

### Report Upload

**POST** `/api/reports/upload` (multipart/form-data)
Field name: `file`

Supported types: `.csv`, `.xlsx`, `.pdf` (as implemented in `routes/reportUpload.ts`).

**cURL**

```bash
curl -X POST http://localhost:3000/api/reports/upload \
  -F "file=@/path/to/report.xlsx"
```

**Response (example)**

```json
{
  "status": "queued",
  "fileName": "report.xlsx",
  "detected": {
    "columns": ["customer_id", "txn_date", "amount"],
    "rowsSampled": 100
  },
  "message": "Glossary extraction scheduled."
}
```

---

## How It Works

* `routes/reportUpload.ts` uses a streaming parser to read uploads (CSV/XLSX/PDF).
* Parsed headers + sample values feed into `lib/backgroundGlossaryProcessor.ts`.
* `backgroundGlossaryProcessor` de‑duplicates and normalizes terms (see `glossary-types.ts`) then persists them via `services/db.ts` / Supabase.
* `routes/chatbot.ts` calls `lib/chatbot-service.ts`, which:

  * fetches recent domain context (e.g., issues, glossary entries),
  * constructs a compact prompt,
  * calls Gemini via `lib/gemini.ts`,
  * returns a clear, actionable response.

---

## Database

This service expects tables for:

* **glossary terms** (normalized name, variants, category, examples, source),
* **issues/reports** (for context‑building),
* **users** (if you gate chatbot features per user).

> Use your existing Supabase/Neon schema. If you need starter SQL, add a `/db/` folder or see your project’s schema scripts.

---

## Logging

* Runtime logs go to `logs/` and console (level via `LOG_LEVEL`).
* Glossary extraction events can be inspected in `glossary-extractor.log`.

---

## Security Notes

* Keep `SUPABASE_SERVICE_ROLE` **server-only** (never expose to frontend).
* Lock CORS with `FRONTEND_ORIGIN`.
* Validate uploads (size/type); sanitize parsed content before persistence.
* If enabling Firebase Admin, store credentials as environment variables or secret manager entries.

---

## Troubleshooting

* **ESM/CJS / `__dirname` error** after build
  If you see “Identifier `__dirname` has already been declared”, ensure you’re not redefining it in compiled CJS. In TS, prefer:

  ```ts
  import path from "path";
  import { fileURLToPath } from "url";
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  ```

  Or keep everything in CommonJS (no `"type": "module"` in package.json) and use Node’s native `__dirname`. Don’t mix both patterns.

* **SSL required for hosted Postgres**
  Set `PGSSL=require` and configure the Pool with `{ ssl: { rejectUnauthorized: false } }` when your provider needs it.

* **Gemini errors**
  Verify `GEMINI_API_KEY` and model id (e.g., `gemini-2.0-flash-exp`). Check request body size limits and timeouts in `config.ts`.

* **CORS**
  Update `FRONTEND_ORIGIN` to your deployed frontend URL.

---

## Development Tips

* Use `npm run dev` with `ts-node-dev` for hot reload during development.
* Add unit tests for parsers/extractors before integrating new file types.
* Keep your glossary categories/types centralized in `glossary-types.ts`.

---

## Roadmap

* Auth guard on upload/chat endpoints
* Additional file types (JSON/Parquet)
* Vector search for richer chatbot grounding
* Rate limits + per‑user quotas

---

## License

MIT © SyncMate

---

If you want, I can also drop this into your repo as a polished `README.md` and add a `.env.example` file mirroring the variables above.
