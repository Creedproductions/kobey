const { ttdl, twitter, igdl } = require('btch-downloader');
const { BitlyClient } = require('bitly');
const tinyurl = require('tinyurl');
const axios = require('axios');
const config = require('../Config/config');

const { ytdl, pindl } = require('jer-api'); // if you still need these elsewhere
const threadsDownloader = require('../Services/threadsService');
const fetchLinkedinData = require('../Services/linkedinService');
const facebookInsta = require('../Services/facebookInstaService');
const { downloadTwmateData } = require('../Services/twitterService');
const { fetchYouTubeData } = require('../Services/youtubeService');

const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// --- helpers ---
const shortenUrl = async (url) => {
  if (!url) return url;
  try {
    const r = await bitly.shorten(url);
    return r.link;
  } catch {
    try {
      return await tinyurl.shorten(url);
    } catch {
      return url;
    }
  }
};

const identifyPlatform = (url) => {
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'twitter';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('pinterest.com') || url.includes('pin.it')) return 'pinterest';
  if (url.includes('threads.net') || url.includes('threads.com')) return 'threads';
  if (url.includes('linkedin.com')) return 'linkedin';
  return null;
};

const normalizeYouTubeUrl = (url) => {
  const m = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : url;
};

const validateDirectMediaUrl = async (directUrl) => {
  try {
    const head = await axios.head(directUrl, { maxRedirects: 2, timeout: 8000 });
    const ct = (head.headers['content-type'] || '').toLowerCase();
    const len = parseInt(head.headers['content-length'] || '0', 10);
    const isMedia = ct.startsWith('video/') || ct.startsWith('image/') || ct === 'application/octet-stream';
    return isMedia && len > 100 * 1024;
  } catch {
    return false;
  }
};

// --- formatting ---
const formatData = async (platform, data) => {
  const placeholderThumbnail = 'https://via.placeholder.com/300x150';

  switch (platform) {
    case 'youtube': {
      if (!data || !data.title) throw new Error('YouTube data incomplete');
      const formats = Array.isArray(data.formats) ? data.formats : [];
      const vwa = formats.filter(f => f.type === 'video_with_audio');
      const best = vwa.find(f => /720p/.test(f.quality)) ||
                   vwa.find(f => /480p/.test(f.quality)) ||
                   vwa[0];
      if (!best?.url) throw new Error('No muxed (video+audio) format available');
      return {
        title: data.title,
        url: best.url,
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: vwa.map(f => f.quality).filter(Boolean),
        duration: data.duration || 'Unknown',
        source: platform,
      };
    }

    case 'instagram': {
      if (data?.media && Array.isArray(data.media)) {
        const m = data.media[0] || {};
        return {
          title: data.title || 'Instagram Media',
          url: m.url || '',
          thumbnail: data.thumbnail || placeholderThumbnail,
          sizes: ['Original Quality'],
          source: platform,
        };
      }
      const item = Array.isArray(data) ? data[0] : null;
      if (!item?.url) throw new Error('Instagram data invalid');
      return {
        title: item?.wm || 'Instagram Media',
        url: item.url,
        thumbnail: item.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    }

    case 'twitter': {
      if (data?.data && (data.data.HD || data.data.SD)) {
        const t = data.data;
        return {
          title: 'Twitter Video',
          url: t.HD || t.SD || '',
          thumbnail: t.thumbnail || placeholderThumbnail,
          sizes: t.HD ? ['HD'] : ['SD'],
          source: platform,
        };
      } else if (data?.data && Array.isArray(data.data)) {
        const arr = data.data;
        const best = arr.find(i => /1280x720/.test(i.quality)) ||
                     arr.find(i => /640x360/.test(i.quality)) ||
                     arr[0];
        return {
          title: 'Twitter Video',
          url: best?.url || '',
          thumbnail: placeholderThumbnail,
          sizes: arr.map(i => i.quality).filter(Boolean),
          source: platform,
        };
      } else if (Array.isArray(data) && data.length) {
        const best = data.find(i => /1280x720/.test(i.quality)) ||
                     data.find(i => /640x360/.test(i.quality)) ||
                     data[0];
        return {
          title: 'Twitter Video',
          url: best?.url || '',
          thumbnail: placeholderThumbnail,
          sizes: data.map(i => i.quality).filter(Boolean),
          source: platform,
        };
      }
      throw new Error('Twitter data invalid');
    }

    case 'facebook': {
      if (data?.media && Array.isArray(data.media)) {
        const v = data.media.find(i => i.type === 'video') || data.media[0] || {};
        return {
          title: data.title || 'Facebook Video',
          url: v.url || '',
          thumbnail: data.thumbnail || placeholderThumbnail,
          sizes: [v.quality || 'Original Quality'],
          source: platform,
        };
      }
      const arr = Array.isArray(data?.data) ? data.data : [];
      const hd = arr.find(v => /720p/.test(v.resolution));
      const sd = arr.find(v => /360p/.test(v.resolution));
      const url = (hd && hd.url) || (sd && sd.url) || '';
      return {
        title: data.title || 'Facebook Video',
        url,
        thumbnail: (hd?.thumbnail || sd?.thumbnail || placeholderThumbnail),
        sizes: [hd ? '720p' : '360p'],
        source: platform,
      };
    }

    case 'pinterest': {
      const pd = data?.data || data || {};
      const u = pd.result || pd.url || '';
      return {
        title: 'Pinterest Image',
        url: u,
        thumbnail: u || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    }

    case 'tiktok': {
      const videoUrl = data?.video?.[0] || data?.url || data?.data?.url || '';
      if (!videoUrl) throw new Error('TikTok: no video url');
      return {
        title: data?.title || 'TikTok Video',
        url: videoUrl,
        thumbnail: data?.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        audio: data?.audio?.[0] || '',
        source: platform,
      };
    }

    case 'threads': {
      return {
        title: 'Threads Post',
        url: data?.download || '',
        thumbnail: data?.thumbnail || placeholderThumbnail,
        sizes: [data?.quality || 'Unknown'],
        source: platform,
      };
    }

    case 'linkedin': {
      const first = Array.isArray(data?.data?.videos) && data.data.videos.length ? data.data.videos[0] : '';
      return {
        title: 'LinkedIn Video',
        url: first || '',
        thumbnail: first ? placeholderThumbnail : 'Error',
        sizes: ['Original Quality'],
        source: platform,
      };
    }

    default:
      return {
        title: data?.title || 'Untitled Media',
        url: data?.url || '',
        thumbnail: data?.thumbnail || placeholderThumbnail,
        sizes: data?.sizes?.length ? data.sizes : ['Original Quality'],
        source: platform,
      };
  }
};

// --- controller ---
exports.downloadMedia = async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const platform = identifyPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform' });

  const reqUrl = platform === 'youtube' ? normalizeYouTubeUrl(url) : url;

  try {
    let data;
    switch (platform) {
      case 'instagram':
        try { data = await igdl(reqUrl); } catch { data = await facebookInsta(reqUrl); }
        break;
      case 'tiktok':
        data = await ttdl(reqUrl);
        break;
      case 'facebook':
        data = await facebookInsta(reqUrl);
        break;
      case 'twitter':
        try {
          data = await twitter(reqUrl);
          const ok = data?.data?.HD || data?.data?.SD ||
                     (Array.isArray(data?.url) && data.url.some(i => i?.url));
          if (!ok) throw new Error('btch unusable');
        } catch {
          data = await downloadTwmateData(reqUrl);
        }
        break;
      case 'youtube':
        data = await fetchYouTubeData(reqUrl);
        break;
      case 'pinterest':
        data = await pindl(reqUrl);
        break;
      case 'threads':
        data = await threadsDownloader(reqUrl);
        break;
      case 'linkedin':
        data = await fetchLinkedinData(reqUrl);
        break;
      default:
        return res.status(500).json({ error: 'Platform identification failed' });
    }

    if (!data) return res.status(404).json({ error: 'Data not found for the platform' });

    const formattedData = await formatData(platform, data);

    // do NOT shorten direct media URL
    const valid = await validateDirectMediaUrl(formattedData.url);
    if (!valid) return res.status(502).json({ error: 'Media link invalid/expired, try again' });

    // optional short link for the share page only
    formattedData.shareUrl = await shortenUrl(url);

    return res.status(200).json({ success: true, data: formattedData });
  } catch (e) {
    console.error('Download Media error:', e.message);
    return res.status(500).json({ error: 'Failed to download media' });
  }
};
