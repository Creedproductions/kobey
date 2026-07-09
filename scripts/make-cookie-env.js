#!/usr/bin/env node
/**
 * scripts/make-cookie-env.js
 *
 * Turns a raw session-cookie string into the base64 value you paste into
 * Koyeb as IG_SESSION_COOKIE_B64 (or FB_SESSION_COOKIE_B64). Run it LOCALLY —
 * never commit the output.
 *
 * Usage:
 *   node scripts/make-cookie-env.js 'sessionid=abc; csrftoken=def; ds_user_id=123'
 *
 * Or pipe it (avoids the cookie showing in your shell history):
 *   pbpaste | node scripts/make-cookie-env.js          # macOS
 *   node scripts/make-cookie-env.js < cookie.txt        # from a file
 *
 * Then in Koyeb → Environment:
 *   IG_SESSION_COOKIE_B64 = <the printed value>
 *
 * How to get the raw cookie:
 *   1. Log into instagram.com in a desktop browser with a THROWAWAY account
 *      (adult, if you want age-gated reels to work too).
 *   2. DevTools → Application → Cookies → https://www.instagram.com
 *   3. Copy the values of at least: sessionid, csrftoken, ds_user_id
 *   4. Format as "sessionid=...; csrftoken=...; ds_user_id=..."
 */

function readInput() {
  const arg = process.argv.slice(2).join(' ').trim();
  if (arg) return Promise.resolve(arg);
  // Read from stdin
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

(async () => {
  const raw = await readInput();
  if (!raw) {
    console.error('No cookie provided. Pass it as an argument or pipe it via stdin.');
    process.exit(1);
  }
  if (!/sessionid=/.test(raw)) {
    console.error('⚠️  Warning: no "sessionid=" found — this cookie will not authenticate.');
  }
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  console.log('\nPaste this into Koyeb as IG_SESSION_COOKIE_B64 (or FB_SESSION_COOKIE_B64):\n');
  console.log(b64);
  console.log(`\n(${raw.length} chars raw → ${b64.length} chars base64)\n`);
})();
