-- 001_sllm_tables.sql — SLMS agency tables (all prefixed sllm_).
CREATE TABLE IF NOT EXISTS sllm_models (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  image_url         TEXT,
  personality       JSONB NOT NULL DEFAULT '{}',   -- { traits: [], vibe: '', backstory: '' }
  wallet_address    TEXT NOT NULL UNIQUE,          -- model's own Solana wallet (public)
  wallet_encrypted  TEXT NOT NULL,                -- AES-256-GCM blob (NEVER exposed)
  token_mint        TEXT UNIQUE,                   -- set on launch
  token_name        TEXT,
  token_ticker      TEXT,
  launch_signature  TEXT,
  status            TEXT NOT NULL DEFAULT 'created', -- created | launched
  created_by        TEXT NOT NULL,                 -- launcher wallet pubkey
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sllm_models_created ON sllm_models(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sllm_models_creator ON sllm_models(created_by);

CREATE TABLE IF NOT EXISTS sllm_chats (
  id          SERIAL PRIMARY KEY,
  model_id    INTEGER NOT NULL REFERENCES sllm_models(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                      -- 'user' | 'model'
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sllm_chats_model ON sllm_chats(model_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sllm_trades (
  id                SERIAL PRIMARY KEY,
  model_id          INTEGER NOT NULL REFERENCES sllm_models(id) ON DELETE CASCADE,
  side              TEXT NOT NULL DEFAULT 'buy',
  token_mint        TEXT NOT NULL,
  amount_sol        NUMERIC NOT NULL,
  token_amount      TEXT,                          -- Jupiter outAmount (approx, big ints as text)
  signature         TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sllm_trades_model ON sllm_trades(model_id, created_at DESC);

-- Launch intents: unsigned pump.fun create txs awaiting the launcher's signature.
CREATE TABLE IF NOT EXISTS sllm_launch_intents (
  id                SERIAL PRIMARY KEY,
  model_id          INTEGER NOT NULL REFERENCES sllm_models(id) ON DELETE CASCADE,
  mint              TEXT NOT NULL UNIQUE,         -- client-generated mint keypair
  launcher_wallet   TEXT NOT NULL,
  name              TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  metadata_uri      TEXT NOT NULL,
  image_url         TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sllm_launch_model ON sllm_launch_intents(model_id);
