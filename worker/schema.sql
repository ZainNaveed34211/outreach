PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  notify_reply_email INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, name)
);

CREATE TABLE IF NOT EXISTS lead_lists (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS senders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('brevo_default', 'gmail_oauth', 'outlook_oauth')),
  address TEXT NOT NULL,
  display_name TEXT NOT NULL,
  credentials_ref TEXT,
  credentials_expires_at INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sender_id TEXT REFERENCES senders(id),
  lead_list_id TEXT NOT NULL REFERENCES lead_lists(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'done', 'scheduled', 'archived')),
  scheduled_at INTEGER,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT,
  company TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed')),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS lead_list_members (
  list_id TEXT NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, lead_id)
);

CREATE TABLE IF NOT EXISTS sequences (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  delay_days INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  body_template TEXT NOT NULL,
  body_html TEXT,
  template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (campaign_id, step_no)
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  condition TEXT NOT NULL CHECK (condition IN ('no_reply_after_days', 'replied')),
  condition_value INTEGER,
  action TEXT NOT NULL CHECK (action IN ('send_followup', 'change_status', 'notify', 'stop')),
  action_value TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_step INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced', 'failed', 'stopped')),
  scheduled_at INTEGER NOT NULL,
  sent_at INTEGER,
  opened_at INTEGER,
  clicked_at INTEGER,
  replied_at INTEGER,
  provider_message_id TEXT,
  provider_thread_id TEXT,
  sending_at INTEGER,
  is_reply_followup INTEGER NOT NULL DEFAULT 0,
  ab_variant_id TEXT REFERENCES ab_variants(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (campaign_id, lead_id, sequence_step)
);

CREATE INDEX IF NOT EXISTS sends_due_idx ON sends(status, scheduled_at);
CREATE INDEX IF NOT EXISTS sends_campaign_idx ON sends(campaign_id, lead_id, sequence_step);
CREATE INDEX IF NOT EXISTS sends_provider_message_idx ON sends(provider_message_id);

CREATE TABLE IF NOT EXISTS suppressions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complaint')),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  send_id TEXT NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('delivered', 'opened', 'clicked', 'replied', 'bounced', 'unsubscribed')),
  at INTEGER NOT NULL,
  meta_json TEXT,
  provider_event_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS brevo_ignored_messages (
  provider_message_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('test', 'notification')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  send_id TEXT NOT NULL UNIQUE REFERENCES sends(id) ON DELETE CASCADE,
  sender_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('csv_import', 'attachment', 'template_image')),
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_intents (
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

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS rate_limits (
  rate_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reply_cursors (
  sender_id TEXT PRIMARY KEY REFERENCES senders(id) ON DELETE CASCADE,
  last_checked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_executions (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  send_id TEXT NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (branch_id, send_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_default_sender_per_workspace
ON senders(workspace_id) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS inbox_replies (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL REFERENCES replies(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES senders(id),
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  provider_message_id TEXT,
  sent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, title)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_log_workspace_idx ON activity_log(workspace_id, created_at);

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
