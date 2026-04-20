export const STORAGE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  blob_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  digest_sha256 TEXT,
  request_key TEXT,
  upload_token_expires_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  detail TEXT NOT NULL,
  file_digest_sha256 TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  price_json TEXT NOT NULL,
  price_sheet_version TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (upload_id) REFERENCES uploads(id)
);

CREATE INDEX IF NOT EXISTS quotes_upload_id_idx ON quotes(upload_id);
CREATE INDEX IF NOT EXISTS quotes_plan_hash_idx ON quotes(plan_hash);

CREATE TABLE IF NOT EXISTS inbound_payments (
  id TEXT PRIMARY KEY,
  receipt_reference TEXT NOT NULL UNIQUE,
  payment_method TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  challenge_id TEXT,
  request_body_digest TEXT,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  inbound_payment_id TEXT,
  status TEXT NOT NULL,
  workflow_run_id TEXT,
  result_artifact_id TEXT,
  result_blob_path TEXT,
  warnings_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (quote_id) REFERENCES quotes(id),
  FOREIGN KEY (upload_id) REFERENCES uploads(id),
  FOREIGN KEY (inbound_payment_id) REFERENCES inbound_payments(id)
);

CREATE INDEX IF NOT EXISTS jobs_quote_id_idx ON jobs(quote_id);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_quote_id_unique_idx ON jobs(quote_id);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_inbound_payment_idx ON jobs(inbound_payment_id);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS job_events_job_id_idx ON job_events(job_id);

CREATE TABLE IF NOT EXISTS outbound_payments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  spent TEXT NOT NULL,
  cumulative TEXT NOT NULL,
  channel_id TEXT,
  request_count INTEGER,
  receipt_json TEXT,
  close_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS outbound_payments_job_id_idx ON outbound_payments(job_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS artifacts_job_id_idx ON artifacts(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_blob_path_unique_idx ON artifacts(blob_path);

CREATE TABLE IF NOT EXISTS price_sheets (
  version TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  scope TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  window_ms INTEGER NOT NULL,
  window_start_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject_key, window_ms, window_start_ms)
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_start_idx
  ON rate_limit_buckets(window_start_ms);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_updated_at_idx
  ON rate_limit_buckets(updated_at);
`;
