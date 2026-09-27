import { stableAnonymousLabel } from './rules.js';

export function stripPrivateReferences(value) {
  return String(value || '')
    .replace(/@\{[^}]+\}/g, '@匿名好友')
    .replace(/@[^\s，。！？、,:：;；]{1,32}/g, '@匿名好友')
    .replace(/https?:\/\/\S+/gi, '[链接已移除]')
    .replace(/\b\d{5,12}\b/g, '[号码已隐藏]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function anonymizeComment(comment, salt) {
  return {
    id: String(comment.id || ''),
    authorLabel: stableAnonymousLabel(comment.author?.id || comment.author?.nickname || 'unknown', salt),
    text: stripPrivateReferences(comment.content || ''),
    createdAt: comment.createdAt || null,
  };
}
