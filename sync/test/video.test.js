import assert from 'node:assert/strict';
import test from 'node:test';
import { videoSourceFromText } from '../src/video.js';

test('extracts YouTube and builds a privacy enhanced embed', () => {
  const video = videoSourceFromText('推荐 https://www.youtube.com/watch?v=abc123 很好看');
  assert.equal(video.platform, 'YouTube');
  assert.equal(video.embedUrl, 'https://www.youtube-nocookie.com/embed/abc123');
});

test('extracts Bilibili BV ids', () => {
  const video = videoSourceFromText('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(video.platform, '哔哩哔哩');
  assert.match(video.embedUrl, /bvid=BV1xx411c7mD/);
});
