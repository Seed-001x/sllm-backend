#!/usr/bin/env node
/**
 * `pump` — the Pump protocol from a terminal.
 *
 * Built on the same offline instruction builders the SDK exports, so anything
 * the CLI does is something a script can do with three lines of TypeScript. The
 * CLI is the fastest way to answer a question about a token; the SDK is how you
 * put that answer in a product.
 *
 * Design rules this file enforces:
 *  - Read commands never require a wallet or any configuration.
 *  - Every command supports `--json` and prints nothing else to stdout in that
 *    mode, so `| jq` always works.
 *  - Anything that spends funds simulates first and asks before sending.
 *  - Errors name the fix, not just the failure.
 */

import { Command } from "commander";

import { registerEarningsCommands } from "./commands/earnings";
import { registerEventsCommand } from "./commands/events";
import { registerInspectCommands } from "./commands/inspect";
import { registerPdaCommand } from "./commands/pda";
import { registerQuoteCommand } from "./commands/quote";
import { registerSetupCommands, quickstart } from "./commands/setup";
import { registerTradeCommands } from "./commands/trade";
import { registerVanityCommand } from "./commands/vanity";
import { registerWatchCommand } from "./commands/watch";
import { CliContext, CliError, type GlobalOptions } from "./context";
import { c, failure, setColorEnabled } from "./format";

// Resolved lazily and cached: building a Connection on every command
// registration would open a socket even for `pump --help`.
let context: CliContext | undefined;

function getContext(): CliContext {
  if (context === undefined) {
    context = new CliContext(program.opts<GlobalOptions>());
  }
  return context;
}

const program = new Command();

program
  .name("pump")
  .description(
    "Inspect, trade, and launch tokens on the Pump protocol.\n" +
      "Read commands need no wallet. Trades simulate first and always ask before sending.",
  )
  .version(readVersion(), "-v, --version", "Print the CLI version")
  .option("-r, --rpc <url>", "RPC endpoint, or a comma-separated failover list")
  .option("-k, --keypair <path>", "Signer keypair (JSON byte array or base58 secret)")
  .option("--json", "Emit machine-readable JSON on stdout and nothing else")
  .option("--no-color", "Disable colour output")
  .option("--slippage <percent>", "Slippage tolerance in percent", Number)
  .option("--priority-fee <microLamports>", "Priority fee per compute unit", Number)
  .option("--compute-unit-limit <units>", "Compute unit limit for trades", Number)
  .option("-y, --yes", "Skip the confirmation prompt (for scripts)")
  .option("--simulate", "Simulate and report, never send")
  .addHelpText(
    "after",
    [
      "",
      "Examples:",
      "  pump curve <mint>                       Inspect a bonding curve",
      "  pump quote buy <mint> --sol 1           Price a 1 SOL buy",
      "  pump buy <mint> --sol 0.5               Buy, with a confirmation prompt",
      "  pump sell <mint> --all                  Exit a position and reclaim rent",
      "  pump watch <mint> --interval 3          Live dashboard",
      "  pump vanity --suffix pump               Grind a ...pump mint",
      "  pump fees                               Unclaimed creator fees",
      "  pump curve <mint> --json | jq .marketCapSol",
      "",
      "Configuration:",
      "  Flags beat environment variables beat ~/.pump/config.json beat defaults.",
      "  PUMP_RPC_URL, PUMP_KEYPAIR, PUMP_SLIPPAGE, PUMP_PRIORITY_FEE are all read.",
      "",
      "Docs: https://sdk.pumpk.it   Source: https://github.com/nirholas/pump-fun-sdk",
    ].join("\n"),
  );

registerInspectCommands(program, getContext);
registerQuoteCommand(program, getContext);
registerTradeCommands(program, getContext);
registerEarningsCommands(program, getContext);
registerVanityCommand(program, getContext);
registerEventsCommand(program, getContext);
registerWatchCommand(program, getContext);
registerPdaCommand(program, getContext);
registerSetupCommands(program, getContext);

/**
 * The package version, injected by tsup at build time (see `tsup.config.ts`).
 *
 * Declared rather than imported so a release bump can never leave
 * `pump --version` lying, and so the binary does not read a file to answer it.
 * The fallback covers running the TypeScript source directly, e.g. under `tsx`.
 */
declare const __PUMP_CLI_VERSION__: string | undefined;

function readVersion(): string {
  return typeof __PUMP_CLI_VERSION__ === "string"
    ? __PUMP_CLI_VERSION__
    : "0.0.0-dev";
}

/**
 * Render an error the way a person can act on it.
 *
 * A `CliError` carries a hint written for whoever hit it. Anything else is a
 * bug or an RPC failure, so the raw message is shown and `--json` still emits
 * a parseable object rather than a half-written stream.
 */
function reportError(error: unknown, asJson: boolean): void {
  if (asJson) {
    const payload = {
      error:
        error instanceof Error ? error.message : String(error),
      hint: error instanceof CliError ? (error.hint ?? null) : null,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n${failure(message)}\n`);
  if (error instanceof CliError && error.hint !== undefined) {
    process.stderr.write(`  ${c.yellow(error.hint)}\n`);
  }
  process.stderr.write("\n");
}

async function main(): Promise<void> {
  // `pump` alone should teach, not dump a wall of flags.
  if (process.argv.length <= 2) {
    setColorEnabled(process.stdout.isTTY === true && process.env.NO_COLOR === undefined);
    process.stdout.write(`${quickstart()}\n`);
    return;
  }

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const asJson = process.argv.includes("--json");
  reportError(error, asJson);
  process.exitCode = 1;
});
