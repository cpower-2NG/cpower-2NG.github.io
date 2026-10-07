import { stableAnonymousLabel } from './rules.js';

/**
 * 评论里的 @ 标记：QQ 的 @{uin:…,nick:…} 结构化标记渲染成 @昵称（去掉 uin，
 * 昵称本身在对方空间公开，保留文本可读性）；裸 @昵称 原样保留。
 */
export function renderMentions(value) {
  return String(value || '').replace(/@\{[^}]*\}/g, (marker) => {
    const nick = marker.match(/nick:([^,}]+)/);
    return nick ? `@${nick[1].trim()}` : '@好友';
  });
}

export function stripPrivateReferences(value) {
  return String(value || '')
    .replace(/@\{[^}]+\}/g, (marker) => {
      const nick = marker.match(/nick:([^,}]+)/);
      return nick ? `@${nick[1].trim()}` : '@好友';
    })
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
