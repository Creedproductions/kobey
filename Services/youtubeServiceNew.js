const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

class YouTubeService {
  constructor() {
    this.apiKey = process.env.YT_INNERTUBE_KEY || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this.baseUrl = 'https://youtubei.googleapis.com/youtubei/v1/player';

    this.cookiePathCandidates = [
      process.env.COOKIES_PATH,
      '/cookies.txt',
      '/app/cookies.txt',
      path.join(__dirname, '..', 'cookies.txt'),
      path.join(process.cwd(), 'cookies.txt'),
      'cookies.txt'
    ].filter(Boolean);
  }

  extractYouTubeId(url) {
    try {
      const u = new URL(url);

      // watch?v=
      const v = u.searchParams.get('v');
      if (v && v.length === 11) return v;

      // youtu.be/<id>
      if (u.hostname.includes('youtu.be')) {
        const id = u.pathname.split('/').filter(Boolean)[0];
        if (id && id.length === 11) return id;
      }

      // /shorts/<id> or /embed/<id>
      const parts = u.pathname.split('/').filter(Boolean);
      const shortsIndex = parts.indexOf('shorts');
      if (shortsIndex !== -1 && parts[shortsIndex + 1]?.length === 11) return parts[shortsIndex + 1];

      const embedIndex = parts.indexOf('embed');
      if (embedIndex !== -1 && parts[embedIndex + 1]?.length === 11) return parts[embedIndex + 1];

      // fallback regex
      const match = url.match(/([0-9A-Za-z_-]{11})/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  // Parse Netscape cookie file into a "Cookie: a=b; c=d" header
  readCookiesHeader() {
    let cookiePath = null;
    for (const p of this.cookiePathCandidates) {
      try {
        if (fs.existsSync(p)) { cookiePath = p; break; }
      } catch {}
    }
    if (!cookiePath) return null;

    const raw = fs.readFileSync(cookiePath, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));

    // Netscape format: domain \t flag \t path \t secure \t expiration \t name \t value
    const cookies = [];
    for (const line of raw) {
      const parts = line.split('\t');
      if (parts.length >= 7) {
        const name = parts[5];
        const value = parts[6];
        if (name && value) cookies.push(`${name}=${value}`);
      }
    }
    return cookies.length ? cookies.join('; ') : null;
  }

  // Try multiple clients because some videos/shorts fail on one client but work on another
  getClientProfiles() {
    return [
      {
        name: 'ANDROID',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.youtube/19.17.34 (Linux; U; Android 11)',
          'X-YouTube-Client-Name': '3',      // ANDROID
          'X-YouTube-Client-Version': '19.17.34'
        },
        bodyClient: { clientName: 'ANDROID', clientVersion: '19.17.34', hl: 'en', gl: 'US' }
      },
      {
        name: 'WEB',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'X-YouTube-Client-Name': '1',      // WEB
          'X-YouTube-Client-Version': '2.20230728.00.00'
        },
        bodyClient: { clientName: 'WEB', clientVersion: '2.20230728.00.00', hl: 'en', gl: 'US' }
      }
    ];
  }

  async callPlayer(videoId, profile) {
    const url = `${this.baseUrl}?key=${this.apiKey}`;

    const headers = { ...profile.headers };
    const cookieHeader = this.readCookiesHeader();
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const body = {
      context: { client: profile.bodyClient },
      videoId
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // node-fetch v2 uses "timeout"
      timeout: 35000
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { _raw: text }; }

    if (!res.ok) {
      const msg = `InnerTube HTTP ${res.status} (${profile.name})`;
      return { ok: false, error: msg, data: json };
    }

    return { ok: true, data: json };
  }

  parseFormats(data) {
    const out = [];
    const sd = data?.streamingData;
    if (!sd) return out;

    const list = [
      ...(Array.isArray(sd.formats) ? sd.formats : []),
      ...(Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats : [])
    ];

    // NOTE: if the response only has signatureCipher/cipher, you won't have a usable URL without deciphering.
    // We will keep only formats that have a direct URL so your app won't break.
    for (const f of list) {
      const hasUrl = !!f.url;
      const mime = f.mimeType || '';
      const hasVideo = mime.includes('video/');
      const hasAudio = mime.includes('audio/');
      const height = f.height || 0;

      out.push({
        itag: f.itag,
        mimeType: mime,
        qualityLabel: f.qualityLabel,
        quality: f.qualityLabel || f.quality || (height ? `${height}p` : 'unknown'),
        qualityNum: height,
        url: hasUrl ? f.url : null,
        contentLength: f.contentLength,
        bitrate: f.bitrate,
        fps: f.fps,
        audioQuality: f.audioQuality,
        audioBitrate: f.audioBitrate || f.bitrate,
        hasVideo,
        hasAudio,
        isAudioOnly: hasAudio && !hasVideo,
        isVideoOnly: hasVideo && !hasAudio
      });
    }

    return out;
  }

  buildResponse(videoId, data) {
    const vd = data?.videoDetails;
    const ps = data?.playabilityStatus;

    // Prefer YouTube reason messages
    if (!vd) {
      const reason = ps?.reason || ps?.status || 'Video not available or private';
      return {
        title: 'YouTube Video',
        thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        formats: [],
        videoFormats: [],
        audioFormats: [],
        url: null,
        selectedQuality: null,
        audioGuaranteed: false,
        videoId,
        error: reason,
        playabilityStatus: ps || null
      };
    }

    const all = this.parseFormats(data);

    // Only formats with direct URLs (no cipher)
    const usable = all.filter(f => !!f.url);

    const combined = usable.filter(f => f.hasVideo && f.hasAudio);
    const audioOnly = usable.filter(f => f.isAudioOnly);
    const videoOnly = usable.filter(f => f.isVideoOnly);

    // Choose best audio for merge
    const bestAudio =
        audioOnly.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] || null;

    const organized = [];

    // Combined first (direct play)
    for (const f of combined) {
      organized.push({
        itag: f.itag,
        quality: f.quality,
        qualityNum: f.qualityNum,
        url: f.url,
        type: 'video/mp4',
        extension: 'mp4',
        isPremium: (f.qualityNum || 0) > 360,
        hasAudio: true,
        hasVideo: true,
        needsMerging: false,
        mimeType: f.mimeType,
        contentLength: f.contentLength,
        bitrate: f.bitrate
      });
    }

    // Video-only (needs merge) — only if we have bestAudio
    if (bestAudio) {
      for (const f of videoOnly.filter(v => (v.qualityNum || 0) >= 480)) {
        organized.push({
          itag: f.itag,
          quality: f.quality,
          qualityNum: f.qualityNum,
          url: f.url,
          videoUrl: f.url,
          audioUrl: bestAudio.url,
          type: 'video/mp4',
          extension: 'mp4',
          isPremium: true,
          hasAudio: false,
          hasVideo: true,
          needsMerging: true,
          mimeType: f.mimeType,
          contentLength: f.contentLength,
          bitrate: f.bitrate
        });
      }
    }

    organized.sort((a, b) => (a.qualityNum || 0) - (b.qualityNum || 0));

    const audioFormats = audioOnly.map(f => ({
      itag: f.itag,
      quality: `${f.audioQuality || 'audio'} (${Math.round((f.bitrate || 0) / 1000)}kb/s)`,
      url: f.url,
      type: 'audio/mp4',
      extension: 'm4a',
      isPremium: (f.bitrate || 0) > 150000,
      isAudioOnly: true,
      hasAudio: true,
      hasVideo: false,
      mimeType: f.mimeType,
      bitrate: f.bitrate
    }));

    // Default: prefer 360p combined
    const default360 = organized.find(x => x.qualityNum === 360 && x.hasAudio && !x.needsMerging);
    const selected = default360 || organized[0] || null;

    return {
      title: vd.title || 'YouTube Video',
      thumbnail: vd.thumbnail?.thumbnails?.slice(-1)?.[0]?.url
          || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: vd.lengthSeconds || 0,
      description: vd.shortDescription || '',
      author: vd.author || '',
      viewCount: vd.viewCount || 0,
      formats: organized,
      allFormats: organized,
      videoFormats: organized.filter(f => !f.isAudioOnly),
      audioFormats,
      url: selected?.url || null,
      selectedQuality: selected,
      audioGuaranteed: usable.length > 0,
      videoId,
      playabilityStatus: ps || null
    };
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) throw new Error('Invalid YouTube URL');

    // Try multiple client profiles
    const profiles = this.getClientProfiles();

    let lastError = null;
    let bestData = null;

    for (const p of profiles) {
      const r = await this.callPlayer(videoId, p);

      if (!r.ok) {
        lastError = r.error;
        continue;
      }

      const ps = r.data?.playabilityStatus;
      const vd = r.data?.videoDetails;

      // Accept OK responses
      if (vd) {
        bestData = r.data;
        break;
      }

      // Keep the most informative failure
      const reason = ps?.reason || ps?.status || 'Video not available or private';
      lastError = `${reason} (${p.name})`;
      bestData = r.data; // keep playabilityStatus for debugging
    }

    // Build a stable response regardless
    if (!bestData) {
      return {
        title: 'YouTube Video',
        thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        formats: [],
        videoFormats: [],
        audioFormats: [],
        url: null,
        selectedQuality: null,
        audioGuaranteed: false,
        videoId,
        error: lastError || 'Video not available or private'
      };
    }

    const response = this.buildResponse(videoId, bestData);

    // If videoDetails missing, return error response but DO NOT throw
    return response;
  }

  // optional: used by your /api/test-cookies endpoint
  async testCookies() {
    const cookieHeader = this.readCookiesHeader();
    if (!cookieHeader) {
      return { success: false, message: 'No cookies header parsed from cookies.txt' };
    }
    return {
      success: true,
      message: 'Cookies parsed OK',
      cookieLength: cookieHeader.length
    };
  }
}

const youtubeService = new YouTubeService();

async function fetchYouTubeData(url) {
  return youtubeService.fetchYouTubeData(url);
}

module.exports = {
  fetchYouTubeData,
  youtubeService
};
