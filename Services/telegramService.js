// Services/telegramService.js
//
// Telegram alert system for WebAura.
//
// Goals:
//   • Notify admin when a downloader fails (so issues are caught early)
//   • Avoid spam by deduplicating identical errors within a short window
//   • Tag every message so admin can filter / mute by topic in Telegram
//   • NEVER throw — alert failures must not affect the download flow
//
// Usage:
//   const telegram = require('./telegramService');
//   await telegram.notifyDownloadFailure('facebook', url, error);
//   await telegram.notifyStartup();   // call once when server boots
//
// Setup (.env):
//   TELEGRAM_BOT_TOKEN=8738645562:AAEVX9QbrKzMAhP7OJCjHV8PaY1eY14zT10
//   TELEGRAM_CHAT_ID=7761674902
//   TELEGRAM_THREAD_ID=         # optional — set if using a topic in a forum group
//   TELEGRAM_ALERTS_ENABLED=1   # optional — set to 0 to silence in dev

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────────
//
// Reads from process.env first; falls back to inline defaults so the bot still
// works on hosts where setting env vars has been a hassle. To override or
// rotate credentials, set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in your
// environment — the env value always wins.
//
// To revoke this token: open BotFather → /revoke → choose the bot → /token to
// generate a new one. Then either update the inline default below or set the
// env var.

const FALLBACK_TOKEN   = '8738645562:AAEVX9QbrKzMAhP7OJCjHV8PaY1eY14zT10';
const FALLBACK_CHAT_ID = '7761674902';

const TOKEN     = process.env.TELEGRAM_BOT_TOKEN || FALLBACK_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || FALLBACK_CHAT_ID;
const THREAD_ID = process.env.TELEGRAM_THREAD_ID || ''; // for forum/topic groups
const ENABLED   = process.env.TELEGRAM_ALERTS_ENABLED !== '0';

const API_BASE  = 'https://api.telegram.org';
const APP_TAG   = '#WebAura'; // always present so user can mute the whole project

// Anti-spam knobs
const DEDUP_TTL_MS       = 5 * 60 * 1000;  // same error key suppressed for 5 min
const RATE_LIMIT_PER_MIN = 20;             // hard ceiling on alerts per minute
const RATE_WINDOW_MS     = 60 * 1000;

// ─── State (in-memory) ───────────────────────────────────────────────────────

// key -> { ts: last sent timestamp, suppressed: count dropped since then }
const dedupCache = new Map();
// timestamps of recent sends, oldest first
let recentSends = [];

// ─── Utilities ───────────────────────────────────────────────────────────────

const escapeHtml = (str) => String(str || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const truncate = (str, n) => {
  const s = String(str || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const errorSignature = (err) => {
  const msg = (err && err.message) ? err.message : String(err || '');
  // Strip URLs, IDs, timestamps so similar errors cluster
  return msg
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d{6,}\b/g, '<id>')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
    .trim();
};

const isRateLimited = () => {
  const now = Date.now();
  recentSends = recentSends.filter(t => now - t < RATE_WINDOW_MS);
  return recentSends.length >= RATE_LIMIT_PER_MIN;
};

/**
 * Duplicate check with repeat counting. Returns:
 *   { dup: true }                      — suppress this alert, count it
 *   { dup: false, suppressed: N }      — send it; N = how many identical
 *                                        alerts were swallowed since the
 *                                        last one actually sent
 * The suppressed count lets the alert say "×4 in last 5 min" instead of
 * silently hiding that the error kept happening.
 */
const checkDuplicate = (key) => {
  const now = Date.now();
  const entry = dedupCache.get(key);
  if (entry && now - entry.ts < DEDUP_TTL_MS) {
    entry.suppressed++;
    return { dup: true };
  }
  const suppressed = entry ? entry.suppressed : 0;
  dedupCache.set(key, { ts: now, suppressed: 0 });
  // Best-effort cleanup so the map doesn't grow unbounded
  if (dedupCache.size > 500) {
    for (const [k, v] of dedupCache) {
      if (now - v.ts > DEDUP_TTL_MS) dedupCache.delete(k);
    }
  }
  return { dup: false, suppressed };
};

// ─── Low-level send ──────────────────────────────────────────────────────────

async function sendRaw(text, { silent = false } = {}) {
  if (!ENABLED) {
    console.log('[telegram] alerts disabled, would have sent:', text.slice(0, 100));
    return false;
  }
  if (!TOKEN || !CHAT_ID) {
    console.log('[telegram] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — skipping');
    return false;
  }

  const payload = {
    chat_id:                  CHAT_ID,
    text:                     truncate(text, 3900), // hard tg limit is 4096
    parse_mode:               'HTML',
    disable_web_page_preview: true,
    disable_notification:     silent,
  };
  if (THREAD_ID) payload.message_thread_id = Number(THREAD_ID);

  try {
    const url = `${API_BASE}/bot${TOKEN}/sendMessage`;
    const res = await axios.post(url, payload, { timeout: 8000 });
    return !!(res.data && res.data.ok);
  } catch (e) {
    // Never throw — alerting must not break the request flow
    const desc = e?.response?.data?.description || e.message || 'unknown';
    console.warn('[telegram] send failed:', desc);
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generic admin notifier.
 * @param {string} message  HTML-safe text (use escapeHtml in callers if dynamic)
 * @param {object} [opts]
 * @param {string[]} [opts.tags]    e.g. ['failure', 'facebook']
 * @param {string}   [opts.dedupKey] suppress if same key seen in last 5 min
 * @param {boolean}  [opts.silent]  silent push
 */
async function notifyAdmin(message, opts = {}) {
  const { tags = [], dedupKey = null, silent = false } = opts;

  let suppressed = 0;
  if (dedupKey) {
    const check = checkDuplicate(dedupKey);
    if (check.dup) {
      console.log(`[telegram] dedup: skipped (key=${dedupKey})`);
      return false;
    }
    suppressed = check.suppressed;
  }
  if (isRateLimited()) {
    console.warn('[telegram] rate limited, dropping message');
    return false;
  }

  const tagLine = [APP_TAG, ...tags.map(t => `#${t.replace(/[^a-zA-Z0-9_]/g, '')}`)]
    .join(' ');

  const repeatLine = suppressed > 0
    ? `\n🔁 <i>×${suppressed + 1} occurrences in the last 5 min (${suppressed} suppressed)</i>`
    : '';

  const text = `${tagLine}\n\n${message}${repeatLine}`;
  recentSends.push(Date.now());
  return sendRaw(text, { silent });
}

// ─── Failure formatting ──────────────────────────────────────────────────────

// Lazy require to avoid a load-order cycle (controller requires both).
let _classify = null;
function classifySafe(err) {
  try {
    if (!_classify) ({ classify: _classify } = require('./errorClassifier'));
    return _classify(err);
  } catch (_) {
    return { code: 'DOWNLOAD_FAILED', userMessage: '' };
  }
}

const PLATFORM_EMOJI = {
  instagram: '📸', tiktok: '🎵', facebook: '📘', twitter: '🐦',
  youtube: '▶️', pinterest: '📌', threads: '🧵', linkedin: '💼',
  reddit: '👽', vimeo: '🎬', twitch: '🎮', soundcloud: '🎧',
  generic: '🌐',
};

const CODE_EMOJI = {
  AGE_RESTRICTED:  '🔞', GEO_BLOCKED:     '🌍', PRIVATE_CONTENT: '🔒',
  LOGIN_REQUIRED:  '🔑', DRM_PROTECTED:   '🛡️', NOT_FOUND:       '🗑️',
  RATE_LIMITED:    '🐢', LIVE_ONLY:       '📡', UNSUPPORTED_SITE:'❓',
  TIMEOUT:         '⏳', DOWNLOAD_FAILED: '🚨',
};

const shortUrl = (u) => {
  try {
    const p = new URL(u);
    return truncate(p.hostname.replace(/^www\./, '') + p.pathname, 70);
  } catch (_) { return truncate(u, 70); }
};

const utcStamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC · ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
};

/**
 * Convenience helper — alert when a platform downloader fails.
 *
 * Organised layout: one glanceable header (platform + failure class),
 * then short URL, then the raw diagnostic in a collapsed <code> block.
 * The error class comes from errorClassifier so "age restricted" and
 * "deleted post" stop looking like the same generic wall of stderr.
 */
async function notifyDownloadFailure(platform, url, error) {
  const sig  = errorSignature(error);
  const cls  = classifySafe(error);
  const pEmo = PLATFORM_EMOJI[platform] || '🚨';
  const cEmo = CODE_EMOJI[cls.code] || '🚨';
  const title = cls.code.replace(/_/g, ' ')
    .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); // "Age Restricted"

  const lines = [
    `${pEmo} <b>${escapeHtml((platform || 'unknown').toUpperCase())}</b> — ${cEmo} <b>${escapeHtml(title)}</b>`,
    `🔗 <code>${escapeHtml(shortUrl(url))}</code>`,
  ];
  if (cls.userMessage) lines.push(`💬 ${escapeHtml(truncate(cls.userMessage, 150))}`);
  lines.push(`🧾 <code>${escapeHtml(truncate(sig, 350))}</code>`);
  lines.push(`⏱ ${escapeHtml(utcStamp())}`);

  return notifyAdmin(lines.join('\n'), {
    tags:     ['failure', platform || 'unknown', cls.code],
    dedupKey: `fail:${platform}:${sig}`,
    // Expected/permanent failures (user pasted a deleted or private link)
    // don't need to buzz the phone — only genuinely broken things do.
    silent:   ['NOT_FOUND', 'PRIVATE_CONTENT', 'AGE_RESTRICTED', 'GEO_BLOCKED', 'DRM_PROTECTED', 'LIVE_ONLY'].includes(cls.code),
  });
}

/**
 * Server boot ping — confirms wiring is correct.
 */
async function notifyStartup(extra = {}) {
  const lines = [
    `✅ <b>WebAura server connected</b>`,
    `<b>Env:</b> ${escapeHtml(process.env.NODE_ENV || 'development')}`,
    `<b>Node:</b> ${escapeHtml(process.version)}`,
    `<b>Time:</b> ${escapeHtml(new Date().toISOString())}`,
  ];
  if (extra.port) lines.push(`<b>Port:</b> ${escapeHtml(extra.port)}`);

  return notifyAdmin(lines.join('\n'), {
    tags:   ['startup'],
    silent: true, // boot ping shouldn't buzz the phone
  });
}

/**
 * Generic info / heartbeat alert (uses tag 'info').
 */
async function notifyInfo(message, extraTags = []) {
  return notifyAdmin(message, {
    tags:   ['info', ...extraTags],
    silent: true,
  });
}

module.exports = {
  notifyAdmin,
  notifyDownloadFailure,
  notifyStartup,
  notifyInfo,
};