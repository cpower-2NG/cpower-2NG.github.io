function urls(value) {
  return String(value || '').match(/https?:\/\/[^\s<>"'）)]+/gi) || [];
}

function youtubeId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
    if (parsed.hostname.endsWith('youtube.com')) {
      return parsed.searchParams.get('v') || parsed.pathname.match(/\/embed\/([^/]+)/)?.[1] || '';
    }
  } catch {
    return '';
  }
  return '';
}

export function videoSourceFromText(text) {
  for (const sourceUrl of urls(text)) {
    try {
      const parsed = new URL(sourceUrl);
      const host = parsed.hostname.toLowerCase();
      if (host === 'youtu.be' || host.endsWith('youtube.com')) {
        const id = youtubeId(sourceUrl);
        return {
          platform: 'YouTube',
          sourceUrl,
          embedUrl: id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : '',
        };
      }
      if (host.endsWith('bilibili.com')) {
        const bvid = parsed.pathname.match(/\/(BV[A-Za-z0-9]+)/)?.[1]
          || parsed.searchParams.get('bvid')
          || '';
        return {
          platform: '哔哩哔哩',
          sourceUrl,
          embedUrl: bvid
            ? `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&high_quality=1&danmaku=0`
            : '',
        };
      }
      if (host.endsWith('v.qq.com')) {
        const vid = parsed.pathname.match(/\/([A-Za-z0-9]{8,})\.html/)?.[1] || parsed.searchParams.get('vid') || '';
        return {
          platform: '腾讯视频',
          sourceUrl,
          embedUrl: vid ? `https://v.qq.com/txp/iframe/player.html?vid=${encodeURIComponent(vid)}` : '',
        };
      }
    } catch {
      // Continue scanning remaining URLs.
    }
  }
  return null;
}
