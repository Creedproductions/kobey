const fetch = require('node-fetch');
const axios = require('axios');

/**
 * Downloads Twitter/X video using Twitter Syndication API (FREE & RELIABLE)
 * @param {string} twitterUrl - The Twitter/X URL
 * @returns {Promise<Array>} Array of video objects with quality, type, and url
 */
async function downloadTwmateData(twitterUrl) {
    console.log(`\n🐦 Processing Twitter URL: ${twitterUrl}`);

    try {
        // Extract tweet ID from URL
        const tweetIdMatch = twitterUrl.match(/status\/(\d+)/);
        if (!tweetIdMatch) {
            throw new Error('Invalid Twitter URL - could not extract tweet ID');
        }

        const tweetId = tweetIdMatch[1];
        console.log(`📝 Tweet ID: ${tweetId}`);

        // ============================================
        // METHOD 1: Twitter Syndication API (Best & Free)
        // ============================================
        console.log('🔍 Using Twitter Syndication API...');
        
        try {
            const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=a`;
            
            const response = await fetch(syndicationUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json',
                }
            });

            if (response.ok) {
                const data = await response.json();
                
                // Extract video from response
                if (data.mediaDetails && data.mediaDetails.length > 0) {
                    const media = data.mediaDetails.find(m => m.type === 'video');
                    
                    if (media && media.video_info && media.video_info.variants) {
                        const videoVariants = media.video_info.variants
                            .filter(v => v.content_type === 'video/mp4')
                            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

                        if (videoVariants.length > 0) {
                            console.log(`✅ Found ${videoVariants.length} video variant(s)`);
                            
                            return videoVariants.map(variant => ({
                                quality: variant.bitrate ? `${Math.round(variant.bitrate / 1000)}kbps` : 'unknown',
                                type: 'video/mp4',
                                url: variant.url
                            }));
                        }
                    }
                }
            }
        } catch (synError) {
            console.log(`⚠️ Syndication API failed: ${synError.message}`);
        }

        // ============================================
        // METHOD 2: vxTwitter API (Free Mirror Service)
        // ============================================
        console.log('🔄 Trying vxTwitter API...');
        
        try {
            // Replace domain with vxtwitter.com to get JSON
            const vxUrl = twitterUrl
                .replace('twitter.com', 'api.vxtwitter.com')
                .replace('x.com', 'api.vxtwitter.com')
                .replace('?#', '');
            
            const vxResponse = await fetch(vxUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (vxResponse.ok) {
                const vxData = await vxResponse.json();
                
                if (vxData.media_extended && vxData.media_extended.length > 0) {
                    const videos = vxData.media_extended
                        .filter(m => m.type === 'video')
                        .map(m => ({
                            quality: m.duration_millis ? 'HD' : 'unknown',
                            type: 'video/mp4',
                            url: m.url
                        }));

                    if (videos.length > 0) {
                        console.log(`✅ Found video via vxTwitter`);
                        return videos;
                    }
                }
            }
        } catch (vxError) {
            console.log(`⚠️ vxTwitter API failed: ${vxError.message}`);
        }

        // ============================================
        // METHOD 3: btch-downloader (Fallback)
        // ============================================
        console.log('🔄 Trying btch-downloader...');
        
        try {
            const { twitter } = require('btch-downloader');
            const result = await twitter(twitterUrl);
            
            if (result && result.HD) {
                console.log('✅ Retrieved video via btch-downloader');
                const results = [
                    {
                        quality: 'HD',
                        type: 'video/mp4',
                        url: result.HD
                    }
                ];

                if (result.SD) {
                    results.push({
                        quality: 'SD',
                        type: 'video/mp4',
                        url: result.SD
                    });
                }

                return results;
            }
        } catch (btchError) {
            console.log(`⚠️ btch-downloader failed: ${btchError.message}`);
        }

        // ============================================
        // All methods failed
        // ============================================
        throw new Error('All download methods failed - video may be private, deleted, or region-locked');

    } catch (error) {
        console.error(`❌ Twitter download error: ${error.message}`);
        throw new Error("Twitter download failed: " + error.message);
    }
}

module.exports = { downloadTwmateData };
