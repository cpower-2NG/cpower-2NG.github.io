// PDF 出版物的横向阅读器。桌面对页，手机单页。
(() => {
  const state = {
    dialog: null,
    currentUrl: '',
    publication: null,
    positions: [],
    currentPosition: 0,
    mobile: false,
    touchStartX: 0,
    zoom: 1,
  };
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const cache = new Map();

  function isMobile() {
    return window.matchMedia('(max-width: 720px)').matches;
  }

  function createDialog() {
    if (state.dialog) {
      return state.dialog;
    }
    const dialog = document.createElement('dialog');
    dialog.className = 'publication-reader';
    dialog.setAttribute('aria-label', 'PDF 横向阅读器');
    dialog.innerHTML = `
      <div class="publication-reader__shell">
        <header class="publication-reader__header">
          <div>
            <p class="hero__eyebrow">PDF READER</p>
            <h2 data-reader-title>出版阅读</h2>
          </div>
          <div class="publication-reader__status">
            <span data-reader-counter></span>
            <span class="publication-reader__zoom" role="group" aria-label="缩放">
              <button class="publication-reader__tool" type="button" data-reader-zoom-out aria-label="缩小">−</button>
              <button class="publication-reader__tool publication-reader__tool--label" type="button" data-reader-zoom-reset aria-label="重置缩放">适应</button>
              <button class="publication-reader__tool" type="button" data-reader-zoom-in aria-label="放大">＋</button>
            </span>
            <button class="publication-reader__close" type="button" data-reader-close aria-label="关闭阅读器">关闭</button>
          </div>
        </header>
        <div class="publication-reader__stage" data-reader-stage>
          <button class="publication-reader__nav publication-reader__nav--prev" type="button" data-reader-prev aria-label="上一组">←</button>
          <div class="publication-reader__pages" data-reader-pages></div>
          <button class="publication-reader__nav publication-reader__nav--next" type="button" data-reader-next aria-label="下一组">→</button>
        </div>
        <footer class="publication-reader__footer">
          <p>桌面为对页阅读；窄屏自动切换为单页横向滑动。方向键或左右滑动可翻页，可用缩放按钮或双击放大细看。</p>
          <a class="button" data-reader-download href="#" target="_blank" rel="noopener">下载原 PDF</a>
        </footer>
      </div>
    `;
    document.body.appendChild(dialog);

    dialog.querySelector('[data-reader-close]').addEventListener('click', close);
    dialog.querySelector('[data-reader-prev]').addEventListener('click', () => move(-1));
    dialog.querySelector('[data-reader-next]').addEventListener('click', () => move(1));
    dialog.querySelector('[data-reader-zoom-in]').addEventListener('click', () => setZoom(state.zoom * 1.35));
    dialog.querySelector('[data-reader-zoom-out]').addEventListener('click', () => setZoom(state.zoom / 1.35));
    dialog.querySelector('[data-reader-zoom-reset]').addEventListener('click', () => setZoom(1));
    dialog.querySelector('[data-reader-pages]').addEventListener('dblclick', () => {
      setZoom(state.zoom > 1 ? 1 : 2.2);
    });
    dialog.addEventListener('wheel', (event) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      event.preventDefault();
      setZoom(state.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
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
    const stage = dialog.querySelector('[data-reader-stage]');
    stage.addEventListener('touchstart', (event) => {
      state.touchStartX = event.changedTouches[0]?.clientX || 0;
    }, { passive: true });
    stage.addEventListener('touchend', (event) => {
      // 放大后横向拖动用于滚动查看，不翻页。
      if (state.zoom > 1.001) {
        return;
      }
      const delta = (event.changedTouches[0]?.clientX || 0) - state.touchStartX;
      if (Math.abs(delta) > 50) {
        move(delta > 0 ? -1 : 1);
      }
    }, { passive: true });

    window.addEventListener('resize', () => {
      if (!dialog.open) {
        return;
      }
      rebuildPositions();
      render();
    });
    state.dialog = dialog;
    return dialog;
  }

  async function load(url) {
    if (cache.has(url)) {
      return cache.get(url);
    }
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`出版物数据加载失败（HTTP ${response.status}）`);
    }
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.pages) || !payload.pages.length) {
      throw new Error('出版物没有可用页面。');
    }
    cache.set(url, payload);
    return payload;
  }

  function rebuildPositions() {
    const pages = state.publication?.pages || [];
    state.mobile = isMobile();
    if (state.mobile) {
      state.positions = pages.map((_page, index) => [index]);
      return;
    }
    state.positions = pages.length ? [[0]] : [];
    for (let index = 1; index < pages.length; index += 2) {
      state.positions.push([index, index + 1].filter((pageIndex) => pageIndex < pages.length));
    }
  }

  function preload(index) {
    const page = state.publication?.pages?.[index];
    if (!page) {
      return;
    }
    const image = new Image();
    image.decoding = 'async';
    image.src = page.src;
  }

  function render() {
    if (!state.dialog || !state.publication) {
      return;
    }
    const positions = state.positions;
    state.currentPosition = Math.max(0, Math.min(state.currentPosition, positions.length - 1));
    const position = positions[state.currentPosition] || [];
    const pages = position.map((index) => state.publication.pages[index]).filter(Boolean);
    const host = state.dialog.querySelector('[data-reader-pages]');
    host.replaceChildren();
    pages.forEach((page) => {
      const image = document.createElement('img');
      image.className = 'publication-reader__page';
      image.src = page.src;
      image.alt = `第 ${page.number} 页`;
      image.width = page.width || '';
      image.height = page.height || '';
      image.loading = 'eager';
      image.decoding = 'async';
      image.dataset.previewSkip = 'true';
      host.append(image);
    });

    const first = pages[0]?.number || 1;
    const last = pages.at(-1)?.number || first;
    state.dialog.querySelector('[data-reader-counter]').textContent = first === last
      ? `${first} / ${state.publication.pages.length}`
      : `${first}–${last} / ${state.publication.pages.length}`;
    state.dialog.querySelector('[data-reader-prev]').disabled = state.currentPosition === 0;
    state.dialog.querySelector('[data-reader-next]').disabled = state.currentPosition >= positions.length - 1;
    state.dialog.querySelector('[data-reader-stage]').dataset.spread = String(!state.mobile && pages.length > 1);
    state.dialog.classList.toggle('is-mobile', state.mobile);
    applyZoom();

    const nextIndex = positions[state.currentPosition + 1]?.[0];
    if (Number.isInteger(nextIndex)) {
      preload(nextIndex);
    }
  }

  // 缩放只改变页面高度：适应屏幕时为 1，放大后舞台可滚动查看细节。
  function applyZoom() {
    if (!state.dialog) {
      return;
    }
    const pages = state.dialog.querySelector('[data-reader-pages]');
    const stage = state.dialog.querySelector('[data-reader-stage]');
    const label = state.dialog.querySelector('[data-reader-zoom-reset]');
    pages.style.setProperty('--reader-zoom', String(state.zoom));
    stage.dataset.zoomed = String(state.zoom > 1.001);
    if (label) {
      label.textContent = state.zoom > 1.001 ? `${Math.round(state.zoom * 100)}%` : '适应';
    }
    const zoomOut = state.dialog.querySelector('[data-reader-zoom-out]');
    const zoomIn = state.dialog.querySelector('[data-reader-zoom-in]');
    if (zoomOut) zoomOut.disabled = state.zoom <= ZOOM_MIN + 0.001;
    if (zoomIn) zoomIn.disabled = state.zoom >= ZOOM_MAX - 0.001;
  }

  function setZoom(next) {
    state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    applyZoom();
  }

  function move(delta) {
    if (!state.positions.length) {
      return;
    }
    state.currentPosition = Math.max(0, Math.min(state.currentPosition + delta, state.positions.length - 1));
    state.zoom = 1;
    state.dialog?.querySelector('[data-reader-stage]')?.scrollTo({ top: 0, left: 0 });
    render();
  }

  async function openFromButton(button) {
    const url = button?.dataset.publicationUrl;
    if (!url) {
      return;
    }
    const dialog = createDialog();
    button.disabled = true;
    try {
      const publication = await load(url);
      state.currentUrl = url;
      state.publication = publication;
      state.currentPosition = 0;
      state.zoom = 1;
      rebuildPositions();
      dialog.querySelector('[data-reader-title]').textContent = publication.title || button.dataset.publicationTitle || '出版阅读';
      const download = dialog.querySelector('[data-reader-download]');
      download.href = publication.pdfUrl || '#';
      download.hidden = !publication.pdfUrl;
      render();
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      dialog.focus();
    } catch (error) {
      window.alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function close() {
    if (!state.dialog) {
      return;
    }
    if (typeof state.dialog.close === 'function' && state.dialog.open) {
      state.dialog.close();
    } else {
      state.dialog.removeAttribute('open');
    }
  }

  function mount(viewer) {
    if (!(viewer instanceof Element)) {
      return;
    }
    if (!viewer.dataset.publicationReaderBound) {
      viewer.dataset.publicationReaderBound = 'true';
      viewer.addEventListener('click', (event) => {
        const button = event.target.closest('[data-publication-reader]');
        if (button) {
          event.preventDefault();
          openFromButton(button);
        }
      });
    }
  }

  function openFromViewer(viewer) {
    const button = viewer?.querySelector('[data-publication-reader]');
    if (button) {
      openFromButton(button);
    }
  }

  function clear() {
    close();
  }

  window.BifrostPublicationReader = {
    clear,
    mount,
    openFromViewer,
  };
})();
