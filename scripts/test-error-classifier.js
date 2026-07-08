/**
 * scripts/test-error-classifier.js
 *
 * OFFLINE tests for Services/errorClassifier.js using REAL error strings
 * captured from yt-dlp and the platform scrapers.
 *
 * Run: node scripts/test-error-classifier.js
 */

const { classify } = require('../Services/errorClassifier');

let pass = 0, fail = 0;
function expect(msg, expectedCode) {
  const c = classify(msg);
  if (c.code === expectedCode) { pass++; console.log(`  ✅ [${expectedCode}] "${msg.slice(0, 60)}…"`); }
  else { fail++; console.error(`  ❌ expected ${expectedCode}, got ${c.code} for "${msg.slice(0, 70)}"`); }
}

console.log('\n── Age restriction (real yt-dlp strings) ──');
expect('ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be inappropriate for some users.', 'AGE_RESTRICTED');
expect('yt-dlp(generic): This video is age-restricted and only available on YouTube', 'AGE_RESTRICTED');
expect('age_gate: content requires age verification', 'AGE_RESTRICTED');

console.log('\n── Geo blocking ──');
expect('ERROR: [youtube] abc: The uploader has not made this video available in your country', 'GEO_BLOCKED');
expect('yt-dlp(generic): Video unavailable. This content isn\u2019t available in your location', 'GEO_BLOCKED');
expect('This video is geo-restricted', 'GEO_BLOCKED');

console.log('\n── DRM ──');
expect('ERROR: This video is DRM protected', 'DRM_PROTECTED');
expect('yt-dlp: no suitable formats: widevine encrypted streams only', 'DRM_PROTECTED');

console.log('\n── Private ──');
expect('ERROR: [youtube] xyz: Private video. Sign in if you\u2019ve been granted access to this video', 'PRIVATE_CONTENT');
expect('Instagram: private account', 'PRIVATE_CONTENT');

console.log('\n── Login required ──');
expect('ig-story: cookie appears stale (auth rejected)', 'LOGIN_REQUIRED');
expect('yt-dlp(twitter): NSFW tweet requires authentication. Use --cookies', 'LOGIN_REQUIRED');
expect('Facebook Story: redirected to login (story not public)', 'LOGIN_REQUIRED');

console.log('\n── Not found ──');
expect('yt-dlp(generic): HTTP Error 404: Not Found', 'NOT_FOUND');
expect('Facebook content unavailable. The post may be deleted', 'NOT_FOUND');
expect('TikTok: video has been removed by the creator', 'NOT_FOUND');

console.log('\n── Rate limiting ──');
expect('yt-dlp(youtube): HTTP Error 429: Too Many Requests', 'RATE_LIMITED');

console.log('\n── Live ──');
expect('ERROR: [youtube] abc: This live event will begin in 3 hours. Premieres in 3 hours', 'LIVE_ONLY');
expect('TikTok Live streams cannot be downloaded \u2014 they\u2019re real-time-only and not stored.', 'LIVE_ONLY');

console.log('\n── Unsupported ──');
expect('yt-dlp(generic): ERROR: Unsupported URL: https://example.com/page', 'UNSUPPORTED_SITE');
expect('Generic: no usable formats extracted', 'UNSUPPORTED_SITE');
expect('yt-dlp(generic): Unable to extract video info', 'UNSUPPORTED_SITE');

console.log('\n── Timeout ──');
expect('Download timeout - operation took too long', 'TIMEOUT');
expect('igdl: timeout after 12000ms', 'TIMEOUT');

console.log('\n── Fallback ──');
expect('Something completely novel went wrong', 'DOWNLOAD_FAILED');

console.log('\n── Priority ordering: specific beats generic ──');
// Contains both "sign in" (LOGIN_REQUIRED) and age wording — must be AGE_RESTRICTED
expect('Sign in to confirm your age. This video may be inappropriate for some users.', 'AGE_RESTRICTED');
// Contains "unavailable" (NOT_FOUND) and country wording — must be GEO_BLOCKED
expect('Video unavailable in your country', 'GEO_BLOCKED');


console.log('\n\u2500\u2500 Bot detection \u2500\u2500');
expect("yt-dlp: ERROR: [youtube] z0NsVTJvJLo: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser", 'BOT_DETECTION');
expect("Sign in to confirm you're not a bot", 'BOT_DETECTION');
expect('unusual traffic from your computer network', 'BOT_DETECTION');
// Age variant must STILL classify as AGE_RESTRICTED (checked first)
expect('Sign in to confirm your age. This video may be inappropriate', 'AGE_RESTRICTED');

console.log(`\n\u2550\u2550\u2550 RESULT: ${pass} passed, ${fail} failed \u2550\u2550\u2550`);
process.exit(fail ? 1 : 0);
