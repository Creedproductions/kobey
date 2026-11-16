'use strict';

// Instagram's own logged-out web API (the same calls instagram.com makes for
// a signed-out visitor, and what yt-dlp master uses).
//
// Why this exists (2026-11): every other anonymous IG strategy died at once —
//   - igdl (btch-downloader) → backend1.tioo.eu.org hangs on /igdl, even
//     from a residential IP, on 2.8.4 AND the latest 6.x;
//   - the embed page is stripped to thumbnails for reels;
//   - the old graphql doc_id (8845758582119845) returns null;
//   - yt-dlp's page fallback hits the login wall from datacenter IPs.
//
// Flow (3 requests, ~1–2 s total, session reused for SESSION_TTL_MS):
//   1. GET https://www.instagram.com/     → LSD token + csrftoken/mid/ig_did/datr cookies
//   2. GET /api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=<pk>
//   3. POST /api/graphql  doc_id=27130156389949648
//        (PolarisLoggedOutDesktopWWWPostRootContentQuery, variables {media_id})
//      → data.xig_polaris_media.if_not_gated_logged_out
//
// Gotcha: the graphql POST returns the HTML shell (not JSON) unless the
// browser fetch metadata headers (Sec-Fetch-*) are present.

const axios = require('axios');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const APP_ID = '936619743392459';
const DOC_ID = process.env.IG_POLARIS_DOC_ID || '27130156389949648';
const FRIENDLY = 'PolarisLoggedOutDesktopWWWPostRootContentQuery';
const SESSION_TTL_MS = 10 * 60 * 1000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

let cachedSession = null; // { lsd, jar, at }

function shortcodeFromUrl(url) {
  const m = String(url || '').match(/instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// Shortcode → numeric media pk (IG's base64url alphabet). Private-post
// shortcodes carry 28 extra chars after the 11-char public id; only the
// first 11 encode the pk.
function shortcodeToPk(shortcode) {
  let pk = 0n;
  for (const c of String(shortcode).slice(0, 11)) {
    const idx = ALPHABET.indexOf(c);
    if (idx === -1) throw new Error('polaris: invalid shortcode character');
    pk = pk * 64n + BigInt(idx);
  }
  return pk.toString();
}

function absorbCookies(jar, headers) {
  const set = headers?.['set-cookie'];
  if (!Array.isArray(set)) return;
  for (const c of set) {
    const kv = String(c).split(';')[0];
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    const v = kv.slice(i + 1);
    if (!v || v === '""') continue;
    jar[kv.slice(0, i).trim()] = v;
  }
}

const cookieHeader = (jar) =>
  Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

function apiHeaders(jar) {
  return {
    'User-Agent':      UA,
    'X-IG-App-ID':     APP_ID,
    'X-ASBD-ID':       '359341',
    'X-IG-WWW-Claim':  '0',
    Origin:            'https://www.instagram.com',
    Accept:            '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Site':  'same-origin',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Dest':  'empty',
    Cookie:            cookieHeader(jar),
  };
}

async function newSession(timeoutMs) {
  const jar = {};
  const resp = await axios.get('https://www.instagram.com/', {
    timeout: timeoutMs,
    validateStatus: () => true,
    maxRedirects: 3,
    headers: {
      'User-Agent':      UA,
      Accept:            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest':  'document',
      'Sec-Fetch-Mode':  'navigate',
      'Sec-Fetch-Site':  'none',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  absorbCookies(jar, resp.headers);
  const html = typeof resp.data === 'string' ? resp.data : '';
  let lsd = (html.match(/\["LSD",\[\],\{"token":"([^"]+)"/) || [])[1];
  if (!lsd) {
    const m = html.match(/<script\b[^>]*\bid="__eqmc"[^>]*>(\{.*?\})<\/script>/);
    if (m) { try { lsd = JSON.parse(m[1]).l; } catch (_) { /* ignore */ } }
  }
  if (!lsd) throw new Error(`polaris: no LSD token on instagram.com (status ${resp.status})`);
  return { lsd, jar, at: Date.now() };
}

async function getSession(timeoutMs, fresh = false) {
  if (!fresh && cachedSession && Date.now() - cachedSession.at < SESSION_TTL_MS) {
    return cachedSession;
  }
  cachedSession = await newSession(timeoutMs);
  return cachedSession;
}

function bestImage(node) {
  const c = node?.image_versions2?.candidates;
  if (Array.isArray(c) && c.length) {
    const best = [...c].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return best?.url || '';
  }
  return node?.display_uri || node?.display_url || '';
}

function bestVideo(node) {
  const v = node?.video_versions;
  if (!Array.isArray(v) || !v.length) return '';
  const withSize = v.filter(x => x && x.url);
  // video_versions often lacks width/height in this response; IG lists the
  // best rendition first, so keep order unless sizes are present.
  if (withSize.some(x => x.width)) {
    withSize.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
  }
  return withSize[0]?.url || '';
}

function toItems(product) {
  const items = [];
  const push = (node) => {
    const thumb = bestImage(node);
    const vid = bestVideo(node);
    if (vid) {
      // video_versions are progressive MP4s with audio muxed in; the
      // controller's audio guard still ffprobes them.
      items.push({ url: vid, type: 'video', thumbnail: thumb });
    } else if (thumb) {
      items.push({ url: thumb, type: 'image', thumbnail: thumb });
    }
  };
  if (Array.isArray(product.carousel_media) && product.carousel_media.length) {
    product.carousel_media.forEach(push);
  } else {
    push(product);
  }
  return items;
}

async function graphqlOnce(session, shortcode, mediaId, timeoutMs) {
  // Ruling check — mirrors the browser; also refreshes csrftoken.
  try {
    const rul = await axios.get(
      `https://www.instagram.com/api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=${mediaId}`,
      { timeout: timeoutMs, validateStatus: () => true, headers: apiHeaders(session.jar) },
    );
    absorbCookies(session.jar, rul.headers);
    const r = rul.data && typeof rul.data === 'object' ? rul.data : {};
    const msg = [r.title, r.description].filter(Boolean).join(': ');
    if (/restricted/i.test(msg)) {
      throw Object.assign(new Error(`polaris: ${msg} — sign in required`), { fatal: true });
    }
  } catch (e) {
    if (e.fatal) throw e;
    // ruling is advisory; continue to graphql
  }

  const body = new URLSearchParams({
    lsd: session.lsd,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: FRIENDLY,
    server_timestamps: 'true',
    variables: JSON.stringify({ media_id: mediaId }),
    doc_id: DOC_ID,
  }).toString();

  const resp = await axios.post('https://www.instagram.com/api/graphql', body, {
    timeout: timeoutMs,
    validateStatus: () => true,
    headers: {
      ...apiHeaders(session.jar),
      'Content-Type':        'application/x-www-form-urlencoded',
      'X-FB-Friendly-Name':  FRIENDLY,
      'X-CSRFToken':         session.jar.csrftoken || '',
      'X-FB-LSD':            session.lsd,
      'X-Requested-With':    'XMLHttpRequest',
      Referer:               `https://www.instagram.com/p/${shortcode}/`,
    },
  });
  absorbCookies(session.jar, resp.headers);

  if (typeof resp.data !== 'object' || !resp.data) {
    return { retry: true, error: `polaris: non-JSON graphql response (status ${resp.status})` };
  }
  const media = resp.data?.data?.xig_polaris_media;
  const product = media?.if_not_gated_logged_out;
  if (!product) {
    return {
      retry: !media,
      error: media
        ? 'polaris: post is gated for logged-out viewers (private / 18+ / region)'
        : `polaris: empty xig_polaris_media (status ${resp.status})`,
    };
  }
  return { product };
}

/**
 * Resolve an Instagram post/reel URL to media items.
 * @returns {Promise<{items: Array<{url,type,thumbnail}>, title: string}>}
 */
async function fetchInstagramPolaris(url, { timeoutMs = 9000 } = {}) {
  const shortcode = shortcodeFromUrl(url);
  if (!shortcode) throw new Error('polaris: cannot extract shortcode');
  const mediaId = shortcodeToPk(shortcode);

  let session = await getSession(timeoutMs);
  let res = await graphqlOnce(session, shortcode, mediaId, timeoutMs);
  if (!res.product && res.retry) {
    // Stale/blocked session — mint a fresh one and try once more.
    session = await getSession(timeoutMs, true);
    res = await graphqlOnce(session, shortcode, mediaId, timeoutMs);
  }
  if (!res.product) {
    if (res.retry) cachedSession = null;
    throw new Error(res.error);
  }

  const items = toItems(res.product);
  if (!items.length) throw new Error('polaris: media had no usable URLs');
  const caption = String(res.product?.caption?.text || '').replace(/\s+/g, ' ').trim();
  return { items, title: caption.slice(0, 100) };
}

module.exports = {
  fetchInstagramPolaris,
  shortcodeFromUrl,
  shortcodeToPk,
  _toItems: toItems,
};
