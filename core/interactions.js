(() => {
  const VISITOR_KEY = 'bifrost:visitor';
  const PROFILE_KEY = 'bifrost:comment-profile';
  const VIEW_KEY = 'bifrost:viewed';
  let activeController = null;
  let currentPhase = 'logic';

  function visitorId() {
    let value = localStorage.getItem(VISITOR_KEY);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(VISITOR_KEY, value);
    }
    return value;
  }

  function apiUrl(config, route) {
    return `${String(config.apiBaseUrl || '').replace(/\/+$/, '')}${route}`;
  }

  function configured(config) {
    return Boolean(config && config.provider === 'azure' && config.enabled !== false && config.apiBaseUrl);
  }

  async function request(config, route, options = {}) {
    const timeoutController = new AbortController();
    const timer = window.setTimeout(() => timeoutController.abort(), 8000);
    const signal = options.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : options.signal || timeoutController.signal;
    let response;
    try {
      response = await fetch(apiUrl(config, route), {
        method: options.method || 'GET',
        headers: {
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal,
        credentials: 'omit',
      });
    } finally {
      window.clearTimeout(timer);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.message || `互动服务暂时不可用（HTTP ${response.status}）`);
    }
    return payload;
  }

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '刚刚';
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function safeWebsite(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch {
      return '';
    }
  }

  function savedProfile() {
    try {
      const value = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function saveProfile(profile) {
    localStorage.setItem(
      PROFILE_KEY,
      JSON.stringify({
        nickname: String(profile.nickname || '').slice(0, 30),
        website: String(profile.website || '').slice(0, 200),
      }),
    );
  }

  function renderAvatar(comment) {
    if (safeWebsite(comment.avatarUrl)) {
      const image = document.createElement('img');
      image.className = 'comment__avatar';
      image.src = comment.avatarUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      return image;
    }

    const avatar = element('span', 'comment__avatar comment__avatar--initial');
    avatar.textContent = String(comment.nickname || '匿').slice(0, 1);
    return avatar;
  }

  function createComment(comment, onReply) {
    const article = element('article', 'comment');
    article.dataset.commentId = comment.id;

    const header = element('header', 'comment__header');
    header.append(renderAvatar(comment));

    const identity = element('div', 'comment__identity');
    const nameLine = element('p', 'comment__name');
    nameLine.append(document.createTextNode(comment.nickname || '匿名用户'));
    if (comment.isOwner) {
      nameLine.append(element('span', 'comment__owner-badge', '站主'));
    }
    if (comment.website) {
      const website = element('a', 'comment__website', '主页');
      website.href = comment.website;
      website.target = '_blank';
      website.rel = 'noopener noreferrer nofollow';
      nameLine.append(website);
    }
    identity.append(nameLine, element('time', '', formatDate(comment.createdAt)));
    header.append(identity);

    const body = element('p', 'comment__body');
    body.textContent = comment.content;

    const actions = element('div', 'comment__actions');
    const reply = element('button', 'comment__reply', '回复');
    reply.type = 'button';
    reply.addEventListener('click', () => onReply(comment));
    actions.append(reply);

    article.append(header, body, actions);
    if (comment.moderationNote) {
      article.append(element('p', 'comment__pending', comment.moderationNote));
    }
    return article;
  }

  function createReplyForm(parent, onSubmitted) {
    const form = element('form', 'comment-reply-form');
    const profile = savedProfile();
    const identity = element('div', 'comment-reply-form__identity');
    const nickname = element('input', 'comment-form__input');
    nickname.name = 'nickname';
    nickname.maxLength = 30;
    nickname.placeholder = '昵称';
    nickname.value = profile.nickname || '';
    const anonymousLabel = element('label', 'comment-form__anonymous');
    const anonymous = document.createElement('input');
    anonymous.type = 'checkbox';
    anonymous.name = 'anonymous';
    anonymousLabel.append(anonymous, document.createTextNode(' 匿名'));
    identity.append(nickname, anonymousLabel);
    const textarea = element('textarea', 'comment-form__textarea');
    textarea.name = 'content';
    textarea.maxLength = 2000;
    textarea.required = true;
    textarea.rows = 2;
    textarea.placeholder = `回复 ${parent.nickname || '匿名用户'}`;
    const actions = element('div', 'comment-form__actions');
    const cancel = element('button', 'button', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => form.remove());
    const submit = element('button', 'button button--primary', '提交回复');
    submit.type = 'submit';
    actions.append(cancel, submit);
    anonymous.addEventListener('change', () => {
      nickname.disabled = anonymous.checked;
      if (anonymous.checked) nickname.value = '';
      else nickname.value = profile.nickname || '';
    });
    form.append(identity, textarea, actions);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!anonymous.checked && !nickname.value.trim()) return;
      submit.disabled = true;
      try {
        await onSubmitted(textarea.value.trim(), parent.id, {
          anonymous: anonymous.checked,
          nickname: nickname.value,
          website: profile.website || '',
        });
        if (!anonymous.checked) {
          saveProfile({ nickname: nickname.value, website: profile.website || '' });
        }
        form.remove();
      } catch (error) {
        const message = element('p', 'comment__pending', error.message);
        form.querySelector('.comment-reply-form__error')?.remove();
        message.classList.add('comment-reply-form__error');
        form.append(message);
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function renderComments(container, comments, onSubmitReply) {
    container.replaceChildren();
    if (!comments.length) {
      container.append(element('p', 'comments__empty', '还没有评论，留下第一句话吧。'));
      return;
    }

    comments.forEach((comment) => {
      const root = createComment(comment, (parent) => {
        root.querySelector('.comment-reply-form')?.remove();
        root.append(createReplyForm(parent, onSubmitReply));
        root.querySelector('textarea')?.focus();
      });
      const replies = Array.isArray(comment.replies) ? comment.replies : [];
      if (replies.length) {
        const list = element('div', 'comment__replies');
        replies.forEach((reply) => {
          list.append(createComment(reply, (parent) => {
            const form = createReplyForm(parent, onSubmitReply);
            list.prepend(form);
            form.querySelector('textarea')?.focus();
          }));
        });
        root.append(list);
      }
      container.append(root);
    });
  }

  function markViewOnce(path) {
    const today = new Date().toISOString().slice(0, 10);
    const key = `${today}:${path}`;
    const raw = localStorage.getItem(VIEW_KEY);
    try {
      const value = JSON.parse(raw || '{}');
      if (value.key === key) return false;
    } catch {
      // Ignore corrupt local state.
    }
    localStorage.setItem(VIEW_KEY, JSON.stringify({ key }));
    return true;
  }

  function bindVideoEmbeds(viewer) {
    viewer.querySelectorAll('[data-video-embed]').forEach((button) => {
      if (button.dataset.bound) return;
      button.dataset.bound = '1';
      button.addEventListener('click', () => {
        const frame = document.createElement('iframe');
        frame.className = 'video-card__frame';
        frame.src = button.dataset.videoEmbed;
        frame.title = '视频播放器';
        frame.loading = 'lazy';
        frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        frame.allowFullscreen = true;
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        button.closest('.video-card__media')?.replaceChildren(frame);
      });
    });
  }

  async function mount(entry, viewer, config, phase) {
    currentPhase = phase;
    activeController?.abort();
    activeController = new AbortController();
    bindVideoEmbeds(viewer);

    if (!configured(config) || !entry) {
      viewer.querySelectorAll('.comments').forEach((node) => node.remove());
      return;
    }

    const section = element('section', 'comments');
    section.dataset.phase = phase;
    section.innerHTML = '<p class="hero__eyebrow">讨论</p>';
    const loading = element('p', 'comments__status', '正在读取评论…');
    section.append(loading);
    viewer.append(section);

    let payload;
    try {
      payload = await request(
        config,
        `/interactions?path=${encodeURIComponent(entry.path)}&visitorId=${encodeURIComponent(visitorId())}`,
        { signal: activeController.signal },
      );
    } catch (error) {
      // Azure 不可用时不要留下空壳或错误占位，正文保持完整可读。
      section.remove();
      viewer.dataset.interactions = 'unavailable';
      return;
    }
    if (!section.isConnected) return;
    if (!payload.enabled) {
      section.remove();
      return;
    }

    const toolbar = element('div', 'interaction-toolbar');
    const metrics = element('div', 'interaction-metrics');
    const like = element('button', 'interaction-like');
    like.type = 'button';
    like.classList.toggle('is-active', Boolean(payload.liked));
    like.setAttribute('aria-pressed', String(Boolean(payload.liked)));
    like.append(
      element('span', 'interaction-like__mark', payload.liked ? '♥' : '♡'),
      element('span', '', `${Number(payload.likes) || 0} 赞`),
    );
    const views = element('span', 'interaction-views', `${Number(payload.views) || 0} 次阅读`);
    metrics.append(like, views);
    toolbar.append(metrics);
    section.replaceChildren(toolbar);

    let likes = Number(payload.likes) || 0;
    let liked = Boolean(payload.liked);
    like.addEventListener('click', async () => {
      like.disabled = true;
      try {
        const result = await request(config, '/reactions', {
          method: 'POST',
          body: { path: entry.path, visitorId: visitorId() },
        });
        liked = Boolean(result.liked);
        likes = Number(result.likes) || 0;
        like.classList.toggle('is-active', liked);
        like.setAttribute('aria-pressed', String(liked));
        like.replaceChildren(
          element('span', 'interaction-like__mark', liked ? '♥' : '♡'),
          element('span', '', `${likes} 赞`),
        );
      } catch (error) {
        like.title = error.message;
      } finally {
        like.disabled = false;
      }
    });

    const comments = element('div', 'comments__list');
    section.append(comments);

    async function submit(content, parentId = null, extra = {}) {
      const profile = savedProfile();
      const anonymous = Boolean(extra.anonymous);
      const body = {
        path: entry.path,
        visitorId: visitorId(),
        content,
        parentId,
        anonymous,
        nickname: anonymous ? '' : extra.nickname || profile.nickname || '',
        email: extra.email || '',
        website: extra.website || profile.website || '',
        honeypot: extra.honeypot || '',
        elapsedMs: Math.max(0, Date.now() - Number(extra.startedAt || Date.now())),
      };
      const result = await request(config, '/comments', { method: 'POST', body });
      if (!anonymous) {
        saveProfile({ nickname: body.nickname, website: body.website });
      }
      payload.comments = result.comments || payload.comments;
      renderComments(comments, payload.comments, submit);
      return result;
    }

    renderComments(comments, payload.comments || [], submit);

    const form = element('form', 'comment-form');
    const profile = savedProfile();
    const fields = element('div', 'comment-form__grid');
    const nickname = element('input', 'comment-form__input');
    nickname.name = 'nickname';
    nickname.maxLength = 30;
    nickname.placeholder = '昵称';
    nickname.value = profile.nickname || '';
    const website = element('input', 'comment-form__input');
    website.name = 'website';
    website.type = 'url';
    website.maxLength = 200;
    website.placeholder = '个人网站（可选）';
    website.value = profile.website || '';
    const email = element('input', 'comment-form__input');
    email.name = 'email';
    email.type = 'email';
    email.maxLength = 200;
    email.placeholder = '邮箱（可选，不公开）';
    fields.append(nickname, email, website);

    const anonymousLabel = element('label', 'comment-form__anonymous');
    const anonymous = document.createElement('input');
    anonymous.type = 'checkbox';
    anonymous.name = 'anonymous';
    anonymousLabel.append(anonymous, document.createTextNode(' 以匿名用户评论'));

    const honeypotWrap = element('label', 'comment-form__honeypot');
    const honeypot = document.createElement('input');
    honeypot.type = 'text';
    honeypot.name = 'company';
    honeypot.tabIndex = -1;
    honeypot.autocomplete = 'off';
    honeypotWrap.append(honeypot);

    const textarea = element('textarea', 'comment-form__textarea');
    textarea.name = 'content';
    textarea.rows = 4;
    textarea.maxLength = 2000;
    textarea.required = true;
    textarea.placeholder = '写下你的想法…';
    const actions = element('div', 'comment-form__actions');
    const status = element('span', 'comment-form__status');
    const submitButton = element('button', 'button button--primary', '发表评论');
    submitButton.type = 'submit';
    actions.append(status, submitButton);
    form.append(fields, anonymousLabel, honeypotWrap, textarea, actions);
    const startedAt = Date.now();

    anonymous.addEventListener('change', () => {
      nickname.disabled = anonymous.checked;
      email.disabled = anonymous.checked;
      website.disabled = anonymous.checked;
      if (anonymous.checked) {
        nickname.value = '';
        email.value = '';
        website.value = '';
      } else {
        nickname.value = profile.nickname || '';
        website.value = profile.website || '';
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.textContent = '';
      if (!anonymous.checked && !nickname.value.trim()) {
        status.textContent = '请填写昵称，或选择匿名用户。';
        nickname.focus();
        return;
      }
      submitButton.disabled = true;
      try {
        const result = await submit(textarea.value.trim(), null, {
          anonymous: anonymous.checked,
          nickname: nickname.value,
          email: email.value,
          website: website.value,
          honeypot: honeypot.value,
          startedAt,
        });
        textarea.value = '';
        honeypot.value = '';
        status.textContent = result.status === 'pending' ? '评论已提交，正在等待审核。' : '评论已发布。';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        submitButton.disabled = false;
      }
    });
    section.append(form);

    if (configured(config) && config.viewsEnabled !== false && markViewOnce(entry.path)) {
      request(config, '/views', {
        method: 'POST',
        body: { path: entry.path, visitorId: visitorId() },
      }).catch(() => undefined);
    }
  }

  function clear(viewer) {
    activeController?.abort();
    activeController = null;
    viewer.querySelectorAll('.comments').forEach((node) => node.remove());
  }

  function setPhase(phase) {
    currentPhase = phase;
    document.querySelectorAll('.comments').forEach((node) => {
      node.dataset.phase = phase;
    });
  }

  window.BifrostInteractions = {
    clear,
    mount,
    setPhase,
    get phase() {
      return currentPhase;
    },
  };
})();
