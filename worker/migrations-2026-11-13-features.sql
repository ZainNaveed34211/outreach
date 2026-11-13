CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  blocks_json TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_templates_workspace ON templates(workspace_id);

CREATE TABLE IF NOT EXISTS warmup_state (
  workspace_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'ramping', 'paused', 'complete')),
  started_at INTEGER,
  current_daily_cap INTEGER NOT NULL DEFAULT 0,
  target_daily_cap INTEGER NOT NULL DEFAULT 50,
  ramp_step INTEGER NOT NULL DEFAULT 5,
  last_sent_at INTEGER,
  ramped_on INTEGER,
  PRIMARY KEY (workspace_id, sender_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES senders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  rules_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  send_id TEXT NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workflow_id, send_id, rule_id)
);

CREATE TABLE IF NOT EXISTS ab_tests (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete')),
  split_percent INTEGER NOT NULL DEFAULT 50,
  winner_variant_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ab_variants (
  id TEXT PRIMARY KEY,
  ab_test_id TEXT NOT NULL REFERENCES ab_tests(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (label IN ('A', 'B')),
  subject TEXT NOT NULL,
  body_template TEXT NOT NULL,
  body_html TEXT,
  created_at INTEGER NOT NULL
);

ALTER TABLE sequences ADD COLUMN body_html TEXT;
ALTER TABLE sequences ADD COLUMN template_id TEXT REFERENCES templates(id) ON DELETE SET NULL;
ALTER TABLE sends ADD COLUMN ab_variant_id TEXT REFERENCES ab_variants(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS files_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('csv_import', 'attachment', 'template_image')),
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO files_new SELECT id, workspace_id, kind, r2_key, filename, size_bytes, created_at FROM files;
DROP TABLE files;
ALTER TABLE files_new RENAME TO files;

CREATE TABLE IF NOT EXISTS upload_intents_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id TEXT REFERENCES lead_lists(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('csv_import', 'attachment', 'template_image')),
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  result_json TEXT
);
INSERT OR IGNORE INTO upload_intents_new SELECT id, workspace_id, list_id, kind, r2_key, filename, size_bytes, content_type, expires_at, created_at, completed_at, result_json FROM upload_intents;
DROP TABLE upload_intents;
ALTER TABLE upload_intents_new RENAME TO upload_intents;
