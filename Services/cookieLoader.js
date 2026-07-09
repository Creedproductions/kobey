// Services/cookieLoader.js
//
// Loads platform session cookies from env at boot. Supports two forms per
// platform so you never have to paste a raw cookie string into Koyeb's UI
// (where it can end up in logs / screenshots):
//
//   IG_SESSION_COOKIE       — raw "sessionid=...; csrftoken=...; ds_user_id=..."
//   IG_SESSION_COOKIE_B64   — base64 of the same string (preferred)
//
//   FB_SESSION_COOKIE       — raw
//   FB_SESSION_COOKIE_B64   — base64 (preferred)
//
// The base64 form keeps the cookie opaque in the dashboard and avoids the
// semicolons/quotes that sometimes get mangled by env parsers. This module
// decodes it once at boot and re-exports a normalized value the rest of the
// code already reads (process.env.IG_SESSION_COOKIE / FB_SESSION_COOKIE).
//
// It NEVER logs the cookie value — only whether one is present and its
// length, so you can confirm it loaded without leaking it.

function loadOne(rawKey, b64Key, label) {
  let value = (process.env[rawKey] || '').trim();

  if (!value && process.env[b64Key]) {
    try {
      value = Buffer.from(process.env[b64Key].trim(), 'base64').toString('utf8').trim();
      // Write it back so existing code that reads the raw key just works.
      process.env[rawKey] = value;
    } catch (e) {
      console.warn(`🍪 ${label}: ${b64Key} set but failed to decode — ${e.message}`);
    }
  }

  if (value) {
    const hasSession = /sessionid=/.test(value);
    console.log(
      `🍪 ${label}: loaded (${value.length} chars, sessionid ${hasSession ? 'present' : 'MISSING'})`
    );
    if (!hasSession) {
      console.warn(`🍪 ${label}: WARNING — no sessionid= found; this cookie won't authenticate`);
    }
  } else {
    console.log(`🍪 ${label}: not set`);
  }
  return value;
}

function loadCookies() {
  return {
    instagram: loadOne('IG_SESSION_COOKIE', 'IG_SESSION_COOKIE_B64', 'IG cookie'),
    facebook:  loadOne('FB_SESSION_COOKIE', 'FB_SESSION_COOKIE_B64', 'FB cookie'),
  };
}

module.exports = { loadCookies };
