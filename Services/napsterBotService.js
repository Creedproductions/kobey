// Services/napsterBotService.js
//
// Napster Homes staff bot — daily Telegram updates for the Airbnb logbook
// (https://creedproductions.github.io/napster-homes/, data lives in the
// webaura-ba777 Firestore under the nh_* collections).
//
//   • 20:00 Africa/Kampala — if NOTHING was recorded today, post a reminder
//     in the staff group.
//   • 22:00 Africa/Kampala — post the day's summary: check-ins/check-outs
//     and who handled them, bookings, money in, money spent (with the
//     mobile-money numbers it was sent to), and the week's running totals.
//
// Reuses the WebAura alerts bot (@webaura_alerts_bot). Add that bot to the
// staff group and it links itself automatically (or send /link inside the
// group). Group commands: /summary (post today's summary now), /link, /id.
//
// Setup (.env / Koyeb env vars):
//   FIREBASE_SERVICE_ACCOUNT  service-account JSON for webaura-ba777, raw or
//                             base64 (Firebase console → Project settings →
//                             Service accounts → Generate new private key).
//   NAPSTER_TELEGRAM_CHAT_ID  optional manual group-id override.
//   NAPSTER_BOT_ENABLED=0     disable the whole bot.
//
// Deliberately dependency-free beyond axios + node-cron (already installed):
// Firestore is reached over REST with a JWT signed via Node's crypto, so the
// Docker `npm ci` build needs no lockfile change. Never throws — every
// failure is logged and swallowed, exactly like telegramService.
//
// NOTE: uses Telegram long-polling (getUpdates), which assumes a single
// running instance of this server. If kobey is ever scaled to multiple
// instances, gate this service to one of them.

const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');

// Same token strategy (env first, inline fallback) as telegramService.js.
const FALLBACK_TOKEN = '8738645562:AAEVX9QbrKzMAhP7OJCjHV8PaY1eY14zT10';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || FALLBACK_TOKEN;
const ENABLED = process.env.NAPSTER_BOT_ENABLED !== '0';

const EAT_TZ = 'Africa/Kampala'; // UTC+3, no DST
const SITE = 'https://creedproductions.github.io/napster-homes/';
const TG = `https://api.telegram.org/bot${TOKEN}`;
const PROJECT = 'webaura-ba777';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const log = (msg) => console.log('[napster-bot] ' + msg);
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ─── Service account / OAuth token ──────────────────────────────────────────

let sa = null;
(() => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) return;
  try {
    const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(txt);
    if (parsed.client_email && parsed.private_key) sa = parsed;
    else log('FIREBASE_SERVICE_ACCOUNT is missing client_email/private_key');
  } catch (e) {
    log('could not parse FIREBASE_SERVICE_ACCOUNT: ' + e.message);
  }
})();

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let cachedTok = { val: null, exp: 0 };
async function accessToken() {
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
  const now = Math.floor(Date.now() / 1000);
  if (cachedTok.val && now < cachedTok.exp - 120) return cachedTok.val;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + claims);
  const jwt = header + '.' + claims + '.' + b64url(signer.sign(sa.private_key));
  const r = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 },
  );
  cachedTok = { val: r.data.access_token, exp: now + (r.data.expires_in || 3600) };
  return cachedTok.val;
}

// ─── Firestore REST helpers ─────────────────────────────────────────────────

function fromVal(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('mapValue' in v) return fromFields((v.mapValue && v.mapValue.fields) || {});
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fromVal);
  return null;
}
function fromFields(f) {
  const o = {};
  Object.keys(f || {}).forEach((k) => { o[k] = fromVal(f[k]); });
  return o;
}
function toVal(x) {
  if (typeof x === 'number') return { doubleValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  return { stringValue: String(x) };
}

async function getDoc(path) {
  const t = await accessToken();
  try {
    const r = await axios.get(`${FS_BASE}/${path}`, {
      headers: { Authorization: 'Bearer ' + t }, timeout: 15000,
    });
    return fromFields(r.data.fields);
  } catch (e) {
    if (e.response && e.response.status === 404) return null;
    throw e;
  }
}

async function setDoc(path, obj) {
  const t = await accessToken();
  const fields = {};
  Object.keys(obj).forEach((k) => { fields[k] = toVal(obj[k]); });
  await axios.patch(`${FS_BASE}/${path}`, { fields }, {
    headers: { Authorization: 'Bearer ' + t }, timeout: 15000,
  });
}

// All rows of `coll` whose string field `date` is within [from, to].
async function queryByDate(coll, from, to) {
  const t = await accessToken();
  const body = {
    structuredQuery: {
      from: [{ collectionId: coll }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: from } } },
            { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: to } } },
          ],
        },
      },
    },
  };
  const r = await axios.post(`${FS_BASE}:runQuery`, body, {
    headers: { Authorization: 'Bearer ' + t }, timeout: 20000,
  });
  return (r.data || [])
    .filter((row) => row.document && row.document.fields)
    .map((row) => fromFields(row.document.fields));
}

// ─── Dates (East Africa Time) ───────────────────────────────────────────────

function eatKey(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EAT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d || new Date());
}
function niceDate() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: EAT_TZ, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date());
}
// Monday..Sunday keys of the week containing today (EAT).
function weekRange() {
  const d = new Date(eatKey() + 'T00:00:00Z');
  const back = (d.getUTCDay() + 6) % 7;
  const mon = new Date(d.getTime() - back * 86400000);
  const day = (i) => new Date(mon.getTime() + i * 86400000).toISOString().slice(0, 10);
  return { from: day(0), to: day(6), days: [0, 1, 2, 3, 4, 5, 6].map(day) };
}

// ─── Linked group chat ──────────────────────────────────────────────────────

let cachedChat = process.env.NAPSTER_TELEGRAM_CHAT_ID || null;
async function linkedChat() {
  if (cachedChat) return cachedChat;
  if (!sa) return null;
  try {
    const d = await getDoc('nh_meta/telegram');
    if (d && d.chatId) { cachedChat = String(d.chatId); return cachedChat; }
  } catch (e) { log('could not read chat link: ' + e.message); }
  return null;
}
async function linkChat(id, title) {
  cachedChat = String(id);
  if (!sa) return;
  try {
    await setDoc('nh_meta/telegram', {
      chatId: String(id), title: title || '', linkedAt: new Date().toISOString(),
    });
  } catch (e) { log('could not persist chat link: ' + e.message); }
}

// ─── Telegram ───────────────────────────────────────────────────────────────

async function send(chatId, html) {
  try {
    await axios.post(`${TG}/sendMessage`, {
      chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
    }, { timeout: 15000 });
  } catch (e) {
    const why = (e.response && e.response.data && e.response.data.description) || e.message;
    log('send failed: ' + why);
  }
}

const LINKED_MSG = '✅ <b>Napster Homes bot linked to this group.</b>\n'
  + 'Daily summary at 10:00 PM, and a reminder at 8:00 PM if nothing was '
  + 'recorded that day (East Africa Time).\n'
  + 'Commands: /summary — post today\'s summary now · /id · /link';

// ─── Logbook data ───────────────────────────────────────────────────────────

const DEFAULT_STAFF = ['mukama', 'ahereza', 'swimming'];

async function dayData(key) {
  const [day, pays, exps, settings, roster] = await Promise.all([
    getDoc('nh_days/' + key),
    queryByDate('nh_payments', key, key),
    queryByDate('nh_expenses', key, key),
    getDoc('nh_meta/settings'),
    getDoc('nh_meta/roster').catch(() => null),
  ]);
  return {
    day: day || {},
    pays,
    exps,
    cur: (settings && settings.currency) || 'UGX',
    staff: (roster && Array.isArray(roster.names) && roster.names.length)
      ? roster.names.map((n) => String(n).toLowerCase()) : DEFAULT_STAFF,
  };
}

function isEmptyDay(d) {
  const day = d.day;
  const hasDay = day.checkIn || day.checkOut || day.occupied || day.booking
    || String(day.note || '').trim();
  return !hasDay && d.pays.length === 0 && d.exps.length === 0;
}

async function weekTotals() {
  const { from, to, days } = weekRange();
  const [pays, exps, dayDocs] = await Promise.all([
    queryByDate('nh_payments', from, to),
    queryByDate('nh_expenses', from, to),
    Promise.all(days.map((k) => getDoc('nh_days/' + k).catch(() => null))),
  ]);
  let inc = pays.reduce((s, p) => s + Number(p.amount || 0), 0);
  const out = exps.reduce((s, x) => s + Number(x.amount || 0) + Number(x.fee || 0), 0);
  dayDocs.forEach((dd) => { if (dd && dd.booking) inc += Number(dd.booking.fee || 0); });
  return { inc, out };
}

function money(cur, n) {
  return cur + ' ' + Math.round(Number(n) || 0).toLocaleString('en-US');
}

function buildSummary(d, week) {
  const e = escapeHtml;
  const cur = d.cur;
  const day = d.day;
  const L = ['🏡 <b>Napster Homes — ' + e(niceDate()) + '</b>', ''];

  if (day.checkIn) {
    L.push('🟢 Check-in ' + e(day.checkIn.time || '?') + ' — ' + e(day.checkIn.guest || 'guest')
      + (day.checkIn.by ? ' (by ' + e(day.checkIn.by) + ')' : ''));
  }
  if (day.checkOut) {
    L.push('🔴 Check-out ' + e(day.checkOut.time || '?') + ' — ' + e(day.checkOut.guest || 'guest')
      + (day.checkOut.by ? ' (by ' + e(day.checkOut.by) + ')' : ''));
  }
  if (day.occupied && !day.checkIn && !day.checkOut) L.push('🛏 Guest staying');
  if (day.booking) {
    const fee = Number(day.booking.fee || 0);
    const who = day.booking.by ? ' (by ' + e(day.booking.by) + ')' : '';
    L.push(fee > 0
      ? '🟠 Booked ✓ fee ' + money(cur, fee) + ' — ' + e(day.booking.guest || '') + who
      : '🟡 Booked, fee not paid — ' + e(day.booking.guest || '') + who);
  }
  if (String(day.note || '').trim()) L.push('📝 ' + e(String(day.note).trim()));
  if (Array.isArray(day.edits) && day.edits.length) {
    const last = day.edits[day.edits.length - 1] || {};
    L.push('✏️ Info was edited ' + day.edits.length + '×'
      + (last.by ? ' — last by ' + e(last.by) : ''));
  }

  if (isEmptyDay(d)) L.push('Nothing was recorded today.');

  const inc = d.pays.reduce((s, p) => s + Number(p.amount || 0), 0)
    + (day.booking ? Number(day.booking.fee || 0) : 0);
  const out = d.exps.reduce((s, x) => s + Number(x.amount || 0) + Number(x.fee || 0), 0);

  if (d.pays.length || inc > 0) {
    L.push('', '💰 <b>Money in — ' + money(cur, inc) + '</b>');
    d.pays.forEach((p) => L.push(' • ' + e(p.kind || 'Payment') + ' ' + money(cur, p.amount)
      + (p.by ? ' — ' + e(p.by) : '')));
    if (day.booking && Number(day.booking.fee || 0) > 0) {
      L.push(' • Booking fee ' + money(cur, day.booking.fee)
        + (day.booking.by ? ' — ' + e(day.booking.by) : ''));
    }
  }
  if (d.exps.length) {
    L.push('', '💸 <b>Money spent — ' + money(cur, out) + '</b>');
    d.exps.forEach((x) => {
      const tot = Number(x.amount || 0) + Number(x.fee || 0);
      L.push(' • ' + e(x.item || 'Expense') + ' ' + money(cur, tot)
        + (Number(x.fee || 0) > 0 ? ' (incl. charge ' + money(cur, x.fee) + ')' : '')
        + (x.sentTo ? ' → ' + e(x.sentTo) : '')
        + (x.by ? ' — ' + e(x.by) : ''));
    });
  }

  // Per-staff label: what each person put today (M — mukama, A — ahereza,
  // S — swimming …), including who put nothing.
  const lc = (x) => String(x || '').trim().toLowerCase();
  const capName = (n) => (n ? n.charAt(0).toUpperCase() + n.slice(1) : n);
  L.push('', '👥 <b>Staff — what each person put</b>');
  d.staff.forEach((name) => {
    const acts = [];
    if (lc(day.checkIn && day.checkIn.by) === name) acts.push('check-in');
    if (lc(day.checkOut && day.checkOut.by) === name) acts.push('check-out');
    if (lc(day.booking && day.booking.by) === name) acts.push('booking');
    const pn = d.pays.filter((p) => lc(p.by) === name).length;
    if (pn) acts.push(pn + ' payment' + (pn > 1 ? 's' : ''));
    const en = d.exps.filter((x) => lc(x.by) === name).length;
    if (en) acts.push(en + ' expense' + (en > 1 ? 's' : ''));
    if (!acts.length && lc(day.updatedBy) === name
      && (day.occupied || String(day.note || '').trim())) acts.push('updated the day');
    L.push(' • <b>' + e(name.charAt(0).toUpperCase()) + '</b> ' + e(capName(name)) + ' — '
      + (acts.length ? e(acts.join(', ')) : '<i>nothing recorded</i>'));
  });

  const net = inc - out;
  L.push('', '📊 Today: ' + (net < 0 ? '−' : '+') + money(cur, Math.abs(net))
    + '  |  This week: in ' + money(cur, week.inc) + ' / out ' + money(cur, week.out));
  L.push('<a href="' + SITE + '">Open the logbook</a>');
  return L.join('\n');
}

// ─── Scheduled posts ────────────────────────────────────────────────────────

async function postSummary(chatIdOverride) {
  const target = chatIdOverride || await linkedChat();
  if (!target) { log('summary skipped — no group linked yet'); return; }
  if (!sa) {
    await send(target, '⚠️ The logbook connection is not configured on the server yet (FIREBASE_SERVICE_ACCOUNT missing).');
    return;
  }
  try {
    const d = await dayData(eatKey());
    const week = await weekTotals();
    await send(target, buildSummary(d, week));
  } catch (e) { log('summary failed: ' + e.message); }
}

async function postReminder() {
  const target = await linkedChat();
  if (!target || !sa) { log('reminder skipped — not configured'); return; }
  try {
    const d = await dayData(eatKey());
    if (!isEmptyDay(d)) return; // something was recorded — stay quiet
    await send(target,
      '⏰ <b>Reminder:</b> nothing has been recorded at Napster Homes today.\n'
      + 'Please update the logbook before the day ends 🙏\n'
      + '<a href="' + SITE + '">Open the logbook</a>');
  } catch (e) { log('reminder failed: ' + e.message); }
}

// ─── Telegram long-polling (auto-link + commands) ───────────────────────────

let botUsername = '';
let offset = 0;
let polling = false;

async function handleUpdate(u) {
  try {
    if (u.my_chat_member) {
      const c = u.my_chat_member.chat || {};
      const st = u.my_chat_member.new_chat_member && u.my_chat_member.new_chat_member.status;
      if ((c.type === 'group' || c.type === 'supergroup')
        && (st === 'member' || st === 'administrator')) {
        await linkChat(c.id, c.title);
        await send(c.id, LINKED_MSG);
        log('linked to group "' + (c.title || c.id) + '" (added to group)');
      }
      return;
    }
    const m = u.message;
    if (!m || !m.chat) return;
    const c = m.chat;
    if (c.type !== 'group' && c.type !== 'supergroup') return;
    if (m.new_chat_members && botUsername
      && m.new_chat_members.some((x) => x.username === botUsername)) {
      await linkChat(c.id, c.title);
      await send(c.id, LINKED_MSG);
      return;
    }
    const text = String(m.text || '').trim().toLowerCase();
    if (text.startsWith('/link')) {
      await linkChat(c.id, c.title);
      await send(c.id, '✅ This group now receives the Napster Homes daily updates.');
    } else if (text.startsWith('/summary')) {
      await postSummary(c.id);
    } else if (text.startsWith('/id')) {
      await send(c.id, 'Chat id: <code>' + escapeHtml(c.id) + '</code>');
    }
  } catch (e) { log('update error: ' + e.message); }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const me = await axios.get(`${TG}/getMe`, { timeout: 15000 });
    botUsername = (me.data.result && me.data.result.username) || '';
  } catch (e) { /* not fatal */ }
  for (;;) {
    try {
      const r = await axios.get(`${TG}/getUpdates`, {
        params: {
          timeout: 25,
          offset,
          allowed_updates: JSON.stringify(['message', 'my_chat_member']),
        },
        timeout: 35000,
      });
      const updates = (r.data && r.data.result) || [];
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u);
      }
    } catch (e) {
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

function start() {
  if (!ENABLED) { log('disabled via NAPSTER_BOT_ENABLED=0'); return; }
  if (!TOKEN) { log('no Telegram token — skipping'); return; }
  poll();
  cron.schedule('0 20 * * *', postReminder, { timezone: EAT_TZ });
  cron.schedule('0 22 * * *', () => postSummary(null), { timezone: EAT_TZ });
  log('started — reminder 20:00, summary 22:00 (' + EAT_TZ + ')'
    + (sa ? '' : ' — FIREBASE_SERVICE_ACCOUNT missing, logbook reads disabled'));
}

module.exports = { start };
