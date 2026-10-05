import { expect } from "chai";
import BN from "bn.js";
import {
  AccountInfo,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import pumpAmmJson from "../idl/pump_amm.json";
import {
  ACCOUNT_SIZE,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  RawMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  GLOBAL_CONFIG_SIZE,
  OFFLINE_PUMP_AMM_PROGRAM,
  POOL_ACCOUNT_NEW_SIZE,
  POOL_SIZE,
  PUMP_AMM_SDK,
} from "../sdk/offlinePumpAmm";
import { PumpAmmAdminSdk } from "../sdk/pumpAmmAdmin";
import { OnlinePumpAmmSdk } from "../sdk/onlinePumpAmm";
import {
  bondingCurvePda,
  feeSharingConfigPda,
  GLOBAL_CONFIG_PDA,
  lpMintPda,
  metadataPda,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  poolPda,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  pumpPoolAuthorityPda,
} from "../sdk/pda";
import { getPumpAmmProgram } from "../sdk/util";
import { computeFeesBps, USDC_MINT } from "../sdk/fees";
import { buyBaseInput, buyQuoteInput } from "../sdk/buy";
import { sellBaseInput, sellQuoteInput } from "../sdk/sell";
import {
  CreatePoolSolanaState,
  FeeConfig,
  Fees,
  GlobalConfig,
  Pool,
} from "../types/sdk";
import {
  accountKey,
  createSwapSolanaState,
  decodePumpAmmInstruction,
  fees,
  feeTier,
  goldenInstruction,
  idlAccounts,
  instructionDiscriminator,
  stubConnection,
} from "./utils";
import { CREATE_POOL_GOLDEN } from "./createPoolGolden";

/** Deterministic wallets and mints, so goldens can be pinned. */
function seedKey(seed: number): PublicKey {
  return Keypair.fromSeed(Buffer.alloc(32, seed)).publicKey;
}

function u64Le(value: BN | number): string {
  return new BN(value).toArrayLike(Buffer, "le", 8).toString("hex");
}

/** A GlobalConfig with full recipient arrays, as the Anchor coder needs to encode it. */
function encodableGlobalConfig(
  overrides: Partial<GlobalConfig> = {},
): GlobalConfig {
  return {
    admin: PublicKey.unique(),
    lpFeeBasisPoints: new BN(20),
    protocolFeeBasisPoints: new BN(5),
    disableFlags: 0,
    protocolFeeRecipients: Array.from({ length: 8 }, () => PublicKey.unique()),
    coinCreatorFeeBasisPoints: new BN(5),
    adminSetCoinCreatorAuthority: PublicKey.unique(),
    whitelistPda: PublicKey.unique(),
    reservedFeeRecipient: PublicKey.unique(),
    mayhemModeEnabled: false,
    reservedFeeRecipients: Array.from({ length: 7 }, () => PublicKey.unique()),
    isCashbackEnabled: false,
    buybackFeeRecipients: Array.from({ length: 8 }, () => PublicKey.unique()),
    buybackBasisPoints: new BN(0),
    boostAuthority: PublicKey.default,
    boostEnabled: false,
    creatorFeeConfigurable: false,
    maxConfigurableCreatorFeeBps: new BN(0),
    ...overrides,
  };
}

function pumpAmmAccount(data: Buffer): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 1, owner: PUMP_AMM_PROGRAM_ID };
}

/** A canonical pump pool with every optional field set, so truncation is observable. */
function encodablePool(overrides: Partial<Pool> = {}): Pool {
  const baseMint = PublicKey.unique();
  const creator = pumpPoolAuthorityPda(baseMint);
  const poolKey = poolPda(0, creator, baseMint, USDC_MINT);
  return {
    poolBump: 254,
    index: 0,
    creator,
    baseMint,
    quoteMint: USDC_MINT,
    lpMint: lpMintPda(poolKey),
    poolBaseTokenAccount: PublicKey.unique(),
    poolQuoteTokenAccount: PublicKey.unique(),
    lpSupply: new BN(1_234_567),
    coinCreator: PublicKey.unique(),
    isMayhemMode: true,
    isCashbackCoin: true,
    virtualQuoteReserves: new BN(-42),
    creatorFeeBps: new BN(250),
    canEditCreatorFee: true,
    ...overrides,
  };
}

function truncateOrPad(data: Buffer, length: number): Buffer {
  return length <= data.length
    ? data.subarray(0, length)
    : Buffer.concat([data, Buffer.alloc(length - data.length)]);
}

/** The account bytes of `pool` at the current layout, truncated or zero-padded to `length`. */
async function poolBytes(pool: Pool, length: number): Promise<Buffer> {
  return truncateOrPad(
    await OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.encode<Pool>("pool", pool),
    length,
  );
}

/** The account bytes of `globalConfig` at the current layout, truncated or zero-padded to `length`. */
async function globalConfigBytes(
  globalConfig: GlobalConfig,
  length: number,
): Promise<Buffer> {
  return truncateOrPad(
    await OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.encode<GlobalConfig>(
      "globalConfig",
      globalConfig,
    ),
    length,
  );
}

const existingSplTokenAccount: AccountInfo<Buffer> = {
  data: Buffer.alloc(ACCOUNT_SIZE),
  executable: false,
  lamports: 2_039_280,
  owner: TOKEN_PROGRAM_ID,
};

describe("PumpAmmSdk.createPoolInstructions", () => {
  // The exact fixture the golden was captured with (see createPoolGolden.ts).
  const globalConfig: GlobalConfig = {
    admin: seedKey(10),
    lpFeeBasisPoints: new BN(20),
    protocolFeeBasisPoints: new BN(5),
    disableFlags: 0,
    protocolFeeRecipients: [seedKey(11)],
    coinCreatorFeeBasisPoints: new BN(5),
    adminSetCoinCreatorAuthority: seedKey(12),
    whitelistPda: seedKey(13),
    reservedFeeRecipient: seedKey(14),
    mayhemModeEnabled: false,
    reservedFeeRecipients: [],
    isCashbackEnabled: false,
    buybackFeeRecipients: [seedKey(15)],
    buybackBasisPoints: new BN(0),
    boostAuthority: PublicKey.default,
    boostEnabled: false,
    creatorFeeConfigurable: false,
    maxConfigurableCreatorFeeBps: new BN(0),
  };
  const baseIn = new BN(1_000_000_000);
  const quoteIn = new BN(5_000_000);

  function createPoolState(
    index: number,
    quoteMint: PublicKey,
    poolAtasExist: boolean,
    userQuoteAtaExists: boolean,
  ): CreatePoolSolanaState {
    const creator = seedKey(1);
    const baseMint = seedKey(2);
    const poolKey = poolPda(index, creator, baseMint, quoteMint);
    return {
      index,
      baseMint,
      quoteMint,
      creator,
      globalConfig,
      poolKey,
      poolBaseTokenAccount: getAssociatedTokenAddressSync(
        baseMint,
        poolKey,
        true,
      ),
      poolQuoteTokenAccount: getAssociatedTokenAddressSync(
        quoteMint,
        poolKey,
        true,
      ),
      baseTokenProgram: TOKEN_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      userBaseTokenAccount: getAssociatedTokenAddressSync(baseMint, creator),
      userQuoteTokenAccount: getAssociatedTokenAddressSync(quoteMint, creator),
      userBaseAccountInfo: existingSplTokenAccount,
      userQuoteAccountInfo: userQuoteAtaExists ? existingSplTokenAccount : null,
      poolBaseAccountInfo: poolAtasExist ? existingSplTokenAccount : null,
      poolQuoteAccountInfo: poolAtasExist ? existingSplTokenAccount : null,
    };
  }

  const states: Record<string, CreatePoolSolanaState> = {
    "usdc:index=1,poolAtasMissing,userAtasExist": createPoolState(
      1,
      USDC_MINT,
      false,
      true,
    ),
    "wsol:index=0,poolAtasExist,userWsolMissing": createPoolState(
      0,
      NATIVE_MINT,
      true,
      false,
    ),
  };
  const usdcCase = "usdc:index=1,poolAtasMissing,userAtasExist";
  const isCreatePool = (programId: string) =>
    programId === PUMP_AMM_PROGRAM_ID.toBase58();
  // OptionU64 (8 bytes) + OptionBool (1 byte), both unset.
  const UNSET_TRAILING_ARGS = u64Le(0) + "00";

  it("matches the pre-creator-fee golden, with 9 trailing zero bytes appended to create_pool only", async () => {
    expect(Object.keys(CREATE_POOL_GOLDEN)).to.deep.equal(Object.keys(states));
    for (const [name, state] of Object.entries(states)) {
      const built = (
        await PUMP_AMM_SDK.createPoolInstructions(state, baseIn, quoteIn)
      ).map(goldenInstruction);
      const golden = CREATE_POOL_GOLDEN[name];

      expect(built.length, name).to.equal(golden.length);
      expect(
        built.some((ix) => isCreatePool(ix.programId)),
        name,
      ).to.eq(true);
      built.forEach((instruction, i) => {
        const expected = golden[i];
        expect(instruction.programId, `${name}[${i}]`).to.equal(
          expected.programId,
        );
        expect(instruction.keys, `${name}[${i}] keys`).to.deep.equal(
          expected.keys,
        );
        expect(instruction.data, `${name}[${i}] data`).to.equal(
          isCreatePool(instruction.programId)
            ? expected.data + UNSET_TRAILING_ARGS
            : expected.data,
        );
      });
    }
  });

  it("encodes creatorFeeBps and canEditCreatorFee as the trailing OptionU64 / OptionBool", async () => {
    const instructions = await PUMP_AMM_SDK.createPoolInstructions(
      states[usdcCase],
      baseIn,
      quoteIn,
      { creatorFeeBps: new BN(250), canEditCreatorFee: true },
    );
    const createPool = instructions.find((ix) =>
      ix.programId.equals(PUMP_AMM_PROGRAM_ID),
    )!;
    const goldenData = CREATE_POOL_GOLDEN[usdcCase].find((ix) =>
      isCreatePool(ix.programId),
    )!.data;
    expect(Buffer.from(createPool.data).toString("hex")).to.equal(
      goldenData + u64Le(250) + "01",
    );

    const args = decodePumpAmmInstruction<{
      isCashbackCoin: { 0: boolean };
      creatorFeeBps: { 0: BN };
      canEditCreatorFee: { 0: boolean };
    }>(instructions, "createPool");
    expect(args.isCashbackCoin[0]).to.eq(false);
    expect(args.creatorFeeBps[0].toString()).to.equal("250");
    expect(args.canEditCreatorFee[0]).to.eq(true);

    // Each argument can be given on its own; the other keeps its unset encoding.
    const feeOnly = await PUMP_AMM_SDK.createPoolInstructions(
      states[usdcCase],
      baseIn,
      quoteIn,
      { creatorFeeBps: new BN(1) },
    );
    expect(
      Buffer.from(
        feeOnly.find((ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID))!.data,
      ).toString("hex"),
    ).to.equal(goldenData + u64Le(1) + "00");
    const flagOnly = await PUMP_AMM_SDK.createPoolInstructions(
      states[usdcCase],
      baseIn,
      quoteIn,
      { canEditCreatorFee: true },
    );
    expect(
      Buffer.from(
        flagOnly.find((ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID))!.data,
      ).toString("hex"),
    ).to.equal(goldenData + u64Le(0) + "01");
  });
});

describe("PumpAmmAdminSdk.fetchGlobalConfigAccount", () => {
  it("reads a pre-upgrade 940-byte GlobalConfig (gate off, max 0) and the 949-byte one", async () => {
    const globalConfig = encodableGlobalConfig({
      creatorFeeConfigurable: true,
      maxConfigurableCreatorFeeBps: new BN(500),
    });
    const encoded = await globalConfigBytes(globalConfig, 949);
    expect(encoded.length).to.equal(949);

    for (const [length, gate, max] of [
      [940, false, "0"],
      [949, true, "500"],
    ] as const) {
      const sdk = new PumpAmmAdminSdk(
        stubConnection(
          new Map([
            [
              GLOBAL_CONFIG_PDA.toBase58(),
              pumpAmmAccount(encoded.subarray(0, length)),
            ],
          ]),
        ),
      );
      const fetched = await sdk.fetchGlobalConfigAccount();
      expect(fetched.admin.equals(globalConfig.admin), `${length}`).to.eq(true);
      expect(
        fetched.adminSetCoinCreatorAuthority.equals(
          globalConfig.adminSetCoinCreatorAuthority,
        ),
      ).to.eq(true);
      expect(fetched.creatorFeeConfigurable, `${length}`).to.equal(gate);
      expect(fetched.maxConfigurableCreatorFeeBps.toString()).to.equal(max);

      // The admin builders that read it keep working against the shorter account.
      const instruction = await sdk.adminSetCoinCreator(
        PublicKey.unique(),
        PublicKey.unique(),
      );
      expect(
        accountKey(
          instruction,
          "adminSetCoinCreator",
          "adminSetCoinCreatorAuthority",
        ).equals(globalConfig.adminSetCoinCreatorAuthority),
      ).to.eq(true);
    }
  });
});

describe("decodePool at every historical account length", () => {
  const pool = encodablePool();

  function expectSharedFields(decoded: Pool) {
    expect(decoded.poolBump).to.equal(pool.poolBump);
    expect(decoded.index).to.equal(pool.index);
    for (const key of [
      "creator",
      "baseMint",
      "quoteMint",
      "lpMint",
      "poolBaseTokenAccount",
      "poolQuoteTokenAccount",
    ] as const) {
      expect(decoded[key].equals(pool[key]), key).to.eq(true);
    }
    expect(decoded.lpSupply.toString()).to.equal(pool.lpSupply.toString());
  }

  function expectCreatorFeeUnset(decoded: Pool) {
    expect(decoded.creatorFeeBps.toString()).to.equal("0");
    expect(decoded.canEditCreatorFee).to.eq(false);
  }

  async function decodeAt(length: number): Promise<Pool> {
    const data = await poolBytes(pool, length);
    expect(data.length).to.equal(length);
    return PUMP_AMM_SDK.decodePool(pumpAmmAccount(data));
  }

  it("POOL_SIZE is the serialized size of the vendored layout", async () => {
    expect(POOL_SIZE).to.equal(270);
    expect(OFFLINE_PUMP_AMM_PROGRAM.account.pool.size).to.equal(POOL_SIZE);
    expect(
      (await OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.encode<Pool>("pool", pool))
        .length,
    ).to.equal(POOL_SIZE);
    expect(POOL_ACCOUNT_NEW_SIZE).to.be.greaterThan(POOL_SIZE);
  });

  it("211 bytes (initial layout): no coin creator, no flags, no creator fee", async () => {
    const decoded = await decodeAt(211);
    expectSharedFields(decoded);
    expect(decoded.coinCreator.equals(PublicKey.default)).to.eq(true);
    expect(decoded.isMayhemMode).to.eq(false);
    expect(decoded.isCashbackCoin).to.eq(false);
    expect(decoded.virtualQuoteReserves.toString()).to.equal("0");
    expectCreatorFeeUnset(decoded);
  });

  it("243 bytes (pre-mayhem): coin creator, nothing after it", async () => {
    const decoded = await decodeAt(243);
    expectSharedFields(decoded);
    expect(decoded.coinCreator.equals(pool.coinCreator)).to.eq(true);
    expect(decoded.isMayhemMode).to.eq(false);
    expect(decoded.isCashbackCoin).to.eq(false);
    expect(decoded.virtualQuoteReserves.toString()).to.equal("0");
    expectCreatorFeeUnset(decoded);
  });

  it("244 bytes (pre-cashback): mayhem flag, nothing after it", async () => {
    const decoded = await decodeAt(244);
    expect(decoded.isMayhemMode).to.eq(true);
    expect(decoded.isCashbackCoin).to.eq(false);
    expect(decoded.virtualQuoteReserves.toString()).to.equal("0");
    expectCreatorFeeUnset(decoded);
  });

  it("245 bytes (pre-boost): cashback flag, no virtual reserves", async () => {
    const decoded = await decodeAt(245);
    expect(decoded.isMayhemMode).to.eq(true);
    expect(decoded.isCashbackCoin).to.eq(true);
    expect(decoded.virtualQuoteReserves.toString()).to.equal("0");
    expectCreatorFeeUnset(decoded);
  });

  it("261 bytes (pre-creator-fee, every live pool today): virtual reserves, creator fee unset", async () => {
    const decoded = await decodeAt(261);
    expectSharedFields(decoded);
    expect(decoded.coinCreator.equals(pool.coinCreator)).to.eq(true);
    expect(decoded.isMayhemMode).to.eq(true);
    expect(decoded.isCashbackCoin).to.eq(true);
    expect(decoded.virtualQuoteReserves.toString()).to.equal("-42");
    expectCreatorFeeUnset(decoded);
  });

  it("270 bytes (current) and 301 bytes (extended, zero tail): creator fee read from bytes 261..269", async () => {
    for (const length of [POOL_SIZE, 301]) {
      const decoded = await decodeAt(length);
      expectSharedFields(decoded);
      expect(decoded.virtualQuoteReserves.toString(), `${length}`).to.equal(
        "-42",
      );
      expect(decoded.creatorFeeBps.toString(), `${length}`).to.equal("250");
      expect(decoded.canEditCreatorFee, `${length}`).to.eq(true);
    }
    // A 301-byte pool that was extended before the upgrade has zeros there: unset.
    const extendedBeforeUpgrade = await poolBytes(
      encodablePool({ creatorFeeBps: new BN(0), canEditCreatorFee: false }),
      301,
    );
    expectCreatorFeeUnset(
      PUMP_AMM_SDK.decodePool(pumpAmmAccount(extendedBeforeUpgrade)),
    );
  });

  it("decodePoolNullable returns the same pools", async () => {
    const decoded = PUMP_AMM_SDK.decodePoolNullable(
      pumpAmmAccount(await poolBytes(pool, 261)),
    );
    expect(decoded).to.not.eq(null);
    expectCreatorFeeUnset(decoded!);
  });
});

describe("decodeGlobalConfig at every historical account length", () => {
  const globalConfig = encodableGlobalConfig({
    boostAuthority: PublicKey.unique(),
    boostEnabled: true,
    creatorFeeConfigurable: true,
    maxConfigurableCreatorFeeBps: new BN(500),
  });

  async function decodeAt(length: number): Promise<GlobalConfig> {
    const data = await globalConfigBytes(globalConfig, length);
    expect(data.length).to.equal(length);
    return PUMP_AMM_SDK.decodeGlobalConfig(pumpAmmAccount(data));
  }

  function expectSharedFields(decoded: GlobalConfig) {
    expect(decoded.admin.equals(globalConfig.admin)).to.eq(true);
    expect(
      decoded.adminSetCoinCreatorAuthority.equals(
        globalConfig.adminSetCoinCreatorAuthority,
      ),
    ).to.eq(true);
    expect(
      decoded.buybackFeeRecipients.map((key) => key.toBase58()),
    ).to.deep.equal(
      globalConfig.buybackFeeRecipients.map((key) => key.toBase58()),
    );
    expect(decoded.buybackBasisPoints.toString()).to.equal(
      globalConfig.buybackBasisPoints.toString(),
    );
  }

  it("GLOBAL_CONFIG_SIZE is the serialized size of the vendored layout", async () => {
    expect(GLOBAL_CONFIG_SIZE).to.equal(949);
    expect(OFFLINE_PUMP_AMM_PROGRAM.account.globalConfig.size).to.equal(
      GLOBAL_CONFIG_SIZE,
    );
    expect((await globalConfigBytes(globalConfig, 949)).length).to.equal(
      GLOBAL_CONFIG_SIZE,
    );
  });

  it("907 bytes (pre-boost): boost and creator-fee fields unset", async () => {
    const decoded = await decodeAt(907);
    expectSharedFields(decoded);
    expect(decoded.boostAuthority.equals(PublicKey.default)).to.eq(true);
    expect(decoded.boostEnabled).to.eq(false);
    expect(decoded.creatorFeeConfigurable).to.eq(false);
    expect(decoded.maxConfigurableCreatorFeeBps.toString()).to.equal("0");
  });

  it("940 bytes (pre-creator-fee, the live account today): boost fields kept, gate off, max 0", async () => {
    const decoded = await decodeAt(940);
    expectSharedFields(decoded);
    expect(decoded.boostAuthority.equals(globalConfig.boostAuthority)).to.eq(
      true,
    );
    expect(decoded.boostEnabled).to.eq(true);
    expect(decoded.creatorFeeConfigurable).to.eq(false);
    expect(decoded.maxConfigurableCreatorFeeBps.toString()).to.equal("0");
  });

  it("949 bytes (current): gate and max read from the account", async () => {
    const decoded = await decodeAt(949);
    expectSharedFields(decoded);
    expect(decoded.boostEnabled).to.eq(true);
    expect(decoded.creatorFeeConfigurable).to.eq(true);
    expect(decoded.maxConfigurableCreatorFeeBps.toString()).to.equal("500");
  });
});

function feesRow(actual: Fees): [string, string, string] {
  return [
    actual.lpFeeBps.toString(),
    actual.protocolFeeBps.toString(),
    actual.creatorFeeBps.toString(),
  ];
}

function expectFees(actual: Fees, expected: Fees, message?: string) {
  expect(feesRow(actual), message).to.deep.equal(feesRow(expected));
}

describe("creator fee override (pump-amm compute_fees)", () => {
  // Every schedule has its own LP / protocol / creator rates, so the override is told apart from
  // each of them and untouched rates are visible.
  const flatFees = fees(25, 5, 0);
  const solFees = fees(20, 5, 30);
  const stableFees = fees(21, 6, 95);
  const exoticFlatFees = fees(22, 7, 40);
  const feeConfig: FeeConfig = {
    admin: PublicKey.unique(),
    flatFees,
    feeTiers: [feeTier(0, solFees)],
    stableFeeTiers: [feeTier(0, stableFees)],
    exoticFlatFees,
  };
  const gateOff = encodableGlobalConfig();
  const gateOn = encodableGlobalConfig({
    creatorFeeConfigurable: true,
    maxConfigurableCreatorFeeBps: new BN(500),
  });
  const configured = new BN(250);
  const exoticQuote = PublicKey.unique();
  const schedules: [string, PublicKey, Fees][] = [
    ["WSOL", NATIVE_MINT, solFees],
    ["USDC", USDC_MINT, stableFees],
    ["exotic", exoticQuote, exoticFlatFees],
  ];

  const baseMint = PublicKey.unique();
  const args = {
    feeConfig,
    creator: pumpPoolAuthorityPda(baseMint),
    baseMintSupply: new BN(1_000),
    baseMint,
    baseReserve: new BN(1_000),
    quoteReserve: new BN(1_000),
  };

  it("gate off: a stored rate is ignored and every schedule applies unchanged", () => {
    for (const [name, quoteMint, schedule] of schedules) {
      expectFees(
        computeFeesBps({
          ...args,
          globalConfig: gateOff,
          quoteMint,
          creatorFeeBps: configured,
        }),
        schedule,
        name,
      );
    }
  });

  it("gate on, rate 0 or omitted: the schedule applies, identical to before the field existed", () => {
    for (const [name, quoteMint, schedule] of schedules) {
      const before = computeFeesBps({
        ...args,
        globalConfig: gateOff,
        quoteMint,
      });
      expectFees(before, schedule, name);
      expectFees(
        computeFeesBps({ ...args, globalConfig: gateOn, quoteMint }),
        before,
        `${name} omitted`,
      );
      expectFees(
        computeFeesBps({
          ...args,
          globalConfig: gateOn,
          quoteMint,
          creatorFeeBps: new BN(0),
        }),
        before,
        `${name} zero`,
      );
    }
  });

  it("gate on, rate set: the creator rate is replaced, LP and protocol rates are untouched", () => {
    for (const [name, quoteMint, schedule] of schedules) {
      const scheduleBefore = feesRow(schedule);
      const result = computeFeesBps({
        ...args,
        globalConfig: gateOn,
        quoteMint,
        creatorFeeBps: configured,
      });
      expectFees(result, { ...schedule, creatorFeeBps: configured }, name);
      expect(result.creatorFeeBps.toString()).to.equal("250");
      // The schedule object itself is not mutated.
      expect(feesRow(schedule), `${name} schedule intact`).to.deep.equal(
        scheduleBefore,
      );
    }
  });

  it("the rule reads neither the pool kind nor the cashback flag (the setters enforce those)", () => {
    // A permissionless pool pays flat fees; the program never stores a rate on one, but the fee
    // rule itself would honour it, exactly like compute_fees.
    expectFees(
      computeFeesBps({
        ...args,
        globalConfig: gateOn,
        creator: PublicKey.unique(),
        quoteMint: USDC_MINT,
        creatorFeeBps: configured,
      }),
      { ...flatFees, creatorFeeBps: configured },
    );
    // A cashback coin can never have a rate stored (6071), so its trades pay the schedule.
    expectFees(
      computeFeesBps({
        ...args,
        globalConfig: gateOn,
        quoteMint: NATIVE_MINT,
        creatorFeeBps: new BN(0),
      }),
      solFees,
    );
  });

  it("without a FeeConfig the GlobalConfig fees are returned, override or not (unreachable on-chain)", () => {
    const fromGlobal = {
      lpFeeBps: gateOn.lpFeeBasisPoints,
      protocolFeeBps: gateOn.protocolFeeBasisPoints,
      creatorFeeBps: gateOn.coinCreatorFeeBasisPoints,
    };
    expectFees(
      computeFeesBps({
        ...args,
        feeConfig: null,
        globalConfig: gateOn,
        creatorFeeBps: configured,
      }),
      fromGlobal,
    );
  });

  describe("through the pricing functions and the PumpAmmSdk wrappers", () => {
    const baseMintAccount: RawMint = {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.unique(),
      supply: BigInt("1000000000000000"),
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.unique(),
    };
    const coinCreator = PublicKey.unique();
    const pricingArgs = {
      slippage: 1,
      baseReserve: new BN("500000000000000"),
      quoteReserve: new BN("30000000000"),
      baseMintAccount,
      baseMint,
      coinCreator,
      creator: pumpPoolAuthorityPda(baseMint),
      feeConfig,
      quoteMint: USDC_MINT,
    };
    // Pricing the configured pool must equal pricing an unconfigured pool against a schedule
    // whose creator rate is the configured one.
    const equivalentFeeConfig: FeeConfig = {
      ...feeConfig,
      stableFeeTiers: [
        feeTier(0, { ...stableFees, creatorFeeBps: configured }),
      ],
    };
    const base = new BN(1_000_000);
    const quote = new BN(50_000_000);

    it("buyBaseInput / buyQuoteInput / sellBaseInput / sellQuoteInput apply the override and are unchanged without it", () => {
      const rows = (
        globalConfig: GlobalConfig,
        creatorFeeBps?: BN,
        config = feeConfig,
      ) => {
        const shared = {
          ...pricingArgs,
          globalConfig,
          feeConfig: config,
          creatorFeeBps,
        };
        const buyBase = buyBaseInput({ ...shared, base });
        const buyQuote = buyQuoteInput({ ...shared, quote });
        const sellBase = sellBaseInput({ ...shared, base });
        const sellQuote = sellQuoteInput({ ...shared, quote });
        return [
          buyBase.uiQuote.toString(),
          buyBase.maxQuote.toString(),
          buyQuote.base.toString(),
          buyQuote.maxQuote.toString(),
          sellBase.uiQuote.toString(),
          sellBase.minQuote.toString(),
          sellQuote.base.toString(),
          sellQuote.minQuote.toString(),
        ];
      };

      const before = rows(gateOff);
      expect(rows(gateOff, configured)).to.deep.equal(before);
      expect(rows(gateOn)).to.deep.equal(before);
      expect(rows(gateOn, new BN(0))).to.deep.equal(before);

      const overridden = rows(gateOn, configured);
      expect(overridden).to.not.deep.equal(before);
      expect(overridden).to.deep.equal(
        rows(gateOff, undefined, equivalentFeeConfig),
      );
    });

    it("PumpAmmSdk.buyBaseInput / sellBaseInput pass pool.creatorFeeBps to the pricing", async () => {
      const unconfigured = createSwapSolanaState({
        globalConfig: gateOn,
        feeConfig,
        quoteMint: USDC_MINT,
        baseMintAccount,
        poolBaseAmount: pricingArgs.baseReserve,
        poolQuoteAmount: pricingArgs.quoteReserve,
      });
      unconfigured.pool.coinCreator = coinCreator;
      const configuredState = {
        ...unconfigured,
        pool: { ...unconfigured.pool, creatorFeeBps: configured },
      };
      const poolArgs = {
        ...pricingArgs,
        baseMint: unconfigured.baseMint,
        creator: unconfigured.pool.creator,
        globalConfig: gateOn,
      };

      const buy = decodePumpAmmInstruction<{ maxQuoteAmountIn: BN }>(
        await PUMP_AMM_SDK.buyBaseInput(configuredState, base, 1),
        "buy",
      );
      expect(buy.maxQuoteAmountIn.toString()).to.equal(
        buyBaseInput({
          ...poolArgs,
          base,
          creatorFeeBps: configured,
        }).maxQuote.toString(),
      );
      expect(buy.maxQuoteAmountIn.toString()).to.not.equal(
        decodePumpAmmInstruction<{ maxQuoteAmountIn: BN }>(
          await PUMP_AMM_SDK.buyBaseInput(unconfigured, base, 1),
          "buy",
        ).maxQuoteAmountIn.toString(),
      );

      const sell = decodePumpAmmInstruction<{ minQuoteAmountOut: BN }>(
        await PUMP_AMM_SDK.sellBaseInput(configuredState, base, 1),
        "sell",
      );
      expect(sell.minQuoteAmountOut.toString()).to.equal(
        sellBaseInput({
          ...poolArgs,
          base,
          creatorFeeBps: configured,
        }).minQuote.toString(),
      );
      expect(sell.minQuoteAmountOut.toString()).to.not.equal(
        decodePumpAmmInstruction<{ minQuoteAmountOut: BN }>(
          await PUMP_AMM_SDK.sellBaseInput(unconfigured, base, 1),
          "sell",
        ).minQuoteAmountOut.toString(),
      );
    });
  });
});

/**
 * Asserts the instruction's fixed accounts are exactly the IDL's, in order, with the IDL's
 * writable / signer flags and the expected keys; returns the remaining accounts.
 */
function expectIdlAccounts(
  instruction: TransactionInstruction,
  instructionName: string,
  expected: Record<string, PublicKey>,
) {
  expect(instruction.programId.equals(PUMP_AMM_PROGRAM_ID)).to.eq(true);
  const accounts = idlAccounts(instructionName);
  expect(accounts.map((account) => account.name)).to.deep.equal(
    Object.keys(expected),
  );
  accounts.forEach((account, i) => {
    const key = instruction.keys[i];
    expect(key.pubkey.toBase58(), account.name).to.equal(
      expected[account.name].toBase58(),
    );
    expect(key.isWritable, `${account.name} writable`).to.equal(
      account.writable ?? false,
    );
    expect(key.isSigner, `${account.name} signer`).to.equal(
      account.signer ?? false,
    );
  });
  return instruction.keys.slice(accounts.length);
}

function dataHex(instruction: TransactionInstruction): string {
  return Buffer.from(instruction.data).toString("hex");
}

const SET_COIN_CREATOR_FEE_BPS_DISCRIMINATOR = Buffer.from([
  66, 89, 202, 237, 8, 118, 158, 169,
]);
const ADMIN_SET_COIN_CREATOR_FEE_EDITABLE_DISCRIMINATOR = Buffer.from([
  204, 65, 86, 207, 110, 84, 239, 104,
]);
const UPDATE_CREATOR_FEE_CONFIG_DISCRIMINATOR = Buffer.from([
  61, 175, 160, 249, 66, 66, 136, 175,
]);

describe("feeSharingConfigPda", () => {
  it('derives ["sharing-config", mint] under the pump-fees program', () => {
    expect(feeSharingConfigPda(USDC_MINT).toBase58()).to.equal(
      "FqLHai8iUBQxRtvGWVBh7CXMyjZw75mggPCT5KVUh1v7",
    );
    const mint = PublicKey.unique();
    expect(
      feeSharingConfigPda(mint).equals(
        PublicKey.findProgramAddressSync(
          [Buffer.from("sharing-config"), mint.toBuffer()],
          PUMP_FEE_PROGRAM_ID,
        )[0],
      ),
    ).to.eq(true);
    expect(
      feeSharingConfigPda(mint).equals(feeSharingConfigPda(USDC_MINT)),
    ).to.eq(false);
  });
});

describe("creator fee builders", () => {
  const poolKey = PublicKey.unique();
  const coinCreator = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;

  it("set_coin_creator_fee_bps: discriminator, IDL accounts, u64 arg, optional SharingConfig remaining account", async () => {
    const name = "setCoinCreatorFeeBps";
    const instruction = await PUMP_AMM_SDK.setCoinCreatorFeeBpsInstruction({
      coinCreator,
      pool: poolKey,
      creatorFeeBps: new BN(250),
    });
    expect(
      instruction.data
        .subarray(0, 8)
        .equals(SET_COIN_CREATOR_FEE_BPS_DISCRIMINATOR),
    ).to.eq(true);
    expect(dataHex(instruction)).to.equal(
      SET_COIN_CREATOR_FEE_BPS_DISCRIMINATOR.toString("hex") + u64Le(250),
    );
    const remaining = expectIdlAccounts(instruction, name, {
      coinCreator,
      globalConfig: GLOBAL_CONFIG_PDA,
      pool: poolKey,
      eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      program: PUMP_AMM_PROGRAM_ID,
    });
    expect(remaining).to.deep.equal([]);
    // The signer is read-only; only the pool is written.
    expect(instruction.keys[0].isSigner).to.eq(true);
    expect(instruction.keys[0].isWritable).to.eq(false);
    expect(instruction.keys[2].isWritable).to.eq(true);

    const sharingConfig = feeSharingConfigPda(PublicKey.unique());
    const withSharingConfig =
      await PUMP_AMM_SDK.setCoinCreatorFeeBpsInstruction({
        coinCreator,
        pool: poolKey,
        creatorFeeBps: new BN(1),
        sharingConfig,
      });
    expect(dataHex(withSharingConfig)).to.equal(
      SET_COIN_CREATOR_FEE_BPS_DISCRIMINATOR.toString("hex") + u64Le(1),
    );
    const [remainingSharingConfig, ...rest] = expectIdlAccounts(
      withSharingConfig,
      name,
      {
        coinCreator,
        globalConfig: GLOBAL_CONFIG_PDA,
        pool: poolKey,
        eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
        program: PUMP_AMM_PROGRAM_ID,
      },
    );
    expect(rest).to.deep.equal([]);
    expect(remainingSharingConfig.pubkey.equals(sharingConfig)).to.eq(true);
    expect(remainingSharingConfig.isWritable).to.eq(false);
    expect(remainingSharingConfig.isSigner).to.eq(false);
  });

  it("set_coin_creator: metadata and bonding_curve derived from the base mint under the IDL's programs, no signer, pool writable, no args", async () => {
    const baseMint = PublicKey.unique();
    const instruction = await PUMP_AMM_SDK.setCoinCreator(poolKey, baseMint);

    // The helpers derive under the very programs the IDL's seeds name.
    const seedProgram = (accountName: string) => {
      const account = idlAccounts("setCoinCreator").find(
        ({ name }) => name === accountName,
      ) as unknown as { pda: { program: { value: number[] } } };
      return new PublicKey(Buffer.from(account.pda.program.value));
    };
    expect(seedProgram("metadata").equals(MPL_TOKEN_METADATA_PROGRAM_ID)).to.eq(
      true,
    );
    expect(seedProgram("bondingCurve").equals(PUMP_PROGRAM_ID)).to.eq(true);
    const metadata = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        baseMint.toBuffer(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID,
    )[0];
    const bondingCurve = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), baseMint.toBuffer()],
      PUMP_PROGRAM_ID,
    )[0];
    expect(metadataPda(baseMint).equals(metadata)).to.eq(true);
    expect(bondingCurvePda(baseMint).equals(bondingCurve)).to.eq(true);

    expect(dataHex(instruction)).to.equal(
      instructionDiscriminator("setCoinCreator").toString("hex"),
    );
    const remaining = expectIdlAccounts(instruction, "setCoinCreator", {
      pool: poolKey,
      metadata,
      bondingCurve,
      eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      program: PUMP_AMM_PROGRAM_ID,
    });
    expect(remaining).to.deep.equal([]);
    expect(instruction.keys.some((key) => key.isSigner)).to.eq(false);
    expect(instruction.keys[0].isWritable).to.eq(true);
  });

  it("admin_set_coin_creator_fee_editable: discriminator, IDL accounts (authority writable signer, pool writable), no args", async () => {
    const instruction =
      await PUMP_AMM_SDK.adminSetCoinCreatorFeeEditableInstruction({
        adminSetCoinCreatorAuthority: authority,
        pool: poolKey,
      });
    expect(dataHex(instruction)).to.equal(
      ADMIN_SET_COIN_CREATOR_FEE_EDITABLE_DISCRIMINATOR.toString("hex"),
    );
    const remaining = expectIdlAccounts(
      instruction,
      "adminSetCoinCreatorFeeEditable",
      {
        adminSetCoinCreatorAuthority: authority,
        globalConfig: GLOBAL_CONFIG_PDA,
        pool: poolKey,
        systemProgram: SystemProgram.programId,
        eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
        program: PUMP_AMM_PROGRAM_ID,
      },
    );
    expect(remaining).to.deep.equal([]);
    expect(instruction.keys[0].isSigner).to.eq(true);
    expect(instruction.keys[0].isWritable).to.eq(true);
    expect(instruction.keys[2].isWritable).to.eq(true);
  });

  it("update_creator_fee_config (PumpAmmAdminSdk): admin read from a live-sized GlobalConfig, bool + u64 args", async () => {
    const globalConfig = encodableGlobalConfig();
    const sdk = new PumpAmmAdminSdk(
      stubConnection(
        new Map([
          [
            GLOBAL_CONFIG_PDA.toBase58(),
            pumpAmmAccount(await globalConfigBytes(globalConfig, 940)),
          ],
        ]),
      ),
    );

    const on = await sdk.updateCreatorFeeConfig(true, new BN(500));
    expect(dataHex(on)).to.equal(
      UPDATE_CREATOR_FEE_CONFIG_DISCRIMINATOR.toString("hex") +
        "01" +
        u64Le(500),
    );
    const remaining = expectIdlAccounts(on, "updateCreatorFeeConfig", {
      admin: globalConfig.admin,
      globalConfig: GLOBAL_CONFIG_PDA,
      systemProgram: SystemProgram.programId,
      eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      program: PUMP_AMM_PROGRAM_ID,
    });
    expect(remaining).to.deep.equal([]);
    expect(on.keys[0].isSigner).to.eq(true);
    expect(on.keys[0].isWritable).to.eq(true);
    expect(on.keys[1].isWritable).to.eq(true);

    const off = await sdk.updateCreatorFeeConfig(false, new BN(0));
    expect(dataHex(off)).to.equal(
      UPDATE_CREATOR_FEE_CONFIG_DISCRIMINATOR.toString("hex") + "00" + u64Le(0),
    );
  });
});

describe("OnlinePumpAmmSdk creator fee wrappers", () => {
  const baseMint = PublicKey.unique();
  const creator = pumpPoolAuthorityPda(baseMint);
  const poolKey = poolPda(0, creator, baseMint, USDC_MINT);
  const coinCreator = Keypair.generate().publicKey;
  const sharingConfigAdmin = Keypair.generate().publicKey;
  const sharingConfig = feeSharingConfigPda(baseMint);
  const gateOn = encodableGlobalConfig({
    creatorFeeConfigurable: true,
    maxConfigurableCreatorFeeBps: new BN(500),
  });
  const editablePool = encodablePool({
    baseMint,
    creator,
    coinCreator,
    isCashbackCoin: false,
    creatorFeeBps: new BN(0),
    canEditCreatorFee: true,
  });

  async function sdkFor(
    pool: Pool,
    globalConfig: GlobalConfig = gateOn,
    globalConfigLength = GLOBAL_CONFIG_SIZE,
    fetched: string[] = [],
  ): Promise<OnlinePumpAmmSdk> {
    return new OnlinePumpAmmSdk(
      stubConnection(
        new Map([
          [
            GLOBAL_CONFIG_PDA.toBase58(),
            pumpAmmAccount(
              await globalConfigBytes(globalConfig, globalConfigLength),
            ),
          ],
          [
            poolKey.toBase58(),
            pumpAmmAccount(await poolBytes(pool, POOL_SIZE)),
          ],
        ]),
        fetched,
      ),
    );
  }

  async function rejects(call: () => Promise<unknown>, pattern: RegExp) {
    let error: unknown;
    try {
      await call();
    } catch (e) {
      error = e;
    }
    expect(String(error)).to.match(pattern);
  }

  it("setCoinCreatorFeeBpsInstructions: signed by the coin creator, no remaining account, one fetch", async () => {
    const fetched: string[] = [];
    const sdk = await sdkFor(editablePool, gateOn, GLOBAL_CONFIG_SIZE, fetched);

    const instructions = await sdk.setCoinCreatorFeeBpsInstructions(
      coinCreator,
      poolKey,
      new BN(250),
    );
    expect(instructions).to.have.length(1);
    const remaining = expectIdlAccounts(
      instructions[0],
      "setCoinCreatorFeeBps",
      {
        coinCreator,
        globalConfig: GLOBAL_CONFIG_PDA,
        pool: poolKey,
        eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
        program: PUMP_AMM_PROGRAM_ID,
      },
    );
    expect(remaining).to.deep.equal([]);
    expect(dataHex(instructions[0])).to.equal(
      SET_COIN_CREATOR_FEE_BPS_DISCRIMINATOR.toString("hex") + u64Le(250),
    );
    expect(fetched).to.deep.equal([
      GLOBAL_CONFIG_PDA.toBase58(),
      poolKey.toBase58(),
    ]);
  });

  it("setCoinCreatorFeeBpsInstructions: passes the SharingConfig as remaining account 0 when it is the coin creator", async () => {
    const sdk = await sdkFor(
      encodablePool({ ...editablePool, coinCreator: sharingConfig }),
    );

    const [instruction] = await sdk.setCoinCreatorFeeBpsInstructions(
      sharingConfigAdmin,
      poolKey,
      new BN(500),
    );
    const remaining = expectIdlAccounts(instruction, "setCoinCreatorFeeBps", {
      coinCreator: sharingConfigAdmin,
      globalConfig: GLOBAL_CONFIG_PDA,
      pool: poolKey,
      eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      program: PUMP_AMM_PROGRAM_ID,
    });
    expect(remaining).to.have.length(1);
    expect(remaining[0].pubkey.equals(sharingConfig)).to.eq(true);
    expect(remaining[0].isWritable).to.eq(false);
    expect(remaining[0].isSigner).to.eq(false);
  });

  it("setCoinCreatorFeeBpsInstructions: rejects the gate off, a cashback pool and a rate outside 1..=max", async () => {
    const disabled = /Configurable creator fees are disabled/;
    // Gate off on a current-size account, and on the live 940-byte account (gate reads false).
    await rejects(
      async () =>
        (
          await sdkFor(editablePool, encodableGlobalConfig())
        ).setCoinCreatorFeeBpsInstructions(coinCreator, poolKey, new BN(1)),
      disabled,
    );
    await rejects(
      async () =>
        (
          await sdkFor(editablePool, gateOn, 940)
        ).setCoinCreatorFeeBpsInstructions(coinCreator, poolKey, new BN(1)),
      disabled,
    );

    await rejects(
      async () =>
        (
          await sdkFor(encodablePool({ ...editablePool, isCashbackCoin: true }))
        ).setCoinCreatorFeeBpsInstructions(coinCreator, poolKey, new BN(1)),
      /is a cashback coin; cashback coins cannot have a creator fee/,
    );

    const sdk = await sdkFor(editablePool);
    for (const outOfRange of [new BN(0), new BN(501)]) {
      await rejects(
        () =>
          sdk.setCoinCreatorFeeBpsInstructions(
            coinCreator,
            poolKey,
            outOfRange,
          ),
        /must be between 1 and GlobalConfig\.maxConfigurableCreatorFeeBps=500/,
      );
    }
    for (const inRange of [new BN(1), new BN(500)]) {
      expect(
        await sdk.setCoinCreatorFeeBpsInstructions(
          coinCreator,
          poolKey,
          inRange,
        ),
      ).to.have.length(1);
    }
  });

  it("setCoinCreatorFeeBpsInstructions: rejects a permissionless pool", async () => {
    await rejects(
      async () =>
        (
          await sdkFor(
            encodablePool({ ...editablePool, creator: PublicKey.unique() }),
          )
        ).setCoinCreatorFeeBpsInstructions(coinCreator, poolKey, new BN(1)),
      /is not a canonical pump pool/,
    );
  });

  it("setCoinCreatorInstructions: derives metadata / bonding_curve from a pre-upgrade 261-byte pool and prepends extend_account; a grown pool gets set_coin_creator alone", async () => {
    const payer = Keypair.generate().publicKey;
    const setCoinCreatorAccounts = {
      pool: poolKey,
      metadata: metadataPda(baseMint),
      bondingCurve: bondingCurvePda(baseMint),
      eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      program: PUMP_AMM_PROGRAM_ID,
    };
    const poolServed = async (length: number, fetched: string[]) =>
      stubConnection(
        new Map([
          [
            poolKey.toBase58(),
            pumpAmmAccount(await poolBytes(editablePool, length)),
          ],
        ]),
        fetched,
      );

    const fetched: string[] = [];
    const [extend, setCoinCreator, ...rest] = await new OnlinePumpAmmSdk(
      await poolServed(261, fetched),
    ).setCoinCreatorInstructions(poolKey, payer);
    expect(rest).to.deep.equal([]);
    expect(fetched).to.deep.equal([poolKey.toBase58()]);
    expect(dataHex(extend)).to.equal(
      instructionDiscriminator("extendAccount").toString("hex"),
    );
    expect(
      expectIdlAccounts(extend, "extendAccount", {
        account: poolKey,
        user: payer,
        systemProgram: SystemProgram.programId,
        eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
        program: PUMP_AMM_PROGRAM_ID,
      }),
    ).to.deep.equal([]);
    expect(dataHex(setCoinCreator)).to.equal(
      instructionDiscriminator("setCoinCreator").toString("hex"),
    );
    expect(
      expectIdlAccounts(
        setCoinCreator,
        "setCoinCreator",
        setCoinCreatorAccounts,
      ),
    ).to.deep.equal([]);

    for (const grown of [POOL_SIZE, POOL_ACCOUNT_NEW_SIZE + 1]) {
      const instructions = await new OnlinePumpAmmSdk(
        await poolServed(grown, []),
      ).setCoinCreatorInstructions(poolKey, payer);
      expect(instructions, `${grown} bytes`).to.have.length(
        grown < POOL_ACCOUNT_NEW_SIZE ? 2 : 1,
      );
      expect(
        expectIdlAccounts(
          instructions[instructions.length - 1],
          "setCoinCreator",
          setCoinCreatorAccounts,
        ),
      ).to.deep.equal([]);
    }
  });

  it("Anchor's account resolver cannot derive pool-seeded accounts from a pre-upgrade 261-byte pool with this IDL (why the SDK passes them explicitly)", async () => {
    const resolved = async (length: number) =>
      getPumpAmmProgram(
        stubConnection(
          new Map([
            [
              poolKey.toBase58(),
              pumpAmmAccount(await poolBytes(editablePool, length)),
            ],
          ]),
        ),
      )
        .methods.setCoinCreator()
        .accountsPartial({ pool: poolKey })
        .instruction();

    await rejects(
      () => resolved(261),
      /Reached maximum depth for account resolution/,
    );

    // A grown pool resolves to exactly what the SDK derives without any account read.
    const fromResolver = await resolved(POOL_SIZE);
    const fromSdk = await PUMP_AMM_SDK.setCoinCreator(poolKey, baseMint);
    expect(goldenInstruction(fromResolver)).to.deep.equal(
      goldenInstruction(fromSdk),
    );
  });

  it("adminSetCoinCreatorFeeEditableInstructions: authority read from GlobalConfig", async () => {
    const sdk = await sdkFor(editablePool);
    const instructions =
      await sdk.adminSetCoinCreatorFeeEditableInstructions(poolKey);
    expect(instructions).to.have.length(1);
    const remaining = expectIdlAccounts(
      instructions[0],
      "adminSetCoinCreatorFeeEditable",
      {
        adminSetCoinCreatorAuthority: gateOn.adminSetCoinCreatorAuthority,
        globalConfig: GLOBAL_CONFIG_PDA,
        pool: poolKey,
        systemProgram: SystemProgram.programId,
        eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
        program: PUMP_AMM_PROGRAM_ID,
      },
    );
    expect(remaining).to.deep.equal([]);
    expect(dataHex(instructions[0])).to.equal(
      ADMIN_SET_COIN_CREATOR_FEE_EDITABLE_DISCRIMINATOR.toString("hex"),
    );
  });
});

describe("creator fee events", () => {
  const coder = OFFLINE_PUMP_AMM_PROGRAM.coder;

  function eventLog(eventName: string, typeName: string, data: object): Buffer {
    const discriminator = pumpAmmJson.events.find(
      (event) => event.name === eventName,
    )!.discriminator;
    return Buffer.concat([
      Buffer.from(discriminator),
      coder.types.encode(typeName, data),
    ]);
  }

  function decode(log: Buffer) {
    const decoded = coder.events.decode(log.toString("base64"));
    expect(decoded).to.not.eq(null);
    return decoded!;
  }

  it("decodes the three new events by discriminator", () => {
    const update = decode(
      eventLog("UpdateCreatorFeeConfigEvent", "updateCreatorFeeConfigEvent", {
        timestamp: new BN(1_700_000_000),
        admin: PublicKey.unique(),
        creatorFeeConfigurable: true,
        maxConfigurableCreatorFeeBps: new BN(500),
      }),
    );
    expect(update.name).to.equal("updateCreatorFeeConfigEvent");
    expect(update.data.creatorFeeConfigurable).to.eq(true);
    expect(update.data.maxConfigurableCreatorFeeBps.toString()).to.equal("500");

    const pool = PublicKey.unique();
    const set = decode(
      eventLog("SetCoinCreatorFeeBpsEvent", "setCoinCreatorFeeBpsEvent", {
        timestamp: new BN(1_700_000_001),
        authority: PublicKey.unique(),
        baseMint: USDC_MINT,
        pool,
        oldCreatorFeeBps: new BN(0),
        newCreatorFeeBps: new BN(250),
      }),
    );
    expect(set.name).to.equal("setCoinCreatorFeeBpsEvent");
    expect(set.data.pool.equals(pool)).to.eq(true);
    expect(set.data.oldCreatorFeeBps.toString()).to.equal("0");
    expect(set.data.newCreatorFeeBps.toString()).to.equal("250");

    const editable = decode(
      eventLog(
        "AdminSetCoinCreatorFeeEditableEvent",
        "adminSetCoinCreatorFeeEditableEvent",
        {
          timestamp: new BN(1_700_000_002),
          adminSetCoinCreatorAuthority: PublicKey.unique(),
          baseMint: USDC_MINT,
          pool,
        },
      ),
    );
    expect(editable.name).to.equal("adminSetCoinCreatorFeeEditableEvent");
    expect(editable.data.pool.equals(pool)).to.eq(true);
  });

  it("CreatePoolEvent: current logs decode the two new fields; logs from before them do not decode with this IDL", () => {
    const log = eventLog("CreatePoolEvent", "createPoolEvent", {
      timestamp: new BN(1_700_000_000),
      index: 0,
      creator: PublicKey.unique(),
      baseMint: PublicKey.unique(),
      quoteMint: USDC_MINT,
      baseMintDecimals: 6,
      quoteMintDecimals: 6,
      baseAmountIn: new BN(1),
      quoteAmountIn: new BN(2),
      poolBaseAmount: new BN(3),
      poolQuoteAmount: new BN(4),
      minimumLiquidity: new BN(5),
      initialLiquidity: new BN(6),
      lpTokenAmountOut: new BN(7),
      poolBump: 255,
      pool: PublicKey.unique(),
      lpMint: PublicKey.unique(),
      userBaseTokenAccount: PublicKey.unique(),
      userQuoteTokenAccount: PublicKey.unique(),
      coinCreator: PublicKey.unique(),
      isMayhemMode: false,
      creatorFeeBps: new BN(250),
      canEditCreatorFee: true,
    });
    const { data } = decode(log);
    expect(data.creatorFeeBps.toString()).to.equal("250");
    expect(data.canEditCreatorFee).to.eq(true);

    // A log emitted before the fields existed is 9 bytes shorter. The trailing bool is read past
    // the end of the buffer and throws (a u64 alone would read as 0), so consumers decoding
    // historical CreatePoolEvent logs must append 9 zero bytes first.
    expect(() => decode(log.subarray(0, log.length - 9))).to.throw(
      /out of range/,
    );
    const padded = decode(
      Buffer.concat([log.subarray(0, log.length - 9), Buffer.alloc(9)]),
    );
    expect(padded.data.creatorFeeBps.toString()).to.equal("0");
    expect(padded.data.canEditCreatorFee).to.eq(false);
  });
});
