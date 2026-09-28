// 正文图片预览：原生 dialog，不依赖前端框架。
(() => {
  const EXCLUDED_SELECTOR = [
    '[data-preview-skip]',
    '.comment__avatar',
    '.video-card__cover',
    '.video-card__placeholder',
    '.publication-card__cover',
    '.publication-reader__page',
    '.media-preview__image',
  ].join(',');

  let dialog = null;
  let imageNode = null;
  let captionNode = null;
  let counterNode = null;
  let previousButton = null;
  let nextButton = null;
  let viewer = null;
  let images = [];
  let currentIndex = 0;
  let touchStartX = 0;

  function createDialog() {
    if (dialog) {
      return dialog;
    }

    dialog = document.createElement('dialog');
    dialog.className = 'media-preview';
    dialog.setAttribute('aria-label', '图片预览');
    dialog.innerHTML = `
      <div class="media-preview__frame">
        <button class="media-preview__close" type="button" data-media-close aria-label="关闭预览">关闭</button>
        <button class="media-preview__nav media-preview__nav--prev" type="button" data-media-prev aria-label="上一张">←</button>
        <figure class="media-preview__figure">
          <img class="media-preview__image" alt="" decoding="async">
          <figcaption class="media-preview__caption"></figcaption>
        </figure>
        <button class="media-preview__nav media-preview__nav--next" type="button" data-media-next aria-label="下一张">→</button>
        <span class="media-preview__counter" aria-live="polite"></span>
      </div>
    `;
    document.body.appendChild(dialog);

    imageNode = dialog.querySelector('.media-preview__image');
    captionNode = dialog.querySelector('.media-preview__caption');
    counterNode = dialog.querySelector('.media-preview__counter');
    previousButton = dialog.querySelector('[data-media-prev]');
    nextButton = dialog.querySelector('[data-media-next]');

    dialog.querySelector('[data-media-close]').addEventListener('click', close);
    previousButton.addEventListener('click', () => move(-1));
    nextButton.addEventListener('click', () => move(1));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        close();
      }
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        move(1);
      }
    });
    dialog.addEventListener('touchstart', (event) => {
      touchStartX = event.changedTouches[0]?.clientX || 0;
    }, { passive: true });
    dialog.addEventListener('touchend', (event) => {
      const delta = (event.changedTouches[0]?.clientX || 0) - touchStartX;
      if (Math.abs(delta) > 50) {
        move(delta > 0 ? -1 : 1);
      }
    }, { passive: true });

    return dialog;
  }

  function markImage(image) {
    if (!(image instanceof HTMLImageElement) || image.matches(EXCLUDED_SELECTOR)) {
      return;
    }
    image.classList.add('media-preview-trigger');
    image.dataset.previewReady = 'true';
    if (!image.hasAttribute('tabindex')) {
      image.tabIndex = 0;
    }
    if (!image.hasAttribute('role')) {
      image.setAttribute('role', 'button');
    }
    if (!image.hasAttribute('aria-label')) {
      image.setAttribute('aria-label', `${image.alt || '正文图片'}，点击放大`);
    }

    const applyShape = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height) {
        return;
      }
      const ratio = height / width;
      let shape = 'landscape';
      if (ratio > 2.25) {
        shape = 'long';
      } else if (ratio > 1.12) {
        shape = 'portrait';
      }
      image.dataset.imageShape = shape;
      image.closest('figure')?.setAttribute('data-image-shape', shape);
    };

    if (image.complete) {
      applyShape();
    } else {
      image.addEventListener('load', applyShape, { once: true });
    }
  }

  function collectImages() {
    if (!viewer) {
      return [];
    }
    return Array.from(viewer.querySelectorAll('img')).filter((image) => {
      if (!(image instanceof HTMLImageElement) || image.matches(EXCLUDED_SELECTOR)) {
        return false;
      }
      return !image.closest('.comments, .video-card, .publication-card, .publication-reader, .history-comments');
    });
  }

  function renderCurrent() {
    if (!dialog || !images.length) {
      return;
    }
    currentIndex = Math.max(0, Math.min(currentIndex, images.length - 1));
    const image = images[currentIndex];
    const source = image.currentSrc || image.src;
    imageNode.src = source;
    imageNode.alt = image.alt || '';
    captionNode.textContent = image.alt || `图片 ${currentIndex + 1}`;
    counterNode.textContent = `${currentIndex + 1} / ${images.length}`;
    previousButton.disabled = images.length < 2;
    nextButton.disabled = images.length < 2;
  }

  function move(delta) {
    if (!images.length) {
      return;
    }
    currentIndex = (currentIndex + delta + images.length) % images.length;
    renderCurrent();
  }

  function open(image) {
    createDialog();
    images = collectImages();
    currentIndex = Math.max(0, images.indexOf(image));
    if (!images.length) {
      return;
    }
    renderCurrent();
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    dialog.focus();
  }

  function close() {
    if (!dialog) {
      return;
    }
    if (typeof dialog.close === 'function' && dialog.open) {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    imageNode?.removeAttribute('src');
  }

  function mount(nextViewer) {
    if (!(nextViewer instanceof Element)) {
      return;
    }
    viewer = nextViewer;
    viewer.querySelectorAll('img').forEach(markImage);

    if (!viewer.dataset.mediaPreviewBound) {
      viewer.dataset.mediaPreviewBound = 'true';
      viewer.addEventListener('click', (event) => {
        const image = event.target.closest('img.media-preview-trigger');
        if (image) {
          event.preventDefault();
          open(image);
        }
      });
      viewer.addEventListener('keydown', (event) => {
        const image = event.target.closest('img.media-preview-trigger');
        if (image && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          open(image);
        }
      });
    }
  }

  function refresh() {
    if (viewer) {
      viewer.querySelectorAll('img').forEach(markImage);
    }
  }

  function clear() {
    close();
    images = [];
    viewer = null;
  }

  window.BifrostMediaPreview = {
    clear,
    close,
    mount,
    refresh,
  };
})();
