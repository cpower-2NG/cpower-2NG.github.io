import assert from 'node:assert/strict';
import test from 'node:test';
import { renderStructuredPost, renderVideoCard } from '../build.mjs';

test('structured QQ posts render images, history and source-safe text', () => {
  const html = renderStructuredPost({
    text: '第一行\n第二行\n\n<script>alert(1)</script>',
    media: [
      {
        kind: 'image',
        url: 'https://example.qpic.cn/photo.jpg',
        width: 2000,
        height: 1200,
        sourceQuality: 'original',
        variants: [
          {
            url: 'https://example.qpic.cn/photo-960.webp',
            width: 960,
            format: 'webp',
          },
        ],
      },
    ],
    historicalInteractions: {
      likeCount: 2,
      comments: [
        {
          authorLabel: '匿名访客 ABCDEF',
          text: '历史评论',
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    },
  });
  assert.match(html, /srcset=/);
  assert.match(html, /history-comments/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('<script>'), false);
});

test('video cards reject unknown embed origins', () => {
  const html = renderVideoCard({
    platform: '测试',
    sourceUrl: 'https://example.com/video',
    embedUrl: 'https://evil.example/embed',
    cover: 'https://example.qpic.cn/cover.jpg',
  });
  assert.equal(html.includes('data-video-embed'), false);
  assert.match(html, /查看原视频/);
});
