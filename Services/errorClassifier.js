// Services/errorClassifier.js
//
// Maps raw scraper / yt-dlp error strings to structured, user-facing error
// codes. Before this existed, an age-restricted YouTube video and a deleted
// TikTok both surfaced as "Failed to download media" + a wall of stderr —
// users had no idea whether retrying, signing in, or giving up was the
// right move. The Flutter client can switch on `code` to show the right
// UI (e.g. a sign-in prompt for LOGIN_REQUIRED, nothing for NOT_FOUND).
//
// classify() checks patterns in priority order — the FIRST match wins, so
// more specific conditions (age restriction, DRM) sit above generic ones
// (login required, unavailable).

const CLASSES = [
  {
    code: 'AGE_RESTRICTED',
    status: 451,
    patterns: [
      /sign in to confirm your age/i,
      /age.?restricted/i,
      /age.?gate/i,
      /confirm your age/i,
      /inappropriate for some users/i,
      /viewer discretion/i,
      /18\+ content/i,
      /adult content.*(login|sign|account)/i,
    ],
    userMessage:
      'This content is age-restricted. The platform requires a signed-in, ' +
      'age-verified account to access it.',
    suggestions: [
      'Age-restricted content usually needs a signed-in session — if the app supports sign-in for this platform, try that',
      'Some age-restricted videos are still blocked even when signed in, depending on the platform',
    ],
    retryable: false,
  },
  {
    code: 'DRM_PROTECTED',
    status: 403,
    patterns: [
      /\bdrm\b/i,
      /this video is drm protected/i,
      /widevine|fairplay|playready/i,
      /protected by.*encryption/i,
    ],
    userMessage:
      'This content is DRM-protected and cannot be downloaded by any tool.',
    suggestions: ['DRM-protected content (streaming services, purchases) cannot be downloaded'],
    retryable: false,
  },
  {
    code: 'GEO_BLOCKED',
    status: 451,
    patterns: [
      /not available in your (country|region|location)/i,
      /geo.?(restrict|block|locked)/i,
      /unavailable in your country/i,
      /content isn['\u2019]?t available in/i,
      /video is not available.*country/i,
      /uploader has not made this video available in your country/i,
    ],
    userMessage:
      'This content is region-locked and not available from the server\'s location.',
    suggestions: ['The uploader restricted this content to specific countries'],
    retryable: false,
  },
  {
    code: 'PRIVATE_CONTENT',
    status: 403,
    patterns: [
      /private (video|account|profile|post|content)/i,
      /this (video|post|account) is private/i,
      /only.*followers can/i,
      /friends.?only/i,
    ],
    userMessage: 'This content is private — only approved followers can view it.',
    suggestions: ['Private content cannot be downloaded, even with a signed-in session, unless that account follows the creator'],
    retryable: false,
  },
  {
    code: 'BOT_DETECTION',
    status: 429,
    patterns: [
      /confirm you.?re not a bot/i,
      /sign in to confirm/i, // note: the age variant is caught by AGE_RESTRICTED above
      /bot.?(check|detection|verification)/i,
      /suspicious (activity|traffic)/i,
      /unusual traffic/i,
      /captcha/i,
    ],
    userMessage:
      'The platform is temporarily blocking automated access from our server. ' +
      'This usually clears within minutes.',
    suggestions: ['Try again in a few minutes — the platform rotates these blocks frequently'],
    retryable: true,
  },
  {
    code: 'LOGIN_REQUIRED',
    status: 401,
    patterns: [
      /login.?required/i,
      /login_required/i,
      /requires? (a )?(login|sign.?in|authentication|account)/i,
      /sign in to (view|watch|continue)/i,
      /redirected to login/i,
      /authentication required/i,
      /cookie (appears stale|rejected)/i,
      /use --cookies/i,
      /account.*required to (view|access)/i,
    ],
    userMessage: 'This content requires a signed-in session to access.',
    suggestions: ['Sign in to the platform in the in-app browser to enable this download'],
    retryable: false,
  },
  {
    code: 'NOT_FOUND',
    status: 404,
    patterns: [
      /http (error )?404/i,
      /\b404\b/,
      /http (error )?410/i,
      /(video|post|content|page|tweet).*(removed|deleted|does not exist|doesn'?t exist|no longer available)/i,
      /has been removed/i,
      /content unavailable/i,
      /is unavailable/i,
      /not found/i,
      /unable to find/i,
    ],
    userMessage: 'This content was deleted, expired, or the link is wrong.',
    suggestions: ['Double-check the link — the post may have been removed by the uploader or the platform'],
    retryable: false,
  },
  {
    code: 'RATE_LIMITED',
    status: 429,
    patterns: [
      /http (error )?429/i,
      /too many requests/i,
      /rate.?limit/i,
      /try again later/i,
      /temporarily blocked/i,
    ],
    userMessage: 'The platform is rate-limiting requests right now.',
    suggestions: ['Wait a minute and try again — this is temporary'],
    retryable: true,
  },
  {
    code: 'LIVE_ONLY',
    status: 422,
    patterns: [
      /live stream/i,
      /is a live/i,
      /premieres in/i,
      /this live event/i,
      /real.?time.?only/i,
    ],
    userMessage: 'Live streams and premieres cannot be downloaded until they end.',
    suggestions: ['Try again after the stream/premiere has ended and the replay is available'],
    retryable: false,
  },
  {
    code: 'UNSUPPORTED_SITE',
    status: 422,
    patterns: [
      /unsupported url/i,
      /no video formats/i,
      /no usable formats/i,
      /unable to extract/i,
      /no media found/i,
      /generic: no usable formats/i,
    ],
    userMessage:
      'No downloadable media was found at this link. The site may not be ' +
      'supported, or the page may not contain a direct video.',
    suggestions: [
      'Make sure the link points to a specific video/post page, not a homepage or search page',
      'Some sites use streaming protection that prevents downloading',
    ],
    retryable: false,
  },
  {
    code: 'TIMEOUT',
    status: 408,
    patterns: [
      /timeout/i,
      /timed out/i,
      /took too long/i,
      /etimedout/i,
      /econnreset/i,
      /socket hang up/i,
    ],
    userMessage: 'The download source is responding slowly right now.',
    suggestions: ['Try again — this is usually temporary'],
    retryable: true,
  },
];

/**
 * Classify a raw error message.
 * @param {string|Error} err
 * @returns {{code, status, userMessage, suggestions, retryable, raw}}
 */
function classify(err) {
  const raw = String((err && err.message) || err || '');
  for (const c of CLASSES) {
    if (c.patterns.some(re => re.test(raw))) {
      return {
        code: c.code,
        status: c.status,
        userMessage: c.userMessage,
        suggestions: c.suggestions,
        retryable: c.retryable,
        raw,
      };
    }
  }
  return {
    code: 'DOWNLOAD_FAILED',
    status: 500,
    userMessage: 'Failed to download media from this link.',
    suggestions: ['Try again — if it keeps failing, the source may be blocking downloads'],
    retryable: true,
    raw,
  };
}

/** True when the message indicates an age-gate (used for targeted retries). */
function isAgeRestricted(err) {
  return classify(err).code === 'AGE_RESTRICTED';
}

module.exports = { classify, isAgeRestricted };
