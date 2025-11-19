function decodeMergeUrl(mergeUrl, serverBaseUrl, title = '') {
  if (!mergeUrl || !mergeUrl.startsWith('MERGE_V2|')) return mergeUrl;
  
  const parts = mergeUrl.split('|');
  if (parts.length >= 3) {
    try {
      const videoUrl = Buffer.from(parts[1], 'base64').toString('utf-8');
      const audioUrl = Buffer.from(parts[2], 'base64').toString('utf-8');
      const titleParam = title ? `&title=${encodeURIComponent(title)}` : '';
      return `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}${titleParam}`;
    } catch (error) {
      console.error('❌ Failed to decode MERGE_V2 URL:', error.message);
      return mergeUrl;
    }
  }
  
  return mergeUrl;
}

function convertMergeUrls(formats, serverBaseUrl, title = '') {
  if (!formats || !Array.isArray(formats)) return formats;
  
  return formats.map(format => {
    if (format.url && format.url.startsWith('MERGE_V2')) {
      const convertedUrl = decodeMergeUrl(format.url, serverBaseUrl, title);
      console.log(`🔄 Converted merge URL for ${format.quality}`);
      return { ...format, url: convertedUrl };
    }
    return format;
  });
}

function getServerBaseUrl(req) {
  const host = req.get('host');
  const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  return process.env.SERVER_BASE_URL || `${protocol}://${host}`;
}

module.exports = { decodeMergeUrl, convertMergeUrls, getServerBaseUrl };
