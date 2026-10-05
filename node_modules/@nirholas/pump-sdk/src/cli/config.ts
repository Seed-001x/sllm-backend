/**
 * Persistent CLI configuration.
 *
 * Stored as JSON at `~/.pump/config.json` (override the directory with
 * `PUMP_CONFIG_DIR`). Every value is also settable per-invocation via a flag or
 * an environment variable, so the config file is a convenience, never a
 * requirement: a fresh install with zero config still runs every read command.
 *
 * Precedence, highest first: command flag, environment variable, config file,
 * built-in default.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Public mainnet RPC. Rate limited, fine for reads, replace it for anything real. */
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

/** Where `solana-keygen` puts a wallet by default. */
export const DEFAULT_KEYPAIR_PATH = join(
  homedir(),
  ".config",
  "solana",
  "id.json",
);

export interface CliConfig {
  /** Primary JSON-RPC endpoint. */
  rpcUrl?: string;
  /** Additional endpoints tried in order when the primary fails. */
  fallbackRpcUrls?: string[];
  /** Path to a signer keypair (JSON byte array or base58 secret key). */
  keypair?: string;
  /** Default slippage tolerance in percent, e.g. `1` for 1%. */
  slippage?: number;
  /** Default priority fee in micro-lamports per compute unit. */
  priorityFee?: number;
  /** Default compute unit limit for trade transactions. */
  computeUnitLimit?: number;
}

function requireFiniteNumber(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number, got "${value}"`);
  }
  return parsed;
}

/** Keys a user may set with `pump config set`, with their parsers. */
export const CONFIG_KEYS: Record<keyof CliConfig, (value: string) => unknown> =
  {
    rpcUrl: (v) => v,
    fallbackRpcUrls: (v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    keypair: (v) => v,
    slippage: (v) => requireFiniteNumber(v, "slippage"),
    priorityFee: (v) => requireFiniteNumber(v, "priorityFee"),
    computeUnitLimit: (v) => requireFiniteNumber(v, "computeUnitLimit"),
  };

export function configDir(): string {
  return process.env.PUMP_CONFIG_DIR ?? join(homedir(), ".pump");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Read the config file. A missing or unreadable file is an empty config. */
export function loadConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: CliConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * Resolve the RPC endpoint list, primary first.
 *
 * `--rpc` accepts a comma-separated list so a one-liner can carry its own
 * failover chain without touching the config file.
 */
export function resolveRpcUrls(flagValue?: string): string[] {
  const config = loadConfig();
  const primaries = flagValue
    ? flagValue
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [
        process.env.PUMP_RPC_URL ??
          process.env.SOLANA_RPC_URL ??
          config.rpcUrl ??
          DEFAULT_RPC_URL,
      ];

  const fallbacks = flagValue ? [] : (config.fallbackRpcUrls ?? []);
  return [...new Set([...primaries, ...fallbacks])];
}

/** Resolve the signer keypair path without reading it. */
export function resolveKeypairPath(flagValue?: string): string {
  const config = loadConfig();
  return (
    flagValue ??
    process.env.PUMP_KEYPAIR ??
    process.env.SOLANA_KEYPAIR ??
    config.keypair ??
    DEFAULT_KEYPAIR_PATH
  );
}

export function resolveSlippage(flagValue?: number): number {
  if (flagValue !== undefined) return flagValue;
  const fromEnv = process.env.PUMP_SLIPPAGE;
  if (fromEnv !== undefined && Number.isFinite(Number(fromEnv))) {
    return Number(fromEnv);
  }
  return loadConfig().slippage ?? 1;
}

export function resolvePriorityFee(flagValue?: number): number {
  if (flagValue !== undefined) return flagValue;
  const fromEnv = process.env.PUMP_PRIORITY_FEE;
  if (fromEnv !== undefined && Number.isFinite(Number(fromEnv))) {
    return Number(fromEnv);
  }
  return loadConfig().priorityFee ?? 0;
}

export function resolveComputeUnitLimit(flagValue?: number): number {
  if (flagValue !== undefined) return flagValue;
  return loadConfig().computeUnitLimit ?? 300_000;
}
