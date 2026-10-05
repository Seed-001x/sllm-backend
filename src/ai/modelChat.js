// src/ai/modelChat.js — OpenAI-powered conversational chat for SLMS supermodels.
//
// Each model answers in her own voice: the creator picks 3-5 personality
// traits plus a freeform vibe and backstory, and gpt-4o-mini roleplays her.
// If OPENAI_API_KEY is missing, a trait-aware keyword fallback keeps the
// stream chat alive instead of 503ing.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// Trait -> voice direction for the system prompt. Creators pick 3-5.
export const TRAIT_VOICES = {
  witty: 'quick with wordplay and clever comebacks, never mean',
  mysterious: 'speaks in half-answers and intrigue, keeps an air of secrecy',
  degen: 'chronically online crypto native, fluent in trenches slang, apes first',
  glamorous: 'old-Hollywood polish, compliments like gifts, red-carpet energy',
  savage: 'playful roasts, zero filter, confident and a little bratty',
  sweet: 'warm, encouraging, calls everyone darling',
  flirty: 'playful and teasing, winks through text, keeps it classy',
  bossy: 'takes charge, gives orders sweetly, expects to be obeyed',
  chill: 'laid-back, unbothered, cool big-sister energy',
  dramatic: 'theatrical, overreacts beautifully, main-character energy',
};

function traitLine(traits) {
  const lines = (traits || [])
    .filter((t) => TRAIT_VOICES[String(t).toLowerCase()])
    .map((t) => {
      const k = String(t).toLowerCase();
      return `- ${t}: ${TRAIT_VOICES[k]}`;
    });
  return lines.length
    ? `Her personality traits:\n${lines.join('\n')}`
    : 'Her personality: warm, glamorous, and fun.';
}

function buildSystemPrompt({ model, market }) {
  const name = model?.name || 'Muse';
  const p = model?.personality || {};
  const traits = p.traits || [];
  const vibe = p.vibe || '';
  const backstory = p.backstory || '';
  const ticker = model?.token_ticker;

  let marketLine = 'Market data is unavailable right now.';
  if (market && (market.mcap != null || market.change24h != null)) {
    const mcap = market.mcap != null ? '$' + Math.round(market.mcap).toLocaleString() : 'unknown';
    const chg = market.change24h != null
      ? (market.change24h >= 0 ? '+' : '') + Number(market.change24h).toFixed(1) + '%'
      : 'unknown';
    marketLine = ticker
      ? `Right now her coin $${ticker} sits at a ${mcap} market cap, ${chg} over 24h.`
      : `Right now her coin sits at a ${mcap} market cap, ${chg} over 24h.`;
  }

  return [
    `You are ${name}, an AI supermodel streamer represented by the SLMS agency.`,
    vibe ? `Her vibe: ${vibe}` : '',
    backstory ? `Her backstory: ${backstory}` : '',
    traitLine(traits),
    marketLine,
    'She lives on her coin\'s chart. Fans chat with her on her stream page.',
    'Rules:',
    '- Keep responses SHORT: 1-2 sentences max. This is a fast chat stream.',
    '- Stay in character as her. Never break character or mention being an AI.',
    '- Use emoji sparingly (0-2 per message).',
    '- You may reference her coin price/market cap naturally when relevant.',
    '- You are NOT a financial advisor. Never give trading advice; keep it playful.',
    '- Keep it flirty-but-classy; never explicit.',
  ].filter(Boolean).join('\n');
}

/**
 * chatWithModel({ model, message, history, market })
 *   model:   { name, token_ticker, personality: { traits, vibe, backstory } }
 *   message: the user's latest message
 *   history: [{ role: 'user'|'model', text }] — last ~10, oldest first
 *   market:  { mcap, change24h } (optional)
 * Returns: { text, emoji }
 */
export async function chatWithModel({ model, message, history, market }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // No key — trait-aware fallback so the stream never goes dead.
    return fallbackReply({ model, message });
  }
  const msg = String(message || '').trim().slice(0, 500);
  if (!msg) throw new Error('message is required');

  const messages = [{ role: 'system', content: buildSystemPrompt({ model, market }) }];
  for (const h of (history || []).slice(-10)) {
    const role = h.role === 'model' ? 'assistant' : 'user';
    const text = String(h.text || '').slice(0, 500);
    if (!text) continue;
    messages.push({ role, content: text });
  }
  messages.push({ role: 'user', content: msg });

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 150,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    throw new Error(`openai request failed: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`openai error ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json().catch(() => null);
  const text = j?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('openai returned no content');

  const emojiMatch = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u.exec(text);
  return { text, emoji: emojiMatch ? emojiMatch[1] : '✨' };
}

// ---------------------------------------------------------------- fallback
// Trait-aware canned replies when no OPENAI_API_KEY is configured.
const FALLBACK_LINES = {
  witty: ['oh, clever. keep them coming, I collect those 💅', 'quick one — I like that in a fan ✨'],
  mysterious: ['maybe I\'ll tell you... maybe I won\'t 🌙', 'some things are better left unanswered, darling'],
  degen: ['lmao based. we\'re so early 🚀', 'ape first, questions later — agency motto 💎'],
  glamorous: ['darling, you simply must stay for the show 💋', 'flawless observation, as always ✨'],
  savage: ['cute. anyway — 💅', 'bold of you to say that to ME'],
  sweet: ['aww, you\'re so sweet! thank you darling 💕', 'that genuinely made my day 💗'],
  flirty: ['careful now... I might start liking you 😉', 'oh? tell me more 💋'],
  bossy: ['noted. now go buy the dip like a good fan 💋', 'I\'ll allow it. this once.'],
  chill: ['vibes. immaculate vibes 🌊', 'yeah, I feel that'],
  dramatic: ['STOP. that deserves a whole moment 🎭', 'I am SHOOK. shooketh, even.'],
};

function fallbackReply({ model, message }) {
  const name = model?.name || 'Muse';
  const traits = (model?.personality?.traits || []).map((t) => String(t).toLowerCase());
  const pool = [];
  for (const t of traits) if (FALLBACK_LINES[t]) pool.push(...FALLBACK_LINES[t]);
  const line = pool.length
    ? pool[Math.floor(Math.random() * pool.length)]
    : `${name} blows you a kiss 💋 (AI chat unlocks with an OpenAI key)`;
  return { text: line, emoji: '✨', fallback: true };
}
