/*
 * Client bundle for read-only in-browser viewing of EPUB e-books.
 *
 * Exposes `window.EpubViewer` with a single `mount(container, arrayBuffer, opts)`
 * that renders a paginated reader (previous / next controls + arrow keys) and
 * returns a controller whose `destroy()` tears the reader down. Built by esbuild
 * into public/js/epub-bundle.js and lazy-loaded by app.js only when needed.
 *
 * Files are fetched from /api/attachment (opaque ciphertext), decrypted in the
 * browser and rendered entirely on the client (epub.js); nothing is uploaded.
 */
import ePub from 'epubjs';

/**
 * Render an EPUB from decrypted bytes into `container`.
 * @param {HTMLElement} container host element (emptied before mount)
 * @param {ArrayBuffer} arrayBuffer decrypted .epub bytes
 * @param {{prevLabel?: string, nextLabel?: string, locationKey?: string}} [opts]
 *        localized labels and a stable key used to remember the reading spot
 * @returns {{destroy: () => void}} controller
 */
export function mount(container, arrayBuffer, opts = {}) {
  container.innerHTML = '';

  // Persist the reading position (an EPUB CFI) per book so reopening or
  // reloading the app returns the reader to the last page. Kept in
  // localStorage: it is a location pointer, not book content.
  const storeKey = opts.locationKey ? 'wo-epub-loc:' + opts.locationKey : null;
  const loadLocation = () => {
    if (!storeKey) return null;
    try {
      return localStorage.getItem(storeKey) || null;
    } catch (e) {
      return null;
    }
  };
  const saveLocation = (cfi) => {
    if (!storeKey || !cfi) return;
    try {
      localStorage.setItem(storeKey, cfi);
    } catch (e) {
      /* storage full or blocked — position is best-effort */
    }
  };

  const root = document.createElement('div');
  root.className = 'epub-reader';
  root.tabIndex = 0;

  const area = document.createElement('div');
  area.className = 'epub-area';
  root.appendChild(area);

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'epub-nav epub-prev';
  prev.setAttribute('aria-label', opts.prevLabel || 'Previous page');
  prev.innerHTML = '<i class="bi bi-chevron-left"></i>';

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'epub-nav epub-next';
  next.setAttribute('aria-label', opts.nextLabel || 'Next page');
  next.innerHTML = '<i class="bi bi-chevron-right"></i>';

  root.appendChild(prev);
  root.appendChild(next);
  container.appendChild(root);

  const book = ePub(arrayBuffer);
  const rendition = book.renderTo(area, {
    width: '100%',
    height: '100%',
    spread: 'auto',
    allowScriptedContent: false,
  });

  // Book pages carry their own CSS — almost always dark text meant for a white
  // page. Over the app's dark viewer background that text is invisible, so we
  // always render the book on a bright "paper" page (white background, dark
  // text) regardless of the app's light/dark theme, like a dedicated reader.
  function applyTheme() {
    rendition.themes.register('wo', {
      body: {
        background: '#ffffff !important',
        color: '#1a1a1a !important',
      },
      'p, div, span, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, figcaption':
        { color: '#1a1a1a !important' },
      'a, a *': { color: '#3b5bdb !important' },
    });
    rendition.themes.select('wo');
  }

  // Restore the saved page once the book's spine is parsed; displaying a CFI
  // before `book.ready` silently falls back to page one. `restored` guards the
  // relocated handler so the initial render can't clobber the stored position.
  let restored = false;
  book.ready
    .then(() => rendition.display(loadLocation() || undefined))
    .then(() => {
      restored = true;
      applyTheme();
    });

  // epub.js fires `relocated` on every page turn with the current CFI.
  rendition.on('relocated', (location) => {
    if (!restored) return;
    if (location && location.start) saveLocation(location.start.cfi);
  });

  const goPrev = () => rendition.prev();
  const goNext = () => rendition.next();
  prev.addEventListener('click', goPrev);
  next.addEventListener('click', goNext);

  const onKey = (e) => {
    const key = e.key || (e.detail && e.detail.key);
    if (key === 'ArrowLeft') goPrev();
    else if (key === 'ArrowRight') goNext();
  };
  root.addEventListener('keydown', onKey);
  // Book content lives inside an iframe, so also listen for keys forwarded by
  // epub.js from the rendered document.
  rendition.on('keydown', onKey);

  return {
    destroy() {
      root.removeEventListener('keydown', onKey);
      try {
        rendition.destroy();
      } catch (e) {
        /* ignore */
      }
      try {
        book.destroy();
      } catch (e) {
        /* ignore */
      }
    },
  };
}

window.EpubViewer = { mount };
