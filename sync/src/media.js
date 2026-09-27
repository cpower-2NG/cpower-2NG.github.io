import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { clients } from './clients.js';

const ALLOWED_IMAGE_HOSTS = [
  'qpic.cn',
  'photo.store.qq.com',
  'photo.qq.com',
  'qzone.qq.com',
];

function allowedHost(host) {
  return ALLOWED_IMAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !allowedHost(url.hostname.toLowerCase())) return null;
    return url;
  } catch {
    return null;
  }
}

function cookieHeader(cookies) {
  return Object.entries(cookies || {})
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function downloadImage(sourceUrl, cookies) {
  const url = safeUrl(sourceUrl);
  if (!url) throw new Error(`媒体地址不在腾讯允许列表中：${sourceUrl}`);
  const response = await fetch(url, {
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      cookie: cookieHeader(cookies),
      referer: 'https://user.qzone.qq.com/',
      'user-agent': 'Mozilla/5.0 BIFROST-QZone-Sync/1.0',
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(`图片下载失败（HTTP ${response.status}）`);
  }
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error(`媒体响应类型异常：${contentType || 'unknown'}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 80 * 1024 * 1024) {
    throw new Error('图片为空或超过 80MB 安全限制。');
  }
  return { bytes, contentType };
}

function extensionFor(contentType) {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('avif')) return 'avif';
  if (contentType.includes('bmp')) return 'bmp';
  return 'jpg';
}

async function uploadIfMissing(name, data, contentType) {
  const blob = clients().media.getBlockBlobClient(name);
  if (!(await blob.exists())) {
    await blob.uploadData(data, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobCacheControl: 'public, max-age=31536000, immutable',
      },
    });
  }
  return `${clients().config.blobAccountUrl}/${clients().config.mediaContainer}/${name}`;
}

export async function storeImage(sourceUrl, cookies, options = {}) {
  const downloaded = await downloadImage(sourceUrl, cookies);
  const hash = createHash('sha256').update(downloaded.bytes).digest('hex');
  const extension = extensionFor(downloaded.contentType);
  const originalName = `qq/${hash}.${extension}`;
  const publicUrl = await uploadIfMissing(originalName, downloaded.bytes, downloaded.contentType);

  let metadata = {};
  try {
    metadata = await sharp(downloaded.bytes, { animated: true }).metadata();
  } catch {
    metadata = {};
  }

  const width = Number(metadata.width) || 0;
  const height = Number(metadata.height) || 0;
  const variants = [];
  const widths = Array.isArray(options.widths) ? options.widths : [480, 960, 1600];
  if (width > 0) {
    for (const target of widths.filter((item) => item < width)) {
      const displayName = `qq/${hash}-${target}.webp`;
      const display = await sharp(downloaded.bytes, { animated: true })
        .rotate()
        .resize({ width: target, withoutEnlargement: true })
        .webp({ quality: 84, effort: 4 })
        .toBuffer();
      const url = await uploadIfMissing(displayName, display, 'image/webp');
      variants.push({ url, width: target, format: 'webp' });
    }
  }

  const sourceQuality = width >= 1600 ? 'original' : width >= 720 ? 'high' : 'low';
  return {
    kind: 'image',
    url: publicUrl,
    width: width || undefined,
    height: height || undefined,
    sourceUrl,
    sourceQuality,
    variants,
  };
}
