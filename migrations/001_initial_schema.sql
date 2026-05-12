-- TerminalX persistent schema.
-- This migration is PostgreSQL/Supabase compatible and keeps JSON payloads in
-- jsonb columns so future agents can store structured tool results safely.

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text,
  password_hash text,
  role text not null default 'operator',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  id text primary key,
  user_id uuid references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists sessions_token_hash_idx on sessions(token_hash);

create table if not exists login_audit_logs (
  id text primary key,
  user_id uuid references users(id) on delete set null,
  email text,
  action text not null,
  success boolean not null default false,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists roles (
  id text primary key,
  label text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role_id text not null references roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table if not exists role_permissions (
  role_id text not null references roles(id) on delete cascade,
  permission_name text not null,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_name)
);

create table if not exists agents (
  id text primary key,
  name text not null,
  type text not null,
  status text not null default 'idle',
  default_model text,
  responsibilities jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id text primary key,
  user_id uuid references users(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'created',
  assigned_agent_id text references agents(id) on delete set null,
  intent text,
  approval_required boolean not null default false,
  risk_level text not null default 'low',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists task_history (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists approvals (
  id text primary key,
  task_id text references tasks(id) on delete set null,
  title text not null,
  status text not null default 'pending',
  approval_type text not null default 'risky_action',
  risk_level text not null default 'medium',
  requested_by text not null default 'system',
  assigned_agent_id text references agents(id) on delete set null,
  description text,
  proposed_action jsonb not null default '{}'::jsonb,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists files (
  id text primary key,
  task_id text references tasks(id) on delete set null,
  filename text not null,
  storage_provider text not null default 'local',
  storage_key text,
  path text not null,
  mime_type text not null default 'application/octet-stream',
  size integer not null default 0,
  size_bytes integer not null default 0,
  mode text,
  provider text not null default 'local',
  bucket text not null default 'local',
  online_configured boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists chat_history (
  id text primary key,
  conversation_id text not null,
  agent_id text not null references agents(id) on delete set null,
  role text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_history_conversation_idx on chat_history(conversation_id, created_at);

create table if not exists agent_logs (
  id text primary key,
  agent_id text references agents(id) on delete set null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists permissions (
  id text primary key,
  label text not null,
  description text,
  requires_approval boolean not null default false,
  risk_level text not null default 'low',
  policy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  id text primary key,
  scope text not null default 'system',
  key text not null,
  value jsonb not null default '{}'::jsonb,
  is_secret boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope, key)
);
