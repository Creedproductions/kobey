/**
 * scripts/test-stories-live.js
 *
 * LIVE smoke test for story + media downloading across platforms.
 * Must run somewhere with open network access (Koyeb shell, local dev,
 * or `node scripts/test-stories-live.js` on the deployed instance).
 *
 * Usage:
 *   node scripts/test-stories-live.js                       # mirror health only
 *   node scripts/test-stories-live.js <ig-story-url> ...    # + full pipeline runs
 *
 * Story URLs expire in 24h so they can't be hard-coded — pass fresh ones
 * from PUBLIC profiles as arguments. Good sources: any large public
 * creator currently showing a story ring.
 */

const axios = require('axios');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let pass = 0, fail = 0, warn = 0;
const ok   = (m) => { pass++; console.log(`  ✅ ${m}`); };
const bad  = (m) => { fail++; console.error(`  ❌ ${m}`); };
const meh  = (m) => { warn++; console.warn(`  ⚠️  ${m}`); };

// ── 1. Mirror health: are the story-mirror hosts alive from this network? ──
async function mirrorHealth() {
  console.log('\n── Story-mirror reachability ──');
  const hosts = [
    ['storiesig.info',  'https://storiesig.info/'],
    ['storiessig.com',  'https://storiessig.com/'],
    ['anonyig.com',     'https://anonyig.com/'],
    ['imginn.com',      'https://imginn.com/'],
    ['fbdownloader.net','https://fbdownloader.net/en'],
    ['fdown.net',       'https://fdown.net/'],
    ['tikwm.com',       'https://tikwm.com/'],
  ];
  for (const [name, url] of hosts) {
    try {
      const r = await axios.get(url, {
        timeout: 12000, headers: { 'User-Agent': UA }, validateStatus: () => true,
        maxRedirects: 5,
      });
      if (r.status < 500) ok(`${name} reachable (HTTP ${r.status})`);
      else meh(`${name} responded HTTP ${r.status} — may be degraded`);
    } catch (e) {
      bad(`${name} unreachable: ${e.message}`);
    }
  }
}

// ── 2. storiesig.info 2-step API against a known-public account ──────────
async function storiesigApi() {
  console.log('\n── storiesig.info API shape check ──');
  // instagram's own account is always public and almost always has stories
  const username = process.env.TEST_IG_USER || 'instagram';
  try {
    const u = await axios.get(
      `https://storiesig.info/api/userinfo/?username=${username}`,
      { timeout: 12000, validateStatus: () => true, headers: {
        'User-Agent': UA, Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://storiesig.info', Referer: `https://storiesig.info/en/${username}`,
      }},
    );
    const userId = u.data?.result?.user?.pk || u.data?.result?.user?.id ||
                   u.data?.user?.pk || u.data?.id;
    if (userId) ok(`userinfo returns id for @${username} (${String(userId).slice(0,8)}…)`);
    else { bad(`userinfo shape changed — keys: ${JSON.stringify(Object.keys(u.data || {}))}`); return; }

    const s = await axios.get(
      `https://storiesig.info/api/stories/?id=${userId}`,
      { timeout: 15000, validateStatus: () => true, headers: {
        'User-Agent': UA, Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://storiesig.info', Referer: `https://storiesig.info/en/${username}`,
      }},
    );
    const stories = s.data?.result || s.data?.data || s.data?.stories || s.data?.items || [];
    if (Array.isArray(stories) && stories.length) ok(`stories endpoint returned ${stories.length} item(s)`);
    else meh(`stories endpoint returned 0 items for @${username} — account may simply have no active story right now`);
  } catch (e) {
    bad(`storiesig API check failed: ${e.message}`);
  }
}

// ── 3. Full pipeline runs on user-supplied URLs ───────────────────────────
async function pipelineRuns(urls) {
  if (!urls.length) {
    console.log('\n── Pipeline runs skipped (no URLs given) ──');
    console.log('   Pass fresh public story/post URLs as arguments for end-to-end proof:');
    console.log('   node scripts/test-stories-live.js "https://www.instagram.com/stories/<user>/<pk>/"');
    return;
  }
  console.log('\n── Full pipeline runs ──');
  const facebookInsta      = require('../Services/facebookInstaService');
  const { downloadTikTok } = require('../Services/tiktokService');

  for (const url of urls) {
    console.log(`\n▶ ${url}`);
    try {
      let result;
      if (/tiktok\.com/i.test(url)) {
        result = await downloadTikTok(url);
        const has = (result.video && result.video.length) || (result.images && result.images.length);
        has ? ok('TikTok pipeline returned media') : bad('TikTok pipeline returned no media');
      } else {
        result = await facebookInsta(url, {});
        const items = result?.data || [];
        const summary = Array.isArray(items)
          ? `${items.length} item(s), types: ${items.map(i => i.type).join(',')}`
          : `hd=${!!result.hd} sd=${!!result.sd}`;
        (Array.isArray(items) ? items.length : (result.hd || result.sd))
          ? ok(`pipeline ✓ via ${result._source || 'fb'} — ${summary}`)
          : bad('pipeline returned empty result');
      }
    } catch (e) {
      bad(`pipeline threw: ${e.message.slice(0, 200)}`);
    }
  }
}

(async () => {
  await mirrorHealth();
  await storiesigApi();
  await pipelineRuns(process.argv.slice(2));
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed, ${warn} warnings ═══`);
  process.exit(fail ? 1 : 0);
})();
