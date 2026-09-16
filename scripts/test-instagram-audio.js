const assert = require('assert');
const ytdlp = require('../Services/ytDlpRunner');
const {
  requireAudioForInstagramVideos,
  hasVerifiedAudio,
} = require('../Services/instagramAudioService');

async function main() {
  const pair = ytdlp.formatInstagramItems({
    thumbnail: 'https://cdn.example/cover.jpg',
    requested_formats: [
      { url: 'https://cdn.example/video.mp4', vcodec: 'h264', acodec: 'none', height: 1080 },
      { url: 'https://cdn.example/audio.m4a', vcodec: 'none', acodec: 'aac', abr: 128 },
    ],
  });
  assert.equal(pair.length, 1);
  assert.equal(pair[0].needsMerge, true);
  assert.equal(pair[0].audioUrl, 'https://cdn.example/audio.m4a');
  assert.equal(pair[0].hasAudio, true);

  const inferredPair = ytdlp.formatInstagramItems({
    formats: [
      { url: 'https://cdn.example/720.mp4', vcodec: 'h264', acodec: 'none', height: 720 },
      { url: 'https://cdn.example/1080.mp4', vcodec: 'h264', acodec: 'none', height: 1080 },
      { url: 'https://cdn.example/64.m4a', vcodec: 'none', acodec: 'aac', abr: 64 },
      { url: 'https://cdn.example/128.m4a', vcodec: 'none', acodec: 'aac', abr: 128 },
    ],
  });
  assert.equal(inferredPair.length, 1);
  assert.equal(inferredPair[0].url, 'https://cdn.example/1080.mp4');
  assert.equal(inferredPair[0].audioUrl, 'https://cdn.example/128.m4a');

  const muxed = ytdlp.formatInstagramItems({
    formats: [
      { url: 'https://cdn.example/muxed.mp4', vcodec: 'h264', acodec: 'aac', height: 720 },
      { url: 'https://cdn.example/silent.mp4', vcodec: 'h264', acodec: 'none', height: 1080 },
    ],
  });
  assert.equal(muxed.length, 1);
  assert.equal(muxed[0].url, 'https://cdn.example/muxed.mp4');
  assert.equal(muxed[0].needsMerge, undefined);
  assert.equal(hasVerifiedAudio(muxed[0]), true);

  await assert.rejects(
    requireAudioForInstagramVideos(
      [{ url: 'https://cdn.example/silent.mp4', type: 'video' }],
      { probe: async () => false },
    ),
    /audio track missing/,
  );

  const verified = await requireAudioForInstagramVideos(
    [{ url: 'https://cdn.example/muxed.mp4', type: 'video' }],
    { probe: async () => true },
  );
  assert.equal(verified[0].audioVerified, true);

  const image = await requireAudioForInstagramVideos(
    [{ url: 'https://cdn.example/photo.jpg', type: 'image' }],
    { probe: async () => { throw new Error('image must not be probed'); } },
  );
  assert.equal(image.length, 1);

  console.log('PASS Instagram audio selection and validation');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
