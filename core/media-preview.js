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
  const zoom = { scale: 1, x: 0, y: 0 };
  let dragging = null;
  let zoomLabel = null;

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
        <div class="media-preview__toolbar" role="group" aria-label="缩放">
          <button class="media-preview__tool" type="button" data-media-zoom-out aria-label="缩小">−</button>
          <button class="media-preview__tool media-preview__tool--label" type="button" data-media-zoom-reset aria-label="重置缩放">100%</button>
          <button class="media-preview__tool" type="button" data-media-zoom-in aria-label="放大">＋</button>
        </div>
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
    zoomLabel = dialog.querySelector('[data-media-zoom-reset]');
    dialog.querySelector('[data-media-zoom-in]').addEventListener('click', () => zoomBy(1.4));
    dialog.querySelector('[data-media-zoom-out]').addEventListener('click', () => zoomBy(1 / 1.4));
    zoomLabel.addEventListener('click', () => resetZoom());
    imageNode.addEventListener('dblclick', () => {
      if (zoom.scale > 1) {
        resetZoom();
      } else {
        setZoom(2.4);
      }
    });
    imageNode.addEventListener('wheel', onWheel, { passive: false });
    imageNode.addEventListener('pointerdown', onPointerDown);
    imageNode.addEventListener('pointermove', onPointerMove);
    imageNode.addEventListener('pointerup', onPointerUp);
    imageNode.addEventListener('pointercancel', onPointerUp);
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
      // 放大状态下横向拖动用于平移画面，不触发上一张 / 下一张。
      if (zoom.scale > 1) {
        return;
      }
      const delta = (event.changedTouches[0]?.clientX || 0) - touchStartX;
      if (Math.abs(delta) > 50) {
        move(delta > 0 ? -1 : 1);
      }
    }, { passive: true });

    return dialog;
  }

  /**
   * 只有正文里的图片可以放大：卡片封面、评论区、视频卡片等一律排除，
   * 否则点卡片封面会既跳转又弹出预览。
   */
  function previewable(image) {
    if (!(image instanceof HTMLImageElement)) return false;
    if (image.matches(EXCLUDED_SELECTOR)) return false;
    if (!image.closest('.article-surface')) return false;
    if (image.closest('.comments, .video-card, .publication-card, .publication-reader, .history-comments')) return false;
    return true;
  }

  function markImage(image) {
    if (!previewable(image)) {
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
      if (width / height > 2.4) {
        shape = 'panorama';
      } else if (ratio > 2.25) {
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
    return Array.from(viewer.querySelectorAll('img')).filter(previewable);
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
    resetZoom();
  }

  function applyZoom() {
    if (!imageNode) {
      return;
    }
    imageNode.style.transform = zoom.scale === 1
      ? ''
      : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
    imageNode.classList.toggle('is-zoomed', zoom.scale > 1);
    dialog?.classList.toggle('is-zoomed', zoom.scale > 1);
    if (zoomLabel) {
      zoomLabel.textContent = `${Math.round(zoom.scale * 100)}%`;
    }
  }

  function resetZoom() {
    zoom.scale = 1;
    zoom.x = 0;
    zoom.y = 0;
    applyZoom();
  }

  function clampPan() {
    if (!imageNode || zoom.scale <= 1) {
      zoom.x = 0;
      zoom.y = 0;
      return;
    }
    const frame = dialog?.querySelector('.media-preview__frame');
    const frameWidth = frame?.clientWidth || window.innerWidth;
    const frameHeight = frame?.clientHeight || window.innerHeight;
    const overflowX = Math.max(0, (imageNode.offsetWidth * zoom.scale - frameWidth) / 2);
    const overflowY = Math.max(0, (imageNode.offsetHeight * zoom.scale - frameHeight) / 2);
    zoom.x = Math.max(-overflowX, Math.min(overflowX, zoom.x));
    zoom.y = Math.max(-overflowY, Math.min(overflowY, zoom.y));
  }

  function setZoom(next, origin) {
    if (!imageNode) {
      return;
    }
    const clamped = Math.max(1, Math.min(6, next));
    const ratio = clamped / zoom.scale;
    if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
      // 以指针位置为原点缩放：先把旧偏移拉到指针处，再按比例外推。
      zoom.x = origin.x - (origin.x - zoom.x) * ratio;
      zoom.y = origin.y - (origin.y - zoom.y) * ratio;
    }
    zoom.scale = clamped;
    clampPan();
    applyZoom();
  }

  function zoomBy(factor, origin) {
    setZoom(zoom.scale * factor, origin);
  }

  function onWheel(event) {
    if (!dialog?.open && !dialog?.hasAttribute('open')) {
      return;
    }
    event.preventDefault();
    const rect = imageNode.getBoundingClientRect();
    const origin = {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    };
    zoomBy(event.deltaY < 0 ? 1.18 : 1 / 1.18, origin);
  }

  function onPointerDown(event) {
    if (zoom.scale <= 1 || event.button !== 0) {
      return;
    }
    dragging = { x: event.clientX, y: event.clientY, startX: zoom.x, startY: zoom.y };
    imageNode.setPointerCapture?.(event.pointerId);
    imageNode.classList.add('is-dragging');
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!dragging) {
      return;
    }
    zoom.x = dragging.startX + (event.clientX - dragging.x);
    zoom.y = dragging.startY + (event.clientY - dragging.y);
    clampPan();
    applyZoom();
  }

  function onPointerUp(event) {
    if (!dragging) {
      return;
    }
    imageNode.releasePointerCapture?.(event.pointerId);
    imageNode.classList.remove('is-dragging');
    dragging = null;
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
