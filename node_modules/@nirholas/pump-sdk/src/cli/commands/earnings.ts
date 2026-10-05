/**
 * `pump fees` and `pump incentives` — what the protocol owes an address, and
 * the commands to collect it.
 *
 * Creator fees and volume incentives accrue silently across two programs each
 * (the bonding curve program and PumpAMM). Checking both by hand means deriving
 * four PDAs, so most creators never look. These commands make it one line.
 */

import type { Command } from "commander";
import BN from "bn.js";

import { creatorVaultPda, userVolumeAccumulatorPda } from "../../pda";
import type { CliContext } from "../context";
import { CliError, parsePublicKey } from "../context";
import {
  c,
  formatSol,
  formatTokens,
  heading,
  info,
  keyValue,
  lamportsToSol,
  solscanAccount,
  toJson,
} from "../format";
import { submit } from "../tx";

export function registerEarningsCommands(
  program: Command,
  getContext: () => CliContext,
): void {
  const fees = program
    .command("fees [creator]")
    .description("Unclaimed creator fees across the curve and AMM programs")
    .action(async (creator: string | undefined) => {
      await runFees(getContext(), creator);
    });

  fees
    .command("claim")
    .description("Collect the signer's creator fees from both programs")
    .action(async () => {
      await runClaimFees(getContext());
    });

  const incentives = program
    .command("incentives [user]")
    .description("Unclaimed volume-reward tokens for an address")
    .action(async (user: string | undefined) => {
      await runIncentives(getContext(), user);
    });

  incentives
    .command("claim")
    .description("Claim the signer's volume-reward tokens")
    .action(async () => {
      await runClaimIncentives(getContext());
    });
}

/** Resolve an optional address argument, defaulting to the signer. */
function resolveTarget(
  ctx: CliContext,
  value: string | undefined,
  label: string,
) {
  if (value !== undefined) return parsePublicKey(value, label);
  const signer = ctx.maybeSignerPublicKey();
  if (signer === undefined) {
    throw new CliError(
      `No ${label} given and no wallet is configured`,
      `Pass an address, or configure a wallet with \`pump config set keypair <path>\`.`,
    );
  }
  return signer;
}

async function runFees(
  ctx: CliContext,
  creatorArg: string | undefined,
): Promise<void> {
  const creator = resolveTarget(ctx, creatorArg, "creator");

  const [curveOnly, both] = await Promise.all([
    ctx.sdk.getCreatorVaultBalance(creator),
    ctx.sdk.getCreatorVaultBalanceBothPrograms(creator),
  ]);
  const ammOnly = BN.max(new BN(0), both.sub(curveOnly));

  if (ctx.json) {
    process.stdout.write(
      `${toJson({
        creator: creator.toBase58(),
        creatorVault: creatorVaultPda(creator).toBase58(),
        bondingCurveLamports: curveOnly,
        ammLamports: ammOnly,
        totalLamports: both,
        totalSol: lamportsToSol(both),
      })}\n`,
    );
    return;
  }

  process.stdout.write(
    `${[
      heading("Creator fees", creator.toBase58()),
      "",
      keyValue([
        { label: "Bonding curve", value: formatSol(curveOnly) },
        { label: "PumpAMM", value: formatSol(ammOnly) },
        { label: "Total claimable", value: c.bold(formatSol(both)) },
        { label: "Vault", value: c.dim(solscanAccount(creatorVaultPda(creator).toBase58())) },
      ]),
      "",
      ...(both.isZero()
        ? [
            `  ${c.dim("Nothing to claim. Fees accrue as holders trade a token you created.")}`,
          ]
        : [`  ${info("Claim it with: pump fees claim")}`]),
      "",
    ].join("\n")}\n`,
  );
}

async function runClaimFees(ctx: CliContext): Promise<void> {
  const signer = ctx.requireSigner();
  const claimable = await ctx.sdk.getCreatorVaultBalanceBothPrograms(
    signer.publicKey,
  );
  if (claimable.isZero()) {
    throw new CliError(
      `${signer.publicKey.toBase58()} has no creator fees to claim`,
      "Run `pump fees` to check a different address.",
    );
  }

  const instructions = await ctx.sdk.collectCoinCreatorFeeInstructions(
    signer.publicKey,
  );

  const result = await submit(ctx, {
    action: "Claim creator fees",
    summary: [
      { label: "Creator", value: signer.publicKey.toBase58() },
      { label: "Claiming", value: c.bold(formatSol(claimable)) },
      { label: "Destination", value: signer.publicKey.toBase58() },
    ],
    instructions,
    signer,
  });

  if (ctx.json) {
    process.stdout.write(
      `${toJson({
        action: "claimCreatorFees",
        creator: signer.publicKey.toBase58(),
        claimedLamports: claimable,
        claimedSol: lamportsToSol(claimable),
        signature: result.signature ?? null,
        simulatedOnly: result.simulated,
      })}\n`,
    );
  }
}

async function runIncentives(
  ctx: CliContext,
  userArg: string | undefined,
): Promise<void> {
  const user = resolveTarget(ctx, userArg, "user");

  const [unclaimed, today] = await Promise.all([
    ctx.sdk.getTotalUnclaimedTokensBothPrograms(user),
    ctx.sdk.getCurrentDayTokensBothPrograms(user).catch(() => new BN(0)),
  ]);

  if (ctx.json) {
    process.stdout.write(
      `${toJson({
        user: user.toBase58(),
        volumeAccumulator: userVolumeAccumulatorPda(user).toBase58(),
        unclaimedTokens: unclaimed,
        currentDayTokens: today,
      })}\n`,
    );
    return;
  }

  process.stdout.write(
    `${[
      heading("Volume incentives", user.toBase58()),
      "",
      keyValue([
        { label: "Unclaimed", value: c.bold(formatTokens(unclaimed)), note: "PUMP tokens" },
        { label: "Earned today", value: formatTokens(today), note: "not yet claimable" },
        {
          label: "Accumulator",
          value: c.dim(solscanAccount(userVolumeAccumulatorPda(user).toBase58())),
        },
      ]),
      "",
      ...(unclaimed.isZero()
        ? [
            `  ${c.dim("Nothing to claim. Incentives accrue from trading volume and settle a day in arrears.")}`,
          ]
        : [`  ${info("Claim it with: pump incentives claim")}`]),
      "",
    ].join("\n")}\n`,
  );
}

async function runClaimIncentives(ctx: CliContext): Promise<void> {
  const signer = ctx.requireSigner();
  const unclaimed = await ctx.sdk.getTotalUnclaimedTokensBothPrograms(
    signer.publicKey,
  );
  if (unclaimed.isZero()) {
    throw new CliError(
      `${signer.publicKey.toBase58()} has no volume incentives to claim`,
      "Incentives settle a day in arrears. Run `pump incentives` to see today's accrual.",
    );
  }

  const instructions = await ctx.sdk.claimTokenIncentivesBothPrograms(
    signer.publicKey,
    signer.publicKey,
  );

  const result = await submit(ctx, {
    action: "Claim volume incentives",
    summary: [
      { label: "User", value: signer.publicKey.toBase58() },
      { label: "Claiming", value: c.bold(`${formatTokens(unclaimed)} PUMP`) },
    ],
    instructions,
    signer,
  });

  if (ctx.json) {
    process.stdout.write(
      `${toJson({
        action: "claimIncentives",
        user: signer.publicKey.toBase58(),
        claimedTokens: unclaimed,
        signature: result.signature ?? null,
        simulatedOnly: result.simulated,
      })}\n`,
    );
  }
}
