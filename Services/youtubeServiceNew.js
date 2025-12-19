'use strict';

const fetch = require('node-fetch');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL, URLSearchParams } = require('url');

class YouTubeService {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.YOUTUBEI_API_KEY || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this.baseUrl = options.baseUrl || 'https://youtubei.googleapis.com/youtubei/v1/player';
    this.tempDir = path.join(os.tmpdir(), 'yt-merge');

    this.defaultTimeoutMs = Number(options.timeoutMs || 30000);
    this.maxAttemptsPerClient = Number(options.maxAttemptsPerClient || 2);
    this.cacheTtlMs = Number(options.cacheTtlMs || 3 * 60 * 1000); // 3 minutes
    this.enableCache = options.enableCache !== false;
    this.allowMerge = options.allowMerge === true; // set true if you want to merge with ffmpeg

    this._cache = new Map(); // videoId -> { expiresAt, value }

    if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
  }

  // -------------------------
  // URL + ID handling
  // -------------------------
  normalizeYouTubeUrl(input) {
    try {
      const raw = input.trim();

      // If user gives only ID
      if (/^[0-9A-Za-z_-]{11}$/.test(raw)) {
        return `https://www.youtube.com/watch?v=${raw}`;
      }

      const u = new URL(raw);

      // youtu.be/<id>
      if (u.hostname.includes('youtu.be')) {
        const id = u.pathname.replace('/', '').split(/[?&/#]/)[0];
        if (id && id.length === 11) return `https://www.youtube.com/watch?v=${id}`;
      }

      // /shorts/<id>
      if (u.pathname.startsWith('/shorts/')) {
        const id = u.pathname.split('/shorts/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return `https://www.youtube.com/watch?v=${id}`;
      }

      // /embed/<id>
      if (u.pathname.startsWith('/embed/')) {
        const id = u.pathname.split('/embed/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return `https://www.youtube.com/watch?v=${id}`;
      }

      // watch?v=<id>
      const v = u.searchParams.get('v');
      if (v && v.length === 11) return `https://www.youtube.com/watch?v=${v}`;

      return raw;
    } catch {
      return input;
    }
  }

  extractYouTubeId(url) {
    const cleaned = this.normalizeYouTubeUrl(url);

    // cleaned watch url
    try {
      const u = new URL(cleaned);
      const v = u.searchParams.get('v');
      if (v && v.length === 11) return v;
    } catch {}

    // fallback regex
    const m = cleaned.match(/([0-9A-Za-z_-]{11})/);
    return m ? m[1] : null;
  }

  // -------------------------
  // Low-level helpers
  // -------------------------
  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  _jitter(base) {
    // 0.75x .. 1.25x
    const f = 0.75 + Math.random() * 0.5;
    return Math.floor(base * f);
  }

  _cacheGet(videoId) {
    if (!this.enableCache) return null;
    const hit = this._cache.get(videoId);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this._cache.delete(videoId);
      return null;
    }
    return hit.value;
  }

  _cacheSet(videoId, value) {
    if (!this.enableCache) return;
    this._cache.set(videoId, { value, expiresAt: Date.now() + this.cacheTtlMs });
  }

  async _fetchJsonWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();

      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}

      return { ok: res.ok, status: res.status, json, text };
    } finally {
      clearTimeout(id);
    }
  }

  // -------------------------
  // YouTubei Player request
  // -------------------------
  _clientProfiles() {
    // Use stable-ish client versions; if one gets flaky, others may still work
    return [
      { name: 'WEB', clientName: 'WEB', clientVersion: '2.20241201.01.00', hl: 'en', gl: 'US' },
      { name: 'ANDROID', clientName: 'ANDROID', clientVersion: '19.09.36', hl: 'en', gl: 'US' },
      { name: 'IOS', clientName: 'IOS', clientVersion: '19.09.3', hl: 'en', gl: 'US' },
    ];
  }

  _buildHeaders(clientName, clientVersion) {
    // youtubei.googleapis.com does not require X-YouTube headers,
    // but keeping User-Agent + language helps consistency.
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-YouTube-Client-Name': clientName,
      'X-YouTube-Client-Version': clientVersion,
    };
  }

  _buildBody(videoId, client) {
    return {
      context: {
        client: {
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          hl: client.hl,
          gl: client.gl,
        },
      },
      videoId,
      // These sometimes reduce “private/unavailable” false positives
      contentCheckOk: true,
      racyCheckOk: true,
    };
  }

  _readPlayability(data) {
    const ps = data?.playabilityStatus;
    const status = ps?.status || 'UNKNOWN';
    const reason =
        ps?.reason ||
        ps?.errorScreen?.playerErrorMessageRenderer?.reason?.simpleText ||
        null;

    return { status, reason, ps };
  }

  async getVideoInfo(videoId) {
    const cached = this._cacheGet(videoId);
    if (cached) return cached;

    const endpoint = `${this.baseUrl}?key=${this.apiKey}`;

    let lastErr = null;
    let lastData = null;

    const clients = this._clientProfiles();

    for (const client of clients) {
      for (let attempt = 1; attempt <= this.maxAttemptsPerClient; attempt++) {
        try {
          const headers = this._buildHeaders(client.clientName, client.clientVersion);
          const body = this._buildBody(videoId, client);

          const r = await this._fetchJsonWithTimeout(
              endpoint,
              { method: 'POST', headers, body: JSON.stringify(body) },
              this.defaultTimeoutMs
          );

          if (!r.ok || !r.json) {
            lastErr = new Error(`${client.name} HTTP ${r.status}`);
            // backoff
            await this._sleep(this._jitter(400 * attempt));
            continue;
          }

          const data = r.json;
          lastData = data;

          const { status, reason } = this._readPlayability(data);

          // If clearly not playable, no need to keep trying other clients forever
          if (status && status !== 'OK') {
            // Sometimes retry helps for transient throttling, so only break on strong statuses
            const hardStatuses = new Set(['LOGIN_REQUIRED', 'ERROR', 'UNPLAYABLE']);
            if (hardStatuses.has(status)) {
              const msg = reason || `Playability: ${status}`;
              throw new Error(msg);
            }
          }

          // success-ish
          this._cacheSet(videoId, data);
          return data;
        } catch (e) {
          lastErr = e;
          // retry with backoff
          await this._sleep(this._jitter(600 * attempt));
          continue;
        }
      }
    }

    // If we got some response but couldn’t use it, include playability details
    if (lastData) {
      const { status, reason } = this._readPlayability(lastData);
      const msg = reason || `Playability: ${status}`;
      throw new Error(msg);
    }

    throw lastErr || new Error('YouTube request failed');
  }

  // -------------------------
  // Format parsing
  // -------------------------
  _parseSignatureCipher(sigCipher) {
    // signatureCipher is a querystring: url=...&sp=signature&s=....
    // Without deciphering "s", you cannot use it reliably.
    // But sometimes it contains "sig" or "signature" already.
    try {
      const params = new URLSearchParams(sigCipher);
      const url = params.get('url');
      const sp = params.get('sp') || 'signature';
      const sig = params.get('sig') || params.get('signature');
      const s = params.get('s');

      if (!url) return { url: null, ciphered: true };

      // If we have already-signed value, attach it.
      if (sig) {
        const u = new URL(url);
        u.searchParams.set(sp, sig);
        return { url: u.toString(), ciphered: false };
      }

      // If only "s" exists, it needs decipher -> not usable here
      if (s) {
        return { url: null, ciphered: true };
      }

      // Sometimes url itself is already valid
      return { url, ciphered: false };
    } catch {
      return { url: null, ciphered: true };
    }
  }

  parseFormats(data) {
    const out = [];

    const sd = data?.streamingData;
    if (!sd) return out;

    const add = (arr, bucket) => {
      if (!Array.isArray(arr)) return;
      for (const f of arr) {
        const mime = f.mimeType || '';
        const hasVideo = mime.includes('video/');
        const hasAudio = mime.includes('audio/');
        const qualityLabel = f.qualityLabel || f.quality || null;

        let directUrl = f.url || null;
        let ciphered = false;

        if (!directUrl && f.signatureCipher) {
          const parsed = this._parseSignatureCipher(f.signatureCipher);
          directUrl = parsed.url;
          ciphered = parsed.ciphered;
        }

        out.push({
          bucket, // "formats" or "adaptiveFormats"
          itag: f.itag,
          mimeType: mime,
          qualityLabel,
          quality: qualityLabel || (hasAudio && !hasVideo ? 'audio' : 'unknown'),
          width: f.width,
          height: f.height || 0,
          fps: f.fps,
          bitrate: f.bitrate,
          audioQuality: f.audioQuality,
          contentLength: f.contentLength,
          hasVideo,
          hasAudio,
          isAudioOnly: hasAudio && !hasVideo,
          isVideoOnly: hasVideo && !hasAudio,
          url: directUrl,
          ciphered,
        });
      }
    };

    add(sd.formats, 'formats'); // muxed/progressive (usually)
    add(sd.adaptiveFormats, 'adaptiveFormats'); // separate

    return out;
  }

  // -------------------------
  // Optional merge (you can keep it off)
  // -------------------------
  async mergeVideoAudio(videoUrl, audioUrl, outputPath) {
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-i', videoUrl,
        '-i', audioUrl,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-y',
        outputPath
      ];

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);

      let stderr = '';
      ffmpeg.stderr.on('data', (d) => (stderr += d.toString()));

      ffmpeg.on('close', (code) => {
        if (code === 0) resolve(true);
        else reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(0, 500)}`));
      });

      ffmpeg.on('error', reject);
    });
  }

  // -------------------------
  // High-level API
  // -------------------------
  async fetchYouTubeData(inputUrl) {
    const normalizedUrl = this.normalizeYouTubeUrl(inputUrl);
    const videoId = this.extractYouTubeId(normalizedUrl);

    if (!videoId) {
      return this._errorPayload(null, 'Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    try {
      const info = await this.getVideoInfo(videoId);

      const { status, reason } = this._readPlayability(info);
      if (status && status !== 'OK') {
        // fail fast (don’t return "success" with empty formats)
        throw new Error(reason || `Video not playable: ${status}`);
      }

      const details = info.videoDetails;
      if (!details?.title) {
        // Some error screens still include partial JSON
        throw new Error('Video details missing (unavailable/private/blocked)');
      }

      const all = this.parseFormats(info);

      // Keep only usable URLs (not ciphered/no-url)
      const usable = all.filter(f => !!f.url && !f.ciphered);

      const muxed = usable.filter(f => f.hasVideo && f.hasAudio && f.bucket === 'formats');
      const videoOnly = usable.filter(f => f.isVideoOnly);
      const audioOnly = usable.filter(f => f.isAudioOnly);

      console.log(`✅ Found ${all.length} total formats (usable: ${usable.length})`);
      console.log(`🎬 Muxed (video+audio): ${muxed.length}`);
      console.log(`📹 Video-only: ${videoOnly.length}`);
      console.log(`🎵 Audio-only: ${audioOnly.length}`);

      // Pick best audio (highest bitrate)
      audioOnly.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const bestAudio = audioOnly[0] || null;

      // Build quality map (prefer muxed for same height)
      const qualityMap = new Map();

      const put = (f, meta) => {
        const h = f.height || 0;
        if (!qualityMap.has(h)) qualityMap.set(h, meta);
        else {
          const cur = qualityMap.get(h);
          // Prefer muxed over non-muxed
          if (cur.needsMerging && !meta.needsMerging) qualityMap.set(h, meta);
        }
      };

      // 1) Add muxed
      for (const f of muxed) {
        put(f, {
          itag: f.itag,
          quality: f.qualityLabel || `${f.height || 0}p`,
          qualityNum: f.height || 0,
          url: f.url,
          hasAudio: true,
          hasVideo: true,
          needsMerging: false,
          extension: 'mp4',
          type: 'video/mp4',
          mimeType: f.mimeType,
          bitrate: f.bitrate,
          contentLength: f.contentLength,
        });
      }

      // 2) Add video-only as “merge option” (if allowed) OR as separate download
      // Sort highest first so user sees better qualities
      videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0));

      for (const f of videoOnly) {
        const h = f.height || 0;
        if (!qualityMap.has(h)) {
          put(f, {
            itag: f.itag,
            quality: f.qualityLabel || `${h}p`,
            qualityNum: h,
            url: f.url, // NOTE: this is video-only url
            videoUrl: f.url,
            audioUrl: bestAudio?.url || null,
            hasAudio: false,
            hasVideo: true,
            needsMerging: this.allowMerge && !!bestAudio?.url, // only true if we can merge
            extension: 'mp4',
            type: 'video/mp4',
            mimeType: f.mimeType,
            bitrate: f.bitrate,
            contentLength: f.contentLength,
          });
        }
      }

      // Final organized formats (low->high)
      const formats = Array.from(qualityMap.values()).sort((a, b) => (a.qualityNum || 0) - (b.qualityNum || 0));

      // Audio-only list
      const audioFormats = audioOnly.map(a => ({
        itag: a.itag,
        quality: `audio (${Math.round((a.bitrate || 0) / 1000)}kb/s)`,
        url: a.url,
        type: 'audio/mp4',
        extension: 'm4a',
        hasAudio: true,
        hasVideo: false,
        bitrate: a.bitrate,
        mimeType: a.mimeType,
      }));

      // Default URL selection:
      // Prefer muxed 360p/720p if present; else smallest muxed; else (if merge enabled) choose 360p (video-only) with merge flag; else choose first muxed/video-only
      const muxedPreferredItags = new Set([22, 18]); // common muxed
      let selected = formats.find(f => muxedPreferredItags.has(Number(f.itag)) && !f.needsMerging) ||
          formats.find(f => f.qualityNum === 360 && !f.needsMerging) ||
          formats.find(f => !f.needsMerging) ||
          (this.allowMerge ? formats.find(f => f.qualityNum === 360 && f.needsMerging) : null) ||
          formats[0] ||
          null;

      const defaultUrl = selected?.url || null;

      return {
        title: details.title || 'YouTube Video',
        thumbnail:
            details.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ||
            `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: Number(details.lengthSeconds || 0),
        description: details.shortDescription || '',
        author: details.author || '',
        viewCount: Number(details.viewCount || 0),

        // main payload
        formats,
        videoFormats: formats, // keep your API shape
        audioFormats,

        url: defaultUrl,
        selectedQuality: selected,

        // flags
        hasMuxed: muxed.length > 0,
        hasAdaptive: videoOnly.length > 0 && audioOnly.length > 0,
        audioGuaranteed: muxed.length > 0 || audioOnly.length > 0,

        videoId,
        normalizedUrl,
      };
    } catch (e) {
      console.error('❌ YouTube fetch failed:', e.message);
      return this._errorPayload(videoId, e.message);
    }
  }

  _errorPayload(videoId, message) {
    return {
      title: 'YouTube Video',
      thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : null,
      duration: 0,
      formats: [],
      videoFormats: [],
      audioFormats: [],
      url: null,
      selectedQuality: null,
      audioGuaranteed: false,
      error: message,
      videoId: videoId || null,
    };
  }
}

const youtubeService = new YouTubeService({
  // allowMerge: true, // <- enable only if you want server-side ffmpeg merging
  enableCache: true,
  cacheTtlMs: 3 * 60 * 1000,
  timeoutMs: 30000,
  maxAttemptsPerClient: 2,
});

async function fetchYouTubeData(url) {
  return youtubeService.fetchYouTubeData(url);
}

async function testYouTube() {
  try {
    const data = await fetchYouTubeData('https://youtu.be/dQw4w9WgXcQ');
    const ok = !!data?.title && !data?.error;
    console.log(ok ? '✅ YouTube service test passed' : '❌ YouTube service test failed');
    console.log(`Title: ${data.title}`);
    console.log(`Formats: ${data.formats.length}`);
    console.log(`Error: ${data.error || 'none'}`);
    return ok;
  } catch (error) {
    console.error('❌ YouTube service test failed:', error.message);
    return false;
  }
}

module.exports = {
  fetchYouTubeData,
  testYouTube,
  youtubeService,
};
