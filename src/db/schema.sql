-- src/db/schema.sql — SLMS base schema (idempotent).
--
-- SLMS shares its Postgres database with Tamastream, so every SLMS table is
-- prefixed `sllm_`. The sign-in-with-wallet auth tables are shared infra —
-- created IF NOT EXISTS here so SLMS also boots against a fresh database.
-- ---------------------------------------------------------------- auth (shared)
CREATE TABLE IF NOT EXISTS auth_nonces (
  pubkey      TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (pubkey, nonce)
);

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  pubkey            TEXT PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  verified_method   TEXT,
  verified_at       TIMESTAMPTZ
);
