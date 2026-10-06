import { createHash } from 'node:crypto';
import { QzoneClient, QzoneNotFoundError } from 'qzone-sdk';
import { clients } from './clients.js';
import { anonymizeComment } from './anonymize.js';
import { createRawArchive } from './archive.js';
import {
  commitRecords,
  listContentRecords,
  publishDryRunReport,
  publishQuarantineRecords,
} from './github.js';
import { storeImage } from './media.js';
import { contentHash, evaluatePost, hashSalt, loadRules, safeRecordId } from './rules.js';
import { readState, setQzoneStatus, setStatus, writeState } from './state.js';
import { videoSourceFromText } from './video.js';
import {
  buildShareRecords,
  createShareCapture,
  extractBilibiliShares,
  extractWupShares,
  fetchWupShareEntries,
} from './qzone-shares.js';
import { momentDocsFromRecords, upsertMomentDocs } from './moment-store.js';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadSession() {
  const secret = await clients().secrets.getSecret('qzone-session');
  if (!secret.value) {
    throw new Error('QQ 登录会话不存在，请先在管理台重新连接 QQ。');
  }
  return JSON.parse(secret.value);
}

async function persistSession(session) {
  await clients().secrets.setSecret('qzone-session', JSON.stringify(session));
}

function typeFor(text, media) {
  const length = String(text || '').replace(/\s+/g, '').length;
  return length <= 180 && media.length <= 2 ? 'diary' : 'article';
}

function uniqueMedia(media) {
  const seen = new Set();
  return media.filter((item) => {
    const key = item.url || item.sourceUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyOverride(record, overrides) {
  const override = overrides[`id:${record.source?.id || ''}`]
    || overrides[`path:${record.id}`]
    || null;
  if (!override || typeof override !== 'object') return record;
  return {
    ...record,
    ...(override.phase === 'logic' || override.phase === 'fantasy' ? { phase: override.phase } : {}),
    ...(override.type === 'diary' || override.type === 'article' ? { type: override.type } : {}),
    ...(override.section ? { section: String(override.section).trim() } : {}),
    ...(override.title ? { title: String(override.title) } : {}),
    ...(override.category ? { category: String(override.category) } : {}),
    ...(override.summary ? { summary: String(override.summary) } : {}),
    ...(Array.isArray(override.tags) ? { tags: override.tags.map(String) } : {}),
    ...(typeof override.featured === 'boolean' ? { featured: override.featured } : {}),
    ...(override.publishStatus ? { publishStatus: String(override.publishStatus) } : {}),
    overrides: {
      ...(record.overrides || {}),
      ...override,
    },
  };
}

async function mapMedia(post, cookies) {
  const media = [];
  const warnings = [];
  for (const item of post.media || []) {
    try {
      if (item.kind === 'image') {
        media.push(await storeImage(item.url, cookies));
      } else if (item.kind === 'video') {
        let cover = '';
        if (item.previewUrl) {
          const stored = await storeImage(item.previewUrl, cookies);
          cover = stored.url;
          media.push({ ...stored, kind: 'video-cover' });
        }
        media.push({
          kind: 'video',
          url: item.url,
          sourceUrl: item.url,
          cover,
        });
      }
    } catch (error) {
      warnings.push(`MEDIA:${item.kind}:${error.message}`);
    }
  }
  return { media: uniqueMedia(media), warnings };
}

function sourceMediaDescriptor(item) {
  if (item.kind === 'video') {
    return {
      kind: 'video',
      url: item.url || '',
      sourceUrl: item.url || '',
      cover: item.previewUrl || '',
    };
  }
  if (item.kind === 'image') {
    return {
      kind: 'image',
      url: item.url || '',
      sourceUrl: item.url || '',
      width: Number(item.width) || undefined,
      height: Number(item.height) || undefined,
      sourceQuality: Number(item.width) >= 1600 ? 'original' : Number(item.width) >= 720 ? 'high' : 'low',
      variants: [],
    };
  }
  return null;
}

function normalizeVideo(post, media) {
  const fromText = videoSourceFromText(post.content);
  if (fromText) {
    return {
      ...fromText,
      cover: media.find((item) => item.kind === 'video-cover')?.url
        || media.find((item) => item.kind === 'image')?.url
        || '',
      note: '转载视频，仅保存本站封面并链接原始来源。',
    };
  }
  const native = (post.media || []).find((item) => item.kind === 'video');
  if (!native) return null;
  return {
    platform: 'QQ 空间',
    sourceUrl: native.url,
    embedUrl: '',
    cover: media.find((item) => item.kind === 'video-cover')?.url || native.previewUrl || '',
    note: 'QQ 空间原生视频，播放可用性取决于原来源。',
  };
}

async function normalizePost(post, rules, salt, cookies, { allowPublicMedia }) {
  const sourceMedia = (post.media || []).map(sourceMediaDescriptor).filter(Boolean);
  const sourceVideo = normalizeVideo(post, sourceMedia);
  const comments = (post.comments || []).map((comment) => anonymizeComment(comment, salt));
  const warnings = [];
  if (post.commentsComplete === false) warnings.push('COMMENTS_INCOMPLETE');
  const preliminaryDecision = evaluatePost(
    {
      content: String(post.content || '').trim(),
      media: sourceMedia,
      video: sourceVideo,
      visibility: String(post.visibility || 'unknown'),
      kind: post.kind,
    },
    rules,
    'complete',
  );

  let media = sourceMedia;
  let video = sourceVideo;
  if (allowPublicMedia && preliminaryDecision.publishStatus === 'published') {
    const mappedMedia = await mapMedia(post, cookies);
    media = mappedMedia.media?.filter((item) => item.kind !== 'video-cover') || [];
    video = normalizeVideo(post, mappedMedia.media || []);
    warnings.push(...mappedMedia.warnings);
  }

  const candidate = {
    id: `qq-${safeRecordId(post.id)}`,
    schemaVersion: 1,
    title: `日常 · ${post.createdAt?.slice(0, 10) || '日期未知'}`,
    date: post.createdAt?.slice(0, 10) || '',
    createdAt: post.createdAt || null,
    phase: rules.defaultPhase || 'fantasy',
    type: typeFor(post.content, media),
    section: 'daily',
    tags: ['QQ空间', '自动同步'],
    category: '日常',
    summary: String(post.content || '').replace(/\s+/g, ' ').slice(0, 80),
    text: String(post.content || '').trim(),
    media,
    video,
    cover: video?.cover || media.find((item) => item.kind === 'image')?.url || '',
    historicalInteractions: {
      likeCount: Number(post.likeCount) || 0,
      commentCount: Number(post.commentCount) || comments.length,
      comments,
    },
    source: {
      provider: 'qq',
      id: String(post.id),
      authorId: String(post.authorId),
      url: `https://user.qzone.qq.com/${encodeURIComponent(post.authorId)}/mood/${encodeURIComponent(post.id)}`,
      state: 'active',
      visibility: String(post.visibility || 'unknown'),
      adapterVersion: 1,
      warnings,
      missingChecks: 0,
    },
    syndication: {
      author: '',
      source: 'QQ 空间',
    },
  };
  const decision = evaluatePost(
    {
      content: candidate.text,
      media,
      video,
      visibility: candidate.source.visibility,
      kind: post.kind,
    },
    rules,
    warnings.some((warning) => warning.startsWith('MEDIA:')) ? 'partial' : 'complete',
  );
  candidate.publishStatus = decision.publishStatus;
  candidate.reviewReasons = decision.reasons;
  candidate.contentHash = contentHash({
    text: candidate.text,
    media: candidate.media,
    video: candidate.video,
  });
  return candidate;
}

async function recheckDeleted(client, rules) {
  const existing = await listContentRecords();
  const candidates = existing
    .filter(({ record }) => record.source?.state !== 'deleted' && record.source?.id && record.source?.authorId)
    .sort((a, b) => String(a.record.source.lastCheckedAt || '').localeCompare(String(b.record.source.lastCheckedAt || '')))
    .slice(0, 20);
  const updates = [];

  for (const { record } of candidates) {
    try {
      await client.getPost({
        post: {
          id: record.source.id,
          authorId: record.source.authorId,
        },
      });
      record.source.missingChecks = 0;
    } catch (error) {
      if (!(error instanceof QzoneNotFoundError)) throw error;
      record.source.missingChecks = Number(record.source.missingChecks || 0) + 1;
      if (record.source.missingChecks >= Number(rules.safety?.confirmedMissingChecks || 2)) {
        record.source.state = 'deleted';
        record.source.deletedDetectedAt = new Date().toISOString();
      }
    }
    record.source.lastCheckedAt = new Date().toISOString();
    updates.push(record);
    await sleep(1200);
  }
  return updates;
}

export async function syncQzone() {
  const { config, secrets } = clients();
  const rules = await loadRules();
  const overridesDocument = await readState('content-overrides', 'settings');
  const overrides = overridesDocument?.overrides && typeof overridesDocument.overrides === 'object'
    ? overridesDocument.overrides
    : {};
  const storedRequest = await readState('sync-request');
  const request = storedRequest && storedRequest.state !== 'completed' ? storedRequest : null;
  const dryRun = Boolean(request?.dryRun);
  // 模式分派：
  //   incremental  最近 7 天（无水位时的兜底）
  //   since        从上次成功同步的水位开始（-2h 缓冲防边界丢失），日常推荐
  //   backfill     指定天数回填
  //   full         全量搬迁：cutoff 归零，页数上限放宽
  const mode = ['incremental', 'since', 'backfill', 'full'].includes(request?.mode)
    ? request.mode
    // 定时任务等未携带模式的触发：走水位增量（无水位则回看 7 天）。
    : 'since';
  const watermark = await readState('sync-watermark');
  const runStartedAt = new Date().toISOString();
  let cutoff;
  let maxPages = 50;
  if (mode === 'full') {
    cutoff = 0;
    maxPages = 100;
  } else if (mode === 'since') {
    const lastRun = watermark?.lastRunStartedAt
      ? new Date(watermark.lastRunStartedAt).getTime()
      : Date.now() - 7 * 24 * 60 * 60 * 1000;
    cutoff = lastRun - 2 * 60 * 60 * 1000;
  } else if (mode === 'backfill') {
    const days = Number(request?.backfillDays) || rules.initialBackfillDays || 31;
    cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  } else {
    cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  }
  const salt = await hashSalt();
  const session = await loadSession();
  const shareCapture = createShareCapture();
  const client = new QzoneClient({
    session,
    fetch: shareCapture.fetch,
    onSessionChange: persistSession,
    logger: (event) => {
      if (event.level === 'warn' || event.level === 'error') {
        console.warn(JSON.stringify(event));
      }
    },
  });
  await setQzoneStatus('connected', 'QQ 登录会话可用。');
  const cookies = (await client.exportSession()).cookies;
  const records = [];
  const pendingReview = [];
  const quarantined = [];
  const rawArchive = createRawArchive();
  let cursor = null;
  let pages = 0;
  let reachedCutoff = false;

  await setStatus('running', dryRun ? '正在执行验收同步。' : '正在同步 QQ 内容。');
  let paginationError = '';
  try {
    do {
      let page;
      try {
        page = await client.listFeeds({ scope: 'self', limit: 20, cursor });
      } catch (error) {
        // 深翻历史时 QQ 接口偶发失败：保住已抓取的部分并正常提交，而不是整轮报废。
        paginationError = error.message;
        console.warn(`Feed pagination stopped: ${error.message}`);
        break;
      }
      pages += 1;
      for (const feed of page.items) {
        const created = feed.createdAt ? new Date(feed.createdAt).getTime() : 0;
        if (created && created < cutoff) {
          reachedCutoff = true;
          break;
        }
        let post = feed;
        try {
          post = await client.getPost({ post: feed });
        } catch (error) {
          console.warn(`Unable to load QQ post detail ${feed.id}: ${error.message}`);
        }
        rawArchive.add(post);
        const record = applyOverride(
          await normalizePost(post, rules, salt, cookies, {
            allowPublicMedia: rules.autoPublish && !dryRun,
          }),
          overrides,
        );
        if (record.publishStatus === 'published') {
          records.push(record);
        } else if (
          record.reviewReasons?.length
          && record.reviewReasons.every((reason) => reason === 'AUTO_PUBLISH_DISABLED')
        ) {
          pendingReview.push(record);
        } else {
          quarantined.push(record);
        }
        await sleep(1600 + Math.floor(Math.random() * 700));
      }
      cursor = page.nextCursor;
      if (!cursor || reachedCutoff || pages >= maxPages) break;
      await sleep(900);
    } while (cursor);

    // 分享/转发动态（如 B 站视频分享）：SDK 会丢弃这些条目。两个来源：
    //   1) feeds_html_module 的视频卡片转发（appid 202，主路径，实测可达）；
    //   2) 聚合流 JSON 捕获的 B 站链接条目（辅助）。
    // 全部走同一套审查/发布管线。
    if (rules.include?.videoReposts !== false) {
      try {
        const capturedEntries = shareCapture.payloads
          .flatMap((payload) => extractBilibiliShares(payload.text));
        const wupEntries = await fetchWupShareEntries(session, { uin: session.accountId });
        const merged = new Map();
        for (const entry of [...wupEntries, ...capturedEntries]) {
          if (!merged.has(entry.shareId)) merged.set(entry.shareId, entry);
        }
        const shares = [...merged.values()]
          .filter((share) => !share.createdAt || new Date(share.createdAt).getTime() >= cutoff);
        const shareRecords = await buildShareRecords(shares, {
          cookies,
          coverTransfer: rules.autoPublish && !dryRun ? 'store' : 'raw',
        });
        for (const rawRecord of shareRecords) {
          const decision = evaluatePost({
            content: rawRecord.text,
            media: rawRecord.media,
            video: rawRecord.video,
            visibility: 'unknown',
          }, rules, 'complete');
          // 与说说同一条规则链：评估 → 人工覆盖（放行/排除）→ 分桶。
          const record = applyOverride({
            ...rawRecord,
            publishStatus: decision.publishStatus,
            reviewReasons: decision.reasons,
          }, overrides);
          rawArchive.add({ sharedVideo: record.source.id, url: record.source.url, record });
          if (record.publishStatus === 'published') {
            records.push(record);
          } else if (record.reviewReasons.length
            && record.reviewReasons.every((reason) => reason === 'AUTO_PUBLISH_DISABLED')) {
            pendingReview.push(record);
          } else {
            quarantined.push(record);
          }
        }
        if (shareRecords.length) {
          await setStatus('running', `正在同步 QQ 内容（含 ${shareRecords.length} 条分享视频）。`);
        }
      } catch (error) {
        console.warn(`Share video capture skipped: ${error.message}`);
      }
    }

    const deletedUpdates = await recheckDeleted(client, rules).catch((error) => {
      console.warn(`Deletion recheck skipped: ${error.message}`);
      return [];
    });
    const allRecords = [...records, ...pendingReview, ...quarantined, ...deletedUpdates];
    const rawArchivePath = await rawArchive.save();
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      cutoff: new Date(cutoff).toISOString(),
      dryRun,
      mode,
      ...(paginationError ? { partial: true, paginationError } : {}),
      candidates: allRecords.map((record) => ({
        id: record.id,
        date: record.date,
        publishStatus: record.publishStatus,
        reviewReasons: record.reviewReasons || [],
        contentHash: record.contentHash,
      })),
      records: dryRun ? allRecords : undefined,
      counts: {
        publishedCandidate: records.length,
        pendingReview: pendingReview.length,
        quarantined: quarantined.length,
        deletedUpdates: deletedUpdates.length,
      },
      rawArchivePath,
    };

    if (dryRun) {
      const reportPath = await publishDryRunReport(report);
      await writeState('last-sync-report', {
        type: 'last-sync-report',
        reportPath,
        ...report,
      });
      await writeState('sync-request', {
        type: 'sync-request',
        state: 'completed',
        dryRun: true,
        completedAt: new Date().toISOString(),
      });
      await setStatus('dry_run_complete', `验收同步完成，共 ${allRecords.length} 条候选。`);
      return { ...report, reportPath };
    }

    if (rules.autoPublish && !records.length && !deletedUpdates.length) {
      if (request) {
        await writeState('sync-request', {
          type: 'sync-request',
          state: 'completed',
          dryRun: false,
          completedAt: new Date().toISOString(),
        });
      }
      await setStatus('idle', '没有需要发布的新内容。');
      return report;
    }
    const quarantinePath = quarantined.length
      ? await publishQuarantineRecords(quarantined)
      : '';
    const commit = await commitRecords([...records, ...deletedUpdates]);

    // 已发布记录写入权威库（content-moments）：发布物化只认 Cosmos，
    // 不写库的话同步内容永远不会出现在站点上。
    let momentUpserts = 0;
    if (!dryRun && records.length) {
      try {
        const docs = momentDocsFromRecords(records);
        momentUpserts = await upsertMomentDocs(docs);
      } catch (error) {
        console.warn(`Moment upsert skipped: ${error.message}`);
      }
    }
    // 推进水位（仅真实同步）：since 模式的下一次起点。
    if (!dryRun) {
      await writeState('sync-watermark', {
        type: 'sync-watermark',
        lastRunStartedAt: runStartedAt,
        lastCompletedAt: new Date().toISOString(),
        mode,
      });
    }

    await writeState('last-sync-report', {
      type: 'last-sync-report',
      ...report,
      quarantinePath,
      commit,
    });
    await writeState('sync-request', {
      type: 'sync-request',
      state: 'completed',
      dryRun: false,
      completedAt: new Date().toISOString(),
    });
    await setStatus(
      'idle',
      commit.changed
        ? `已提交 ${commit.files} 个内容文件${momentUpserts ? `，${momentUpserts} 条动态入库` : ''}。`
        : '内容没有变化。',
    );
    return { ...report, commit };
  } catch (error) {
    await setStatus('failed', error.message);
    if (/登录|会话|session|auth/i.test(error.message)) {
      await setQzoneStatus('auth_required', error.message);
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}
