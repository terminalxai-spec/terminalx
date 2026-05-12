# TerminalX MVP Foundation

TerminalX is a multi-agent AI operating system foundation built beside the existing Claw runtime. This scaffold does not modify or replace the Rust code. It creates a small backend, dashboard, database placeholder, and agent registry that can grow into the TerminalX product.

## What Is Included

- Basic backend server with health, agent, task, approval, and file routes.
- Secure email/password authentication with HttpOnly session cookies.
- Mobile-friendly static dashboard served by the backend.
- Environment variable example.
- Persistent database repository with local SQLite fallback.
- PostgreSQL/Supabase-compatible schema migration.
- Online/offline runtime mode configuration.
- AI provider routing for OpenAI, Anthropic, Gemini, mock mode, and Ollama offline placeholder.
- Agent registry for CEO, Coding, Testing, Content, Trading, and Chat agents.
- Modular folders for future runtime, storage, permissions, and approvals.

## Setup

## Online Deployment: GitHub + Vercel + Supabase

For an online TerminalX deployment, use this production shape:

```text
GitHub = code repository
Vercel = web app/API hosting
Supabase = PostgreSQL database + optional file storage
Cloud LLM API = Groq, OpenAI, Anthropic, or Gemini
```

Important: Ollama runs on your laptop, not inside Vercel. For the online version, configure a cloud LLM provider such as Groq.

1. Create/push a GitHub repository from the `terminalx` folder.
2. Create a Supabase project.
3. In Supabase SQL Editor, run:

```text
migrations/001_initial_schema.sql
```

4. In Vercel, import the GitHub repository and set the project root to:

```text
terminalx
```

5. Add these Vercel environment variables:

```env
TERMINALX_ENV=production
AUTH_REQUIRED=true
SESSION_SECRET=use-a-long-random-secret
ADMIN_EMAIL=your-admin-email@example.com
ADMIN_PASSWORD=use-a-strong-password

DATABASE_PROVIDER=postgres
DATABASE_URL=your-supabase-postgres-connection-string
DATABASE_SSL=true

FILE_STORAGE_PROVIDER=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_STORAGE_BUCKET=terminalx-files

LLM_PROVIDER=groq
GROQ_API_KEY=your-groq-key
GROQ_MODEL=llama-3.3-70b-versatile
```

You may use `LLM_PROVIDER=openai` with `OPENAI_API_KEY`, `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`, or `LLM_PROVIDER=gemini` with `GEMINI_API_KEY`, instead of Groq.

6. Deploy from Vercel.

The Vercel entrypoint is:

```text
api/index.js
```

The route config is:

```text
vercel.json
```

### Windows Double-Click Launch

For normal daily use on Windows, double-click:

```text
Start-TerminalX.cmd
```

The launcher will:

- create `.env` from `.env.example` if needed
- install Node dependencies if `node_modules` is missing
- start Ollama if it is installed in the default Windows location
- start TerminalX on `http://127.0.0.1:8787`
- open the dashboard in your browser

Default login:

```text
Email: admin@terminalx.local
Password: change-me-now
```

If port `8787` is busy, set a different port before launching from PowerShell:

```powershell
$env:TERMINALX_PORT="8790"
.\Start-TerminalX.cmd
```

Then open:

```text
http://127.0.0.1:8790
```

### Manual Development Start

```powershell
cd C:\Users\User\Downloads\claw-code-analysis\claw-code-main\terminalx
Copy-Item .env.example .env
npm.cmd run db:init
node services\api\src\server.js
```

Then open:

```text
http://127.0.0.1:8787
```

## Development Notes

The backend uses only built-in Node.js modules for the MVP foundation. This keeps the scaffold easy to run before the final framework choices are made.

## Authentication

Authentication is enabled by default:

```env
AUTH_REQUIRED=true
SESSION_SECRET=
ADMIN_EMAIL=admin@terminalx.local
ADMIN_PASSWORD=change-me-now
```

In development, TerminalX seeds this admin user unless `TERMINALX_ENV=production`. Change the password immediately for any shared environment. Passwords are stored as PBKDF2 hashes, and sessions are stored in the database as token hashes. The browser receives only an HttpOnly session cookie; password hashes, session secrets, and raw tokens are never sent to frontend code.

Auth routes:

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
GET  /api/auth/permissions
```

Protected routes include tasks, approvals, files, command routing, chat, and action logs. `GET /api/health` stays public.

## RBAC

TerminalX uses role-based access control on top of authenticated sessions.

Roles:

```text
admin
operator
viewer
```

Permissions:

```text
tasks:create
tasks:read
tasks:update
tasks:delete
approvals:read
approvals:approve
files:upload
files:read
files:delete
agents:execute
chat:use
settings:manage
```

The seeded development admin receives the `admin` role. New registered users receive the `operator` role by default. Viewers can read tasks, approvals, and files only. The dashboard uses `/api/auth/me` to hide or disable actions the current user cannot perform, but all enforcement happens server-side through permission checks.

Storage is exposed through a provider-aware file service. The current MVP writes through the local adapter by default, while `.env.example` includes Supabase Storage and S3-compatible settings so the same API can be backed by an online bucket when credentials are connected.

## File Storage

TerminalX supports three file storage providers through:

```text
services/file-service/src/providers.js
```

The provider interface is:

```text
uploadFile()
readFile()
listFiles()
deleteFile()
getDownloadUrl()
```

Local storage is the default and requires no cloud credentials:

```env
FILE_STORAGE_PROVIDER=local
FILE_STORAGE_LOCAL_PATH=./storage/local/files
```

Supabase Storage:

```env
FILE_STORAGE_PROVIDER=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=terminalx-files
```

S3-compatible storage:

```env
FILE_STORAGE_PROVIDER=s3
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

File metadata is stored in the database with both compatibility fields and production storage fields: `id`, `filename`, `storage_provider`, `storage_key`, `mime_type`, `size`, `created_at`, and optional `task_id`. File deletion still goes through the approval queue before the provider deletes anything. Do not expose `SUPABASE_SERVICE_ROLE_KEY`, `S3_ACCESS_KEY_ID`, or `S3_SECRET_ACCESS_KEY` to frontend code.

## Database

TerminalX has a repository layer for tasks, approvals, files, chat history, agent logs, agents, and permissions.

The PostgreSQL/Supabase-compatible migration lives here:

```text
migrations/001_initial_schema.sql
```

Local development uses SQLite by default:

```env
DATABASE_PROVIDER=sqlite
SQLITE_PATH=./storage/local/terminalx.db
```

For Supabase/PostgreSQL preparation:

```env
DATABASE_PROVIDER=postgres
DATABASE_URL=
DATABASE_SSL=true
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

Apply `migrations/001_initial_schema.sql` in the Supabase SQL editor or through your PostgreSQL migration tool. The current no-dependency runtime falls back to SQLite if PostgreSQL is requested but no PostgreSQL driver is installed.

Database commands:

```powershell
npm.cmd run db:init
npm.cmd run db:migrate
```

`db:init` creates the selected database schema and seeds agents, permissions, and safe system settings. `db:migrate` applies the selected provider migration. For `DATABASE_PROVIDER=postgres`, migrations use `DATABASE_URL` with the local `psql` command if PostgreSQL tooling is installed.

To run TerminalX against Supabase/PostgreSQL:

1. Install dependencies:

```powershell
npm.cmd install
```

2. Set server-side environment values:

```env
DATABASE_PROVIDER=postgres
DATABASE_URL=postgresql://...
DATABASE_SSL=true
```

3. Apply the migration:

```powershell
npm.cmd run db:migrate
npm.cmd run db:init
```

4. Start the server:

```powershell
node services\api\src\server.js
```

`DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must stay server-side only. They are never returned by the API config route and must not be placed in frontend code.

## Runtime Modes

TerminalX now has an explicit runtime mode so the same app can grow toward cloud-hosted operation or laptop-local operation.

```env
TERMINALX_RUNTIME_MODE=ONLINE_MODE
```

Use `ONLINE_MODE` when TerminalX should prepare for cloud APIs such as hosted LLMs, Supabase Storage, S3-compatible buckets, and deployed services.

```env
TERMINALX_RUNTIME_MODE=OFFLINE_MODE
FILE_STORAGE_PROVIDER=local
FILE_STORAGE_LOCAL_PATH=./storage/local/files
LOCAL_LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=
```

Use `OFFLINE_MODE` for laptop server preparation. In this mode, the storage interface stays local and the LLM provider switches to an Ollama placeholder. TerminalX does not call Ollama yet; the clean provider interface lives at:

```text
services/agent-runtime/src/llm/provider.js
```

The runtime config lives at:

```text
services/agent-runtime/src/config/runtime.js
```

## Laptop Server Setup

For a local laptop server:

1. Install Node.js.
2. Copy `.env.example` to `.env`.
3. Set `TERMINALX_RUNTIME_MODE=OFFLINE_MODE`.
4. Set `FILE_STORAGE_PROVIDER=local`.
5. Keep `TERMINALX_HOST=127.0.0.1` for local-only access, or set it to `0.0.0.0` only when you intentionally want other devices on your network to reach the dashboard.
6. Start the server:

```powershell
node services\api\src\server.js
```

7. Open the dashboard:

```text
http://127.0.0.1:8787
```

Future local AI work should implement the `generate()` method in the Ollama provider, add model health checks, and route agent prompts through the provider interface rather than calling a model directly from each agent.

## AI Provider Routing

TerminalX chooses an AI provider through the LLM provider interface:

```text
services/agent-runtime/src/llm/provider.js
```

The interface exposes:

```text
sendMessage()
streamMessage()
classifyIntent()
summarizeFile()
```

Set `LLM_PROVIDER=auto` to choose the first configured cloud key in this order: OpenAI, Anthropic, Gemini. If no API key exists, TerminalX uses mock/demo mode so the dashboard and tests still work.

```env
LLM_PROVIDER=auto
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
```

The CEO Agent uses the provider for command intent classification when a real key is available, then falls back to the existing rules if the provider is missing or fails. Offline mode currently selects the Ollama placeholder and does not execute local model calls yet.

Useful routes:

```text
GET  /api/health
GET  /api/agents
GET  /api/tasks
POST /api/tasks
GET  /api/approvals
GET  /api/action-log
GET  /api/files
POST /api/files/upload
GET  /api/files/:id
GET  /api/files/:id/read
GET  /api/files/:id/download
DELETE /api/files/:id
GET  /api/config/database
GET  /api/config/storage
GET  /api/config/runtime
POST /api/command
POST /api/chat
GET  /api/chat/history
POST /api/content
POST /api/trading/analyze
POST /api/coding/read-file
POST /api/coding/suggest-change
POST /api/coding/create-file
POST /api/coding/modify-file
POST /api/coding/delete-file
POST /api/coding/run-command
GET  /api/coding/github
POST /api/test/run
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject
```

## Next Step

The next implementation pass should add a production PostgreSQL runtime adapter, wire the agent runtime to the existing Rust tool/session concepts, and expand approval-gated tool execution.
