import { createHash } from 'node:crypto';

export function countLinks(value) {
  return (String(value || '').match(/https?:\/\/|www\./gi) || []).length;
}

export function commentFingerprint(path, nickname, content) {
  return createHash('sha256')
    .update(`${path}\n${nickname}\n${content}`)
    .digest('hex')
    .slice(0, 32);
}

export function moderateComment({ content, honeypot, elapsedMs }) {
  if (honeypot) {
    return { rejected: true, status: 'rejected', reason: 'HONEYPOT' };
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1200) {
    return { rejected: true, status: 'rejected', reason: 'TOO_FAST' };
  }
  const links = countLinks(content);
  if (links > 2) {
    return { rejected: false, status: 'pending', reason: 'LINK_LIMIT' };
  }
  if (/(?:https?:\/\/\S+){2,}/i.test(content)) {
    return { rejected: false, status: 'pending', reason: 'MULTIPLE_LINKS' };
  }
  return { rejected: false, status: 'published', reason: '' };
}
