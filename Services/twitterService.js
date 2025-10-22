const fetch = require('node-fetch');
const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Downloads Twitter/X video using direct extraction + btch-downloader fallback
 * @param {string} twitterUrl - The Twitter/X URL
 * @returns {Promise<Array>} Array of video objects with quality, type, and url
 */
async function downloadTwmateData(twitterUrl) {
    console.log(`\n🐦 Processing Twitter URL: ${twitterUrl}`);

    try {
        // ============================================
        // METHOD 1: Direct HTML Extraction (Fastest)
        // ============================================
        console.log('📥 Fetching Twitter page content...');
        const response = await fetch(twitterUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            }
        });

        if (!response.ok) {
            console.log(`⚠️ Failed to fetch Twitter page: ${response.status}`);
        } else {
            const html = await response.text();

            console.log('🔍 Searching for video URLs in page...');

            // Multiple regex patterns to find video URLs
            const videoUrlPatterns = [
                /video_url":"([^"]+)"/,
                /playbackUrl":"([^"]+)"/,
                /video_info\"\:.*?\{\"bitrate\"\:.*?\"url\"\:\"([^\"]+)\"/,
                /"(?:https?:\/\/video\.twimg\.com\/[^"]+\.mp4[^"]*)"/g,
                /https?:\/\/video\.twimg\.com\/[^"'\s]+\.mp4[^"'\s]*/g
            ];

            const videoUrls = [];

            for (const pattern of videoUrlPatterns) {
                if (pattern.global) {
                    const matches = html.match(pattern);
                    if (matches && matches.length > 0) {
                        matches.forEach(match => {
                            const cleanUrl = match.replace(/"/g, '').replace(/&amp;/g, '&');
                            if (!videoUrls.includes(cleanUrl)) {
                                videoUrls.push(cleanUrl);
                            }
                        });
                    }
                } else {
                    const match = pattern.exec(html);
                    if (match && match[1]) {
                        const cleanUrl = match[1]
                            .replace(/\\u002F/g, '/')
                            .replace(/\\\//g, '/')
                            .replace(/\\/g, '')
                            .replace(/&amp;/g, '&');
                        if (!videoUrls.includes(cleanUrl)) {
                            videoUrls.push(cleanUrl);
                        }
                    }
                }
            }

            // If video URLs found, return them
            if (videoUrls.length > 0) {
                console.log(`✅ Found ${videoUrls.length} video URL(s) via direct extraction`);
                
                const results = videoUrls.map((url, index) => {
                    // Try to extract quality from URL
                    let quality = 'unknown';
                    const qualityMatch = url.match(/(\d+x\d+)/);
                    if (qualityMatch) {
                        const dimensions = qualityMatch[1].split('x');
                        const height = parseInt(dimensions[1]);
                        quality = height >= 720 ? `${height}p` : 'SD';
                    }
                    
                    return {
                        quality: quality,
                        type: 'video/mp4',
                        url: url
                    };
                });

                return results;
            }
        }

        // ============================================
        // METHOD 2: btch-downloader (Fallback)
        // ============================================
        console.log('🔄 Direct extraction failed, trying btch-downloader...');
        
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

                // Add SD quality if available
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
