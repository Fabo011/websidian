/*
 * Client bundle for in-browser PDF viewing with a remembered reading position.
 *
 * Exposes `window.PdfViewer` with a single `mount(container, arrayBuffer, opts)`
 * that renders the PDF with pdf.js into a scrollable, lazily-rendered page list,
 * tracks the page the user is currently reading and reports it via `onPage` so
 * the host can persist it (encrypted, cross-device). On mount it jumps to
 * `initialPage`. Returns a controller with `resize()` (re-fit width / re-anchor
 * when the tab pane becomes visible) and `destroy()`.
 *
 * The native browser PDF viewer cannot report the current page to JavaScript,
 * which is why epub-style resume needs pdf.js. Files are fetched as opaque
 * ciphertext, decrypted in the browser and rendered entirely on the client.
 *
 * Built by esbuild into public/js/pdf-bundle.js (+ public/js/pdf-worker.js) and
 * lazy-loaded by app.js only when a PDF is opened.
 */
import * as pdfjsLib from 'pdfjs-dist';

// Cap the fit-to-width base scale so a narrow PDF is not blown up absurdly
// large before the user's zoom factor is applied on top.
const MAX_SCALE = 2.5;
// User zoom range, relative to fit-to-width (1 = fit the pane, <1 = smaller).
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z) || 1));

/**
 * Render a PDF from decrypted bytes into `container`.
 * @param {HTMLElement} container host element (emptied before mount)
 * @param {ArrayBuffer} arrayBuffer decrypted .pdf bytes
 * @param {{workerSrc?: string, initialPage?: number, onPage?: (n:number)=>void,
 *          initialZoom?: number, onZoom?: (z:number)=>void,
 *          zoomInLabel?: string, zoomOutLabel?: string}} [opts]
 * @returns {{resize: ()=>void, setZoom: (z:number)=>void, destroy: ()=>void}} controller
 */
export function mount(container, arrayBuffer, opts = {}) {
  container.innerHTML = '';
  if (opts.workerSrc && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = opts.workerSrc;
  }

  const root = document.createElement('div');
  root.className = 'pdf-viewer';

  const scroll = document.createElement('div');
  scroll.className = 'pdf-scroll';
  root.appendChild(scroll);

  // Floating zoom control (− / percentage / +). The percentage is relative to
  // fit-to-width, so 100% fills the pane and lower values shrink the page —
  // handy on a wide screen where fit-to-width is too big.
  const toolbar = document.createElement('div');
  toolbar.className = 'pdf-toolbar';
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.className = 'pdf-zoom-btn';
  zoomOut.setAttribute('aria-label', opts.zoomOutLabel || 'Zoom out');
  zoomOut.title = opts.zoomOutLabel || 'Zoom out';
  zoomOut.innerHTML = '<i class="bi bi-dash-lg"></i>';
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'pdf-zoom-label';
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.className = 'pdf-zoom-btn';
  zoomIn.setAttribute('aria-label', opts.zoomInLabel || 'Zoom in');
  zoomIn.title = opts.zoomInLabel || 'Zoom in';
  zoomIn.innerHTML = '<i class="bi bi-plus-lg"></i>';
  toolbar.append(zoomOut, zoomLabel, zoomIn);
  root.appendChild(toolbar);

  const badge = document.createElement('div');
  badge.className = 'pdf-page-badge';
  badge.hidden = true;
  root.appendChild(badge);

  container.appendChild(root);

  let pdf = null;
  let destroyed = false;
  let scale = 1;
  let zoom = clampZoom(opts.initialZoom);
  let currentPage = Math.max(1, Number(opts.initialPage) || 1);
  let baseViewport = null; // page-1 viewport at scale 1, used to size placeholders
  const wrappers = []; // one per page (index 0 = page 1)
  const rendered = new Set(); // page numbers already drawn
  const renderTasks = new Map(); // page number -> pdf.js RenderTask
  let observer = null;
  let saveTimer = null;

  const emitPage = (n) => {
    if (typeof opts.onPage === 'function') {
      try {
        opts.onPage(n);
      } catch (e) {
        /* ignore */
      }
    }
  };

  const updateBadge = () => {
    if (!pdf) return;
    badge.hidden = false;
    badge.textContent = `${currentPage} / ${pdf.numPages}`;
  };

  // Fit-to-width base scale (from the scroll area's inner width) times the
  // user's zoom factor.
  const computeScale = () => {
    if (!baseViewport) return scale || 1;
    const avail = scroll.clientWidth - 24; // account for padding
    if (avail <= 0) return scale || 1;
    const fit = Math.min(MAX_SCALE, Math.max(0.2, avail / baseViewport.width));
    return fit * zoom;
  };

  const updateZoomLabel = () => {
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
  };
  const emitZoom = () => {
    if (typeof opts.onZoom === 'function') {
      try {
        opts.onZoom(zoom);
      } catch (e) {
        /* ignore */
      }
    }
  };
  const setZoom = (z) => {
    const nz = clampZoom(z);
    if (nz === zoom) return;
    zoom = nz;
    updateZoomLabel();
    relayout();
    emitZoom();
  };
  updateZoomLabel();
  zoomOut.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
  zoomIn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
  // Ctrl/Cmd + wheel zooms, like a document viewer.
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  };

  const sizeWrapper = (wrapper) => {
    if (!baseViewport) return;
    wrapper.style.width = `${Math.floor(baseViewport.width * scale)}px`;
    wrapper.style.height = `${Math.floor(baseViewport.height * scale)}px`;
  };

  const renderPage = async (pageNum) => {
    if (destroyed || rendered.has(pageNum) || renderTasks.has(pageNum)) return;
    const wrapper = wrappers[pageNum - 1];
    if (!wrapper) return;
    let page;
    try {
      page = await pdf.getPage(pageNum);
    } catch (e) {
      return;
    }
    if (destroyed) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale });
    // Correct the placeholder to this page's real size (handles mixed sizes).
    wrapper.style.width = `${Math.floor(viewport.width)}px`;
    wrapper.style.height = `${Math.floor(viewport.height)}px`;
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const ctx = canvas.getContext('2d');
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    renderTasks.set(pageNum, task);
    try {
      await task.promise;
      if (destroyed) return;
      wrapper.innerHTML = '';
      wrapper.appendChild(canvas);
      rendered.add(pageNum);
    } catch (e) {
      /* render cancelled (scrolled away / resized) — will re-render if needed */
    } finally {
      renderTasks.delete(pageNum);
    }
  };

  const cancelRenders = () => {
    for (const task of renderTasks.values()) {
      try {
        task.cancel();
      } catch (e) {
        /* ignore */
      }
    }
    renderTasks.clear();
  };

  // Determine the page whose top sits at/above the viewport top — the one the
  // user is currently reading — and report it (debounced).
  const trackScroll = () => {
    if (destroyed || !wrappers.length) return;
    const top = scroll.scrollTop + 4;
    let page = 1;
    for (let i = 0; i < wrappers.length; i++) {
      if (wrappers[i].offsetTop <= top) page = i + 1;
      else break;
    }
    if (page !== currentPage) {
      currentPage = page;
      updateBadge();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => emitPage(currentPage), 400);
    }
  };

  const scrollToPage = (pageNum) => {
    const wrapper = wrappers[pageNum - 1];
    if (wrapper) scroll.scrollTop = wrapper.offsetTop;
  };

  const relayout = () => {
    if (destroyed || !baseViewport) return;
    scale = computeScale();
    cancelRenders();
    rendered.clear();
    for (const wrapper of wrappers) {
      wrapper.innerHTML = '';
      sizeWrapper(wrapper);
    }
    // Re-anchor to the page the user was on, then render what is visible.
    scrollToPage(currentPage);
    observeVisible();
  };

  // Render pages near the viewport now (IntersectionObserver handles the rest).
  const observeVisible = () => {
    if (!observer) return;
    for (const wrapper of wrappers) observer.observe(wrapper);
  };

  const onScroll = () => trackScroll();
  let resizeRaf = null;
  const onResize = () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(relayout);
  };

  (async () => {
    try {
      const task = pdfjsLib.getDocument({ data: arrayBuffer });
      pdf = await task.promise;
      if (destroyed) return;
      const first = await pdf.getPage(1);
      baseViewport = first.getViewport({ scale: 1 });
      scale = computeScale();

      for (let i = 1; i <= pdf.numPages; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-page';
        wrapper.dataset.page = String(i);
        sizeWrapper(wrapper);
        scroll.appendChild(wrapper);
        wrappers.push(wrapper);
      }

      // Lazily render pages as they approach the viewport.
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              renderPage(Number(entry.target.dataset.page));
            }
          }
        },
        { root: scroll, rootMargin: '200% 0px' },
      );
      observeVisible();

      scroll.addEventListener('scroll', onScroll, { passive: true });
      scroll.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('resize', onResize);

      updateBadge();
      // Jump to the remembered page once layout is settled.
      requestAnimationFrame(() => {
        if (destroyed) return;
        scrollToPage(currentPage);
        trackScroll();
      });
    } catch (e) {
      console.error('pdf preview failed:', e);
      root.innerHTML =
        '<p class="muted" style="padding:16px">' +
        (opts.errorText || 'Could not display this PDF.') +
        '</p>';
    }
  })();

  return {
    // Called by the host when the pane becomes visible (it had zero size while
    // hidden, so widths/heights and the page anchor need recomputing).
    resize() {
      if (destroyed) return;
      relayout();
    },
    setZoom,
    destroy() {
      destroyed = true;
      cancelRenders();
      if (observer) {
        try {
          observer.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
      scroll.removeEventListener('scroll', onScroll);
      scroll.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      if (saveTimer) clearTimeout(saveTimer);
      if (pdf) {
        try {
          pdf.cleanup();
          pdf.destroy();
        } catch (e) {
          /* ignore */
        }
      }
      container.innerHTML = '';
    },
  };
}

window.PdfViewer = { mount };
