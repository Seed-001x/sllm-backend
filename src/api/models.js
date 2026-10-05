// src/api/models.js — SLMS supermodel agency API.
//
// Flow:
//   1. POST /sllm/models            (auth) — create a model: name, portrait,
//      personality. Auto-generates the model's OWN Solana wallet (encrypted
//      at rest). Returns the model incl. wallet address.
//   2. POST /sllm/upload            (auth) — portrait data URL -> pump.fun
//      IPFS -> metadata JSON -> IPFS. Returns { imageUri, metadataUri }.
//   3. POST /sllm/models/:id/launch/prepare (auth, creator only) — builds an
//      UNSIGNED pump create_v2 tx with the MODEL's wallet as `creator`
//      (so all creator fees flow to her). Client signs with their wallet +
//      client-generated mint keypair, then POSTs to /submit.
//   4. POST /sllm/models/:id/launch/submit  (auth, creator only) — sends the
//      signed tx, confirms, records token_mint on the model.
//   5. POST /sllm/models/:id/chat   (auth) — AI chat in her voice (OpenAI
//      gpt-4o-mini; trait-aware fallback when no key). 30/hr per model.
//   6. POST /sllm/models/:id/trade  (auth, creator only) — Jupiter SOL->token
//      buy from HER wallet. 0.001–0.5 SOL, 5/hr.
//
// Boundaries (same as Tamastream):
//   * The backend never holds USER keys — the launcher signs in-browser.
//   * The model's encrypted wallet secret is NEVER logged or returned.
//   * creator is the MODEL's wallet: 100% of pump.fun creator fees flow to
//     her automatically at the protocol level.

import {
  PUMP_SDK,
} from '@nirholas/pump-sdk';
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import BN from 'bn.js';
import { generateModelWallet, decryptModelWallet } from '../wallet/modelWallet.js';
import { getQuote, executeSwap, SOL_MINT } from '../trading/jupiter.js';
import { chatWithModel, TRAIT_VOICES } from '../ai/modelChat.js';

const ALLOWED_TRAITS = Object.keys(TRAIT_VOICES);

// In-memory rate limits (per model per hour).
const chatBuckets = new Map(); // modelId -> [timestamps]
const tradeBuckets = new Map();
function bucketOk(map, key, max) {
  const now = Date.now();
  let hits = (map.get(key) || []).filter((t) => now - t < 3600000);
  if (hits.length >= max) {
    map.set(key, hits);
    return false;
  }
  hits.push(now);
  map.set(key, hits);
  return true;
}

function isPubkey(s) {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** Upload a buffer to pump.fun's IPFS. Returns the URI. */
async function ipfsUpload(fileBuffer, filename, contentType) {
  const blob = new Blob([fileBuffer], { type: contentType });
  const fd = new FormData();
  fd.append('file', blob, filename);
  const res = await fetch('https://pump.fun/api/ipfs', {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`ipfs upload failed: ${res.status}`);
  const j = await res.json();
  const uri = j?.metadataUri || j?.metadata?.image;
  if (!uri) throw new Error('ipfs upload returned no URI');
  if (contentType.startsWith('image/')) {
    try {
      const head = await fetch(uri, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      const ct = head.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) {
        const meta = await (await fetch(uri, { signal: AbortSignal.timeout(15000) })).json();
        if (meta?.image && typeof meta.image === 'string') return meta.image;
      }
    } catch { /* frontend has gateway fallback */ }
  }
  return uri;
}

// Public model shape — NEVER includes wallet_encrypted.
function publicModel(row) {
  if (!row) return null;
  const { wallet_encrypted, ...rest } = row;
  return rest;
}

async function getModel(pool, id) {
  const { rows } = await pool.query(
    `SELECT id, name, image_url, personality, wallet_address,
            token_mint, token_name, token_ticker, launch_signature,
            status, created_by, created_at
     FROM sllm_models WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export function registerModelRoutes(app, { pool, rpcConnection, requireAuth }) {
  // ---------------------------------------------------------------- public

  // Agency roster — newest first.
  app.get('/sllm/models', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, image_url, personality, wallet_address,
                token_mint, token_name, token_ticker, status,
                created_by, created_at
         FROM sllm_models ORDER BY created_at DESC LIMIT 100`
      );
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: 'failed to list models', detail: e.message });
    }
  });

  // Single model.
  app.get('/sllm/models/:id', async (req, res) => {
    const model = await getModel(pool, req.params.id).catch(() => null);
    if (!model) return res.status(404).json({ error: 'model not found' });
    res.json({ data: publicModel(model) });
  });

  // Model's wallet (public): address + SOL balance. Never key material.
  app.get('/sllm/models/:id/wallet', async (req, res) => {
    try {
      const model = await getModel(pool, req.params.id);
      if (!model) return res.status(404).json({ error: 'model not found' });
      const pubkey = model.wallet_address || null;
      let balanceLamports = null;
      try {
        const conn = await rpcConnection();
        if (conn && pubkey && isPubkey(pubkey)) {
          balanceLamports = await conn.getBalance(new PublicKey(pubkey));
        }
      } catch { /* balance unavailable — still return the pubkey */ }
      res.json({
        data: {
          pubkey,
          balanceLamports,
          balanceSol: balanceLamports == null ? null : balanceLamports / 1e9,
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'failed to fetch model wallet', detail: e.message });
    }
  });

  // Recent chat history (public, last 50).
  app.get('/sllm/models/:id/chats', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT role, content, created_at FROM sllm_chats
         WHERE model_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.params.id]
      );
      res.json({ data: rows.reverse() });
    } catch (e) {
      res.status(500).json({ error: 'failed to fetch chats', detail: e.message });
    }
  });

  // Trade history (public, last 20).
  app.get('/sllm/models/:id/trades', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, side, token_mint, amount_sol, token_amount, signature, created_at
         FROM sllm_trades WHERE model_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [req.params.id]
      );
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: 'failed to fetch trades', detail: e.message });
    }
  });

  // ---------------------------------------------------------------- authed

  // Create a model: name, portrait, personality. Generates HER wallet.
  // Body: { name, image_url?, personality: { traits[], vibe, backstory } }
  app.post('/sllm/models', requireAuth, async (req, res) => {
    try {
      const { name, image_url, personality } = req.body || {};
      const nm = String(name || '').trim();
      if (!nm || nm.length > 40) return res.status(400).json({ error: 'name: 1-40 chars' });

      const p = personality && typeof personality === 'object' ? personality : {};
      const traits = Array.isArray(p.traits)
        ? [...new Set(p.traits.map((t) => String(t).toLowerCase()))]
            .filter((t) => ALLOWED_TRAITS.includes(t)).slice(0, 5)
        : [];
      if (!traits.length) {
        return res.status(400).json({ error: `pick at least 1 trait: ${ALLOWED_TRAITS.join(', ')}` });
      }
      const vibe = String(p.vibe || '').slice(0, 280);
      const backstory = String(p.backstory || '').slice(0, 1000);

      let img = null;
      if (typeof image_url === 'string' && image_url) {
        img = image_url.slice(0, 2_000_000); // data URLs allowed for v1
        const okData = /^data:image\/(png|jpeg|gif|webp);base64,/.test(img);
        const okHttp = /^https:\/\//.test(img);
        if (!okData && !okHttp) return res.status(400).json({ error: 'image_url must be a data URL or https URL' });
      }

      let wallet;
      try {
        wallet = generateModelWallet();
      } catch (e) {
        console.error('[sllm] model wallet generation failed:', e.message);
        return res.status(500).json({ error: 'model wallet unavailable', detail: e.message });
      }

      const { rows } = await pool.query(
        `INSERT INTO sllm_models
           (name, image_url, personality, wallet_address, wallet_encrypted, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         RETURNING id, name, image_url, personality, wallet_address,
                   token_mint, token_name, token_ticker, status, created_by, created_at`,
        [nm, img, JSON.stringify({ traits, vibe, backstory }), wallet.pubkey, wallet.encryptedSecret, req.auth.pubkey]
      );
      res.json({ data: publicModel(rows[0]) });
    } catch (e) {
      console.error('[sllm] create model failed:', e.message);
      res.status(500).json({ error: 'failed to create model', detail: e.message });
    }
  });

  // Upload a portrait (data URL) -> pump.fun IPFS -> metadata JSON.
  // Body: { image, name, ticker, description }. Returns { imageUri, metadataUri }.
  app.post('/sllm/upload', requireAuth, async (req, res) => {
    try {
      const { image, name, ticker, description } = req.body || {};
      if (typeof image !== 'string' || !image.startsWith('data:image/')) {
        return res.status(400).json({ error: 'image must be a data URL' });
      }
      const m = /^data:(image\/(png|jpeg|gif|webp));base64,(.+)$/.exec(image);
      if (!m) return res.status(400).json({ error: 'unsupported image format (png/jpeg/gif/webp)' });
      const buf = Buffer.from(m[3], 'base64');
      if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'image too large (5MB max)' });
      const nm = String(name || '').slice(0, 32);
      const sym = String(ticker || '').slice(0, 10);
      if (!nm || !sym) return res.status(400).json({ error: 'name and ticker are required' });

      const imageUri = await ipfsUpload(buf, 'model.png', m[1]);
      const metadata = {
        name: nm,
        symbol: sym,
        description: String(description || '').slice(0, 1000),
        image: imageUri,
        createdOn: 'https://sllm.agency',
      };
      const metadataUri = await ipfsUpload(
        Buffer.from(JSON.stringify(metadata)), 'metadata.json', 'application/json'
      );
      res.json({ data: { imageUri, metadataUri } });
    } catch (e) {
      console.error('[sllm] upload failed:', e.message);
      res.status(502).json({ error: 'upload failed', detail: e.message });
    }
  });

  // Build the UNSIGNED pump.fun create transaction for a model's coin.
  // Body: { mint, name, ticker, metadataUri, imageUri? }. Creator-only.
  app.post('/sllm/models/:id/launch/prepare', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });

      const modelId = req.params.id;
      const { rows: mrows } = await pool.query(
        'SELECT * FROM sllm_models WHERE id = $1', [modelId]
      );
      const model = mrows[0];
      if (!model) return res.status(404).json({ error: 'model not found' });
      if (model.created_by !== req.auth.pubkey) {
        return res.status(403).json({ error: 'only the model creator can launch her coin' });
      }
      if (model.token_mint) {
        return res.status(409).json({ error: 'this model already launched a coin', mint: model.token_mint });
      }

      const b = req.body || {};
      const mintStr = b.mint;
      const coinName = String(b.name || '').trim();
      const symbol = String(b.ticker || '').trim().toUpperCase();
      const metadataUri = String(b.metadataUri || '').trim();
      const imageUri = String(b.imageUri || '');
      if (!isPubkey(mintStr)) return res.status(400).json({ error: 'invalid mint pubkey' });
      if (!coinName || coinName.length > 32) return res.status(400).json({ error: 'name: 1-32 chars' });
      if (!symbol || symbol.length > 10) return res.status(400).json({ error: 'ticker: 1-10 chars' });
      if (!/^https:\/\//.test(metadataUri)) return res.status(400).json({ error: 'metadataUri must be https' });

      const mintInfo = await conn.getAccountInfo(new PublicKey(mintStr));
      if (mintInfo) return res.status(400).json({ error: 'mint already exists on-chain' });

      const launcher = new PublicKey(req.auth.pubkey);
      const bal = await conn.getBalance(launcher);
      if (bal < 0.03 * 1e9) {
        return res.status(400).json({ error: 'insufficient SOL', detail: 'The launcher wallet needs ~0.03 SOL for mint rent and fees.' });
      }

      // The MODEL's wallet is the coin's creator — all creator fees flow to her.
      const creator = new PublicKey(model.wallet_address);
      const createIx = await PUMP_SDK.createV2Instruction({
        mint: new PublicKey(mintStr),
        name: coinName,
        symbol,
        uri: metadataUri,
        creator,
        user: launcher,
        mayhemMode: false,
        creatorFeeBps: new BN(0),
        holderReward: false,
      });

      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: launcher,
          recentBlockhash: blockhash,
          instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), createIx],
        }).compileToV0Message()
      );
      const txBase64 = Buffer.from(tx.serialize()).toString('base64');

      await pool.query(
        `INSERT INTO sllm_launch_intents
           (model_id, mint, launcher_wallet, name, symbol, metadata_uri, image_url, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '24 hours')
         ON CONFLICT (mint) DO UPDATE SET
           model_id = EXCLUDED.model_id, launcher_wallet = EXCLUDED.launcher_wallet,
           name = EXCLUDED.name, symbol = EXCLUDED.symbol,
           metadata_uri = EXCLUDED.metadata_uri, image_url = EXCLUDED.image_url,
           created_at = now(), expires_at = now() + interval '24 hours'`,
        [modelId, mintStr, req.auth.pubkey, coinName, symbol, metadataUri, imageUri || null]
      );

      res.json({ data: { txBase64, mint: mintStr, modelWallet: model.wallet_address } });
    } catch (e) {
      console.error('[sllm] launch prepare failed:', e.message);
      res.status(500).json({ error: 'prepare failed', detail: e.message });
    }
  });

  // Submit a signed launch tx. Records token_mint on the model.
  // Body: { mint, signedTxBase64 }.
  app.post('/sllm/models/:id/launch/submit', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });
      const modelId = req.params.id;
      const { mint, signedTxBase64 } = req.body || {};
      if (!isPubkey(mint) || typeof signedTxBase64 !== 'string' || !signedTxBase64) {
        return res.status(400).json({ error: 'mint and signedTxBase64 are required' });
      }

      const { rows: intents } = await pool.query(
        `SELECT * FROM sllm_launch_intents
         WHERE mint = $1 AND model_id = $2 AND expires_at > now()`,
        [mint, modelId]
      );
      if (!intents.length) {
        return res.status(400).json({ error: 'no live launch intent for this mint (expired or unknown)' });
      }
      const intent = intents[0];
      if (intent.launcher_wallet !== req.auth.pubkey) {
        return res.status(403).json({ error: 'intent belongs to a different wallet' });
      }

      let tx;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(signedTxBase64, 'base64'));
      } catch {
        return res.status(400).json({ error: 'invalid signed transaction' });
      }
      const mintPk = new PublicKey(mint);
      const keys = tx.message.staticAccountKeys || [];
      if (!keys.some((k) => k.equals(mintPk))) {
        return res.status(400).json({ error: 'transaction does not touch this mint' });
      }

      const signature = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
      try {
        const latest = await conn.getLatestBlockhash('confirmed');
        await conn.confirmTransaction(
          { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          'confirmed'
        );
      } catch (confirmErr) {
        console.warn('[sllm] submit confirm timed out:', confirmErr.message);
      }

      // Verify the mint exists (retry for RPC lag), else fall back to tx status.
      let mintInfo = null;
      let txConfirmed = false;
      for (let i = 0; i < 10; i++) {
        try { mintInfo = await conn.getAccountInfo(mintPk, 'confirmed'); } catch { /* retry */ }
        if (mintInfo) break;
        try {
          const st = await conn.getSignatureStatus(signature);
          const cs = st && st.value && st.value.confirmationStatus;
          if (cs === 'confirmed' || cs === 'finalized') txConfirmed = true;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!mintInfo && !txConfirmed) {
        return res.status(400).json({ error: 'mint not found on-chain after submit (tx may have failed)' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE sllm_models SET
             token_mint = $2, token_name = $3, token_ticker = $4,
             launch_signature = $5, status = 'launched'
           WHERE id = $1`,
          [modelId, mint, intent.name, intent.symbol, signature]
        );
        await client.query('DELETE FROM sllm_launch_intents WHERE mint = $1', [mint]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      res.json({ data: { mint, signature } });
    } catch (e) {
      console.error('[sllm] launch submit failed:', e.message);
      res.status(500).json({ error: 'submit failed', detail: e.message });
    }
  });

  // AI chat with the model (auth). 30/hr per model. Persists to sllm_chats.
  // Body: { message, history: [{role:'user'|'model', text}], market? }.
  app.post('/sllm/models/:id/chat', requireAuth, async (req, res) => {
    try {
      const modelId = req.params.id;
      const { message, history, market } = req.body || {};
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
      }
      if (message.length > 500) {
        return res.status(400).json({ error: 'message too long (500 chars max)' });
      }
      const model = await getModel(pool, modelId);
      if (!model) return res.status(404).json({ error: 'model not found' });
      if (!bucketOk(chatBuckets, String(modelId), 30)) {
        return res.status(429).json({ error: 'chat rate limit: max 30 AI messages per hour per model' });
      }

      const reply = await chatWithModel({
        model,
        message,
        history: Array.isArray(history) ? history.slice(-10) : [],
        market: market && typeof market === 'object' ? market : null,
      });

      // Persist the exchange (best-effort).
      try {
        await pool.query(
          `INSERT INTO sllm_chats (model_id, role, content) VALUES
           ($1, 'user', $2), ($1, 'model', $3)`,
          [modelId, message.slice(0, 500), reply.text.slice(0, 2000)]
        );
      } catch (e) {
        console.warn('[sllm] chat persist failed:', e.message);
      }
      res.json({ data: reply });
    } catch (e) {
      console.error('[sllm] chat failed:', e.message);
      res.status(500).json({ error: 'chat failed', detail: e.message });
    }
  });

  // Trade history is public (see above). Execution: creator only.
  // Body: { tokenMint, amountSol } — SOL -> token buy from HER wallet.
  app.post('/sllm/models/:id/trade', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });
      const modelId = req.params.id;
      const { tokenMint, amountSol } = req.body || {};
      if (!isPubkey(tokenMint)) return res.status(400).json({ error: 'invalid tokenMint' });
      const amt = Number(amountSol);
      if (!Number.isFinite(amt) || amt < 0.001 || amt > 0.5) {
        return res.status(400).json({ error: 'amountSol must be between 0.001 and 0.5' });
      }

      const { rows } = await pool.query(
        'SELECT id, created_by, wallet_address, wallet_encrypted FROM sllm_models WHERE id = $1',
        [modelId]
      );
      const model = rows[0];
      if (!model) return res.status(404).json({ error: 'model not found' });
      if (model.created_by !== req.auth.pubkey) {
        return res.status(403).json({ error: 'only the model creator can trigger trades' });
      }
      if (!bucketOk(tradeBuckets, String(modelId), 5)) {
        return res.status(429).json({ error: 'trade rate limit: max 5 trades per hour per model' });
      }

      const kp = decryptModelWallet(model.wallet_encrypted);
      const balance = await conn.getBalance(kp.publicKey);
      const lamports = Math.floor(amt * 1e9);
      if (balance < lamports + 0.01 * 1e9) {
        return res.status(400).json({
          error: 'insufficient model wallet balance',
          detail: `Model wallet holds ${(balance / 1e9).toFixed(4)} SOL; needs ${amt} + 0.01 buffer.`,
        });
      }

      const quote = await getQuote(SOL_MINT, tokenMint, lamports, 100);
      const { signature, outAmount } = await executeSwap(kp, quote, conn);

      await pool.query(
        `INSERT INTO sllm_trades
           (model_id, side, token_mint, amount_sol, token_amount, signature)
         VALUES ($1, 'buy', $2, $3, $4, $5)`,
        [modelId, tokenMint, amt, outAmount ? BigInt(outAmount).toString() : null, signature]
      );

      res.json({
        data: {
          signature,
          inputAmountSol: amt,
          outputMint: tokenMint,
          outputAmountApprox: outAmount,
          explorerUrl: `https://solscan.io/tx/${signature}`,
        },
      });
    } catch (e) {
      console.error('[sllm] trade failed:', e.message);
      res.status(500).json({ error: 'trade failed', detail: e.message });
    }
  });
}
