'use strict';

/**
 * Resumable, chunked folder uploader for websidian.
 *
 * Folders (potentially several GB across many files) are uploaded through the
 * tus protocol (@uppy/tus) so every HTTP request stays well under Cloudflare's
 * 100 MB body limit: each file is sent in 50 MB chunks. The original folder
 * structure is preserved by sending each file's relative path as tus metadata.
 *
 * End-to-end encryption is kept: every file is encrypted in the browser with the
 * vault key BEFORE the first chunk leaves, so the server only ever sees opaque
 * ciphertext. Encryption is deterministic (see WOCrypto.encryptBytesDeterministic)
 * so a refresh / dropped connection can resume from the exact stored offset
 * instead of restarting at 0.
 *
 * Bundled with esbuild into /public/js/upload-bundle.js, exposing `window.WOUpload`.
 */

const Uppy = require('@uppy/core').default || require('@uppy/core').Uppy;
const Tus = require('@uppy/tus').default || require('@uppy/tus');

/* --------------------------- junk-file filter -------------------------- */

// Build a matcher from the server-provided glob patterns (window.__WO_UPLOAD_EXCLUDE__,
// set from UPLOAD_EXCLUDE_PATTERNS). Mirrors src/common/upload-exclude.ts so the
// browser skips OS junk (macOS ._*, .DS_Store, Thumbs.db, …) before queueing;
// the server enforces the same list as the authoritative guard.
function buildExcludeMatcher(patterns) {
  const regexps = (patterns || []).map((p) => {
    const escaped = String(p)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
  });
  return (path) => {
    const leaf = String(path).split('/').pop() || '';
    return regexps.some((re) => re.test(leaf));
  };
}

const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB — one chunk per request, < 100 MB.
const CONCURRENCY = 3; // parallel files, so we don't hammer the proxy.
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10000]; // auto-retry network errors.
// How many files we keep encrypted-and-added to Uppy at once. Bounds browser
// memory: only this many ciphertext Blobs exist simultaneously, regardless of
// how many thousands of files the folder holds.
const WINDOW = 6;
const ROW_H = 46; // px, fixed row height for the virtualized list.

/* ----------------------------- formatting ------------------------------ */

function fmtBytes(n) {
  if (!n && n !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  return `${fmtBytes(bytesPerSec)}/s`;
}

function fmtEta(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/* ------------------------------- styles -------------------------------- */

const STYLE_ID = 'wo-up-style';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  // Uses the app's theme custom properties (defined in public/css/style.css for
  // both :root[data-theme='light'] and 'dark') so the panel matches whichever
  // theme is active. Fallbacks are light-theme values for safety.
  const css = `
.wo-up-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;
  align-items:center;justify-content:center;z-index:1000}
.wo-up-panel{background:var(--bg-elevated,#fff);color:var(--text,#2e3338);
  width:min(720px,94vw);max-height:88vh;display:flex;flex-direction:column;
  border:1px solid var(--border,#e1e3e8);border-radius:10px;
  box-shadow:0 12px 40px var(--shadow,rgba(0,0,0,.25));overflow:hidden}
.wo-up-head{display:flex;align-items:center;gap:.6rem;padding:.9rem 1.1rem;
  border-bottom:1px solid var(--border,#e1e3e8)}
.wo-up-head h3{margin:0;font-size:1.05rem;flex:1;color:var(--text,#2e3338)}
.wo-up-close{background:none;border:none;cursor:pointer;font-size:1.1rem;color:var(--text,#2e3338)}
.wo-up-agg{padding:.9rem 1.1rem;border-bottom:1px solid var(--border,#e1e3e8)}
.wo-up-bar{height:10px;border-radius:6px;background:var(--bg-alt,#eef0f3);overflow:hidden;margin:.5rem 0}
.wo-up-bar>i{display:block;height:100%;width:0;background:var(--accent,#6c5ce7);transition:width .25s}
.wo-up-aggmeta{display:flex;flex-wrap:wrap;gap:.4rem 1rem;font-size:.82rem;color:var(--text-muted,#6b7280)}
.wo-up-ctrls{display:flex;gap:.4rem;flex-wrap:wrap;padding:.6rem 1.1rem;
  border-bottom:1px solid var(--border,#e1e3e8)}
.wo-up-ctrls button{font:inherit;font-size:.82rem;padding:.3rem .7rem;border-radius:6px;
  border:1px solid var(--border,#ccc);background:var(--bg-alt,#f6f7f9);color:var(--text,#2e3338);cursor:pointer}
.wo-up-ctrls button:hover:not(:disabled){border-color:var(--accent,#6c5ce7)}
.wo-up-ctrls button:disabled{opacity:.45;cursor:default}
.wo-up-list{flex:1;overflow-y:auto;position:relative}
.wo-up-spacer{position:relative;width:100%}
.wo-up-row{position:absolute;left:0;right:0;height:${ROW_H}px;display:flex;align-items:center;
  gap:.6rem;padding:0 1.1rem;box-sizing:border-box;border-bottom:1px solid var(--border,#eef0f3);
  color:var(--text,#2e3338)}
.wo-up-row .p{flex:1;min-width:0;overflow:hidden}
.wo-up-row .path{font-size:.84rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text,#2e3338)}
.wo-up-row .sub{font-size:.72rem;color:var(--text-muted,#6b7280);display:flex;gap:.6rem}
.wo-up-rbar{height:5px;border-radius:4px;background:var(--bg-alt,#eef0f3);overflow:hidden;margin-top:.2rem}
.wo-up-rbar>i{display:block;height:100%;width:0;background:var(--accent,#6c5ce7)}
.wo-up-st{font-size:.72rem;width:84px;text-align:right;flex:none;color:var(--text-muted,#6b7280)}
.wo-up-st.err{color:var(--danger,#d63b30)}
.wo-up-st.ok{color:#3fb950}
.wo-up-act{display:flex;gap:.25rem;flex:none}
.wo-up-act button{background:none;border:none;cursor:pointer;color:var(--text,#2e3338);font-size:.95rem;opacity:.7}
.wo-up-act button:hover{opacity:1;color:var(--accent,#6c5ce7)}
.wo-up-foot{padding:.7rem 1.1rem;border-top:1px solid var(--border,#e1e3e8);font-size:.85rem;color:var(--text,#2e3338)}
.wo-up-foot.err{color:var(--danger,#d63b30)}`;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

/* ------------------------------- panel --------------------------------- */

// Build the progress overlay. Returns a controller the uploader drives.
function buildPanel(t, handlers) {
  ensureStyle();
  const tr = (k, p) => (typeof t === 'function' ? t(k, p) : k);

  const overlay = document.createElement('div');
  overlay.className = 'wo-up-overlay';
  overlay.innerHTML = `
    <div class="wo-up-panel" role="dialog" aria-modal="true">
      <div class="wo-up-head">
        <i class="bi bi-cloud-arrow-up"></i>
        <h3>${tr('up_title')}</h3>
        <button class="wo-up-close" title="${tr('close')}" aria-label="${tr('close')}">
          <i class="bi bi-x-lg"></i></button>
      </div>
      <div class="wo-up-agg">
        <div class="wo-up-bar"><i data-agg-bar></i></div>
        <div class="wo-up-aggmeta">
          <span data-agg-pct>0%</span>
          <span data-agg-bytes></span>
          <span data-agg-files></span>
          <span data-agg-eta></span>
        </div>
      </div>
      <div class="wo-up-ctrls">
        <button data-c="pause">${tr('up_pause_all')}</button>
        <button data-c="resume">${tr('up_resume_all')}</button>
        <button data-c="retry">${tr('up_retry_all')}</button>
        <button data-c="cancel">${tr('up_cancel_all')}</button>
      </div>
      <div class="wo-up-list"><div class="wo-up-spacer"></div></div>
      <div class="wo-up-foot" data-foot></div>
    </div>`;
  document.body.appendChild(overlay);

  const q = (s) => overlay.querySelector(s);
  const listEl = q('.wo-up-list');
  const spacer = q('.wo-up-spacer');
  const els = {
    aggBar: q('[data-agg-bar]'),
    aggPct: q('[data-agg-pct]'),
    aggBytes: q('[data-agg-bytes]'),
    aggFiles: q('[data-agg-files]'),
    aggEta: q('[data-agg-eta]'),
    foot: q('[data-foot]'),
  };

  q('.wo-up-close').addEventListener('click', () => handlers.onClose());
  overlay.querySelectorAll('.wo-up-ctrls button').forEach((b) => {
    b.addEventListener('click', () => handlers.onCtrl(b.dataset.c));
  });

  // ----- virtualized row rendering -----
  let items = [];
  const statusText = (it) => {
    const map = {
      queued: 'up_status_queued',
      uploading: 'up_status_uploading',
      paused: 'up_status_paused',
      complete: 'up_status_complete',
      error: 'up_status_error',
      retrying: 'up_status_retrying',
      resuming: 'up_status_resuming',
    };
    return tr(map[it.status] || 'up_status_queued');
  };

  function rowActions(it) {
    if (it.status === 'complete') return '';
    if (it.status === 'error') {
      return `<button data-a="retry" title="${tr('up_retry')}"><i class="bi bi-arrow-clockwise"></i></button>`;
    }
    const pr =
      it.status === 'paused'
        ? `<button data-a="resume" title="${tr('up_resume')}"><i class="bi bi-play-fill"></i></button>`
        : `<button data-a="pause" title="${tr('up_pause')}"><i class="bi bi-pause-fill"></i></button>`;
    return `${pr}<button data-a="cancel" title="${tr('up_cancel')}"><i class="bi bi-x-lg"></i></button>`;
  }

  const rowPool = new Map(); // index -> element
  function renderRow(el, idx) {
    const it = items[idx];
    el.style.top = `${idx * ROW_H}px`;
    el.dataset.idx = idx;
    const pct = Math.round(it.pct || 0);
    const stCls =
      it.status === 'error' ? 'err' : it.status === 'complete' ? 'ok' : '';
    const sub =
      it.status === 'uploading' || it.status === 'resuming'
        ? `<span>${fmtSpeed(it.speed)}</span><span>${fmtEta(it.eta)}</span>`
        : `<span>${fmtBytes(it.size)}</span>`;
    el.innerHTML = `
      <div class="p">
        <div class="path" title="${it.rel}">${it.rel}</div>
        <div class="sub">${sub}</div>
        <div class="wo-up-rbar"><i style="width:${pct}%"></i></div>
      </div>
      <div class="wo-up-st ${stCls}">${statusText(it)}${
        it.status === 'uploading' ? ` ${pct}%` : ''
      }</div>
      <div class="wo-up-act">${rowActions(it)}</div>`;
    el.querySelectorAll('.wo-up-act button').forEach((b) => {
      b.onclick = () => handlers.onRow(b.dataset.a, it);
    });
  }

  function renderVisible() {
    const scrollTop = listEl.scrollTop;
    const h = listEl.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
    const last = Math.min(items.length - 1, Math.ceil((scrollTop + h) / ROW_H) + 4);
    // Drop rows out of range.
    for (const [idx, el] of rowPool) {
      if (idx < first || idx > last) {
        el.remove();
        rowPool.delete(idx);
      }
    }
    for (let i = first; i <= last; i++) {
      let el = rowPool.get(i);
      if (!el) {
        el = document.createElement('div');
        el.className = 'wo-up-row';
        spacer.appendChild(el);
        rowPool.set(i, el);
      }
      renderRow(el, i);
    }
  }
  listEl.addEventListener('scroll', renderVisible);

  let raf = 0;
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderVisible();
    });
  }

  return {
    overlay,
    setItems(list) {
      items = list;
      spacer.style.height = `${items.length * ROW_H}px`;
      rowPool.forEach((el) => el.remove());
      rowPool.clear();
      renderVisible();
    },
    // Re-render only the row for one item (cheap) plus the aggregate.
    touch() {
      scheduleRender();
    },
    setAggregate(a) {
      els.aggBar.style.width = `${a.pct}%`;
      els.aggPct.textContent = `${Math.round(a.pct)}%`;
      els.aggBytes.textContent = `${fmtBytes(a.uploaded)} / ${fmtBytes(a.total)}`;
      els.aggFiles.textContent = tr('up_files_count', {
        done: a.done,
        total: a.count,
      });
      els.aggEta.textContent = a.eta ? `${tr('up_eta')} ${fmtEta(a.eta)}` : '';
    },
    setFooter(html, isErr) {
      els.foot.innerHTML = html;
      els.foot.classList.toggle('err', !!isErr);
    },
    setControlEnabled(name, on) {
      const b = overlay.querySelector(`.wo-up-ctrls button[data-c="${name}"]`);
      if (b) b.disabled = !on;
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      overlay.remove();
    },
  };
}

/* ------------------------------ uploader ------------------------------- */

/**
 * Start uploading a folder selection.
 * @param {Object} opts
 * @param {Array<{file: File, relativePath: string}>} opts.entries  files + their
 *        relative paths (path INCLUDES the filename, forward slashes).
 * @param {string} opts.baseDir   destination folder inside the vault ('' = root).
 * @param {Function} opts.getKey  async () => CryptoKey (the vault key).
 * @param {Function} opts.t       i18n translate(key, params).
 * @param {Function} [opts.onComplete] called once when all uploads settle.
 * @param {Function} [opts.onFileComplete] called after each file finishes
 *        uploading, so the caller can refresh the sidebar live (debounce it).
 */
async function start(opts) {
  const { entries, baseDir = '', getKey, t, onComplete, onFileComplete } = opts;
  if (!entries || !entries.length) return;

  // Drop OS junk (macOS ._*, .DS_Store, …) before queueing so the user never
  // sees a failed-upload row for files they did not knowingly add.
  const isExcluded = buildExcludeMatcher(window.__WO_UPLOAD_EXCLUDE__);
  const kept = [];
  let skipped = 0;
  for (const en of entries) {
    if (isExcluded(en.relativePath || '')) skipped++;
    else kept.push(en);
  }
  if (!kept.length) return;

  const key = await getKey();

  const uppy = new Uppy({
    autoProceed: true,
    allowMultipleUploadBatches: true,
  });
  uppy.use(Tus, {
    endpoint: '/files',
    chunkSize: CHUNK_SIZE,
    limit: CONCURRENCY,
    retryDelays: RETRY_DELAYS,
    withCredentials: true,
    removeFingerprintOnSuccess: true,
  });

  // One UI item per kept file (shown immediately as "queued").
  const items = kept.map((en) => ({
    rel: en.relativePath,
    file: en.file,
    size: en.file.size,
    id: null, // uppy file id, assigned when added
    status: 'queued',
    pct: 0,
    bytesUploaded: 0,
    bytesTotal: 0,
    speed: 0,
    eta: null,
    error: '',
    firstProgress: true,
    _lastT: 0,
    _lastB: 0,
  }));
  const byId = new Map(); // uppy id -> item
  let queueIdx = 0; // next entry to encrypt + add
  let inFlight = 0; // files currently added to uppy (encrypted, not yet freed)
  let feeding = false;
  let finished = false;

  const panel = buildPanel(t, {
    onClose: () => teardown(true),
    onCtrl: (c) => {
      if (c === 'pause') uppy.pauseAll();
      else if (c === 'resume') uppy.resumeAll();
      else if (c === 'cancel') teardown(true);
      else if (c === 'retry') retryAllFailed();
    },
    onRow: (a, it) => {
      if (!it.id && a !== 'cancel') return;
      if (a === 'pause') {
        uppy.pauseResume(it.id);
        it.status = 'paused';
      } else if (a === 'resume') {
        uppy.pauseResume(it.id);
        it.status = 'uploading';
      } else if (a === 'cancel') {
        if (it.id) uppy.removeFile(it.id);
        it.status = 'complete'; // remove from the active set visually
        it.pct = 100;
        afterFileSettled(it);
      } else if (a === 'retry') {
        it.status = 'retrying';
        it.error = '';
        uppy.retryUpload(it.id);
      }
      panel.touch();
    },
  });
  panel.setItems(items);
  // Tell the user up front that some OS junk files were left out.
  if (skipped) {
    const tr = (k, p) => (typeof t === 'function' ? t(k, p) : k);
    panel.setFooter(tr('up_skipped_note', { n: skipped }), false);
  }

  function retryAllFailed() {
    let any = false;
    for (const it of items) {
      if (it.status === 'error' && it.id) {
        it.status = 'retrying';
        it.error = '';
        any = true;
      }
    }
    if (any) uppy.retryAll();
    panel.touch();
  }

  // Encrypt + add the next files until the in-flight window is full.
  async function feed() {
    if (feeding) return;
    feeding = true;
    try {
      while (inFlight < WINDOW && queueIdx < items.length) {
        const it = items[queueIdx++];
        inFlight++;
        try {
          const buf = new Uint8Array(await it.file.arrayBuffer());
          const ct = await window.WOCrypto.encryptBytesDeterministic(key, buf);
          const slash = it.rel.lastIndexOf('/');
          const dir = slash >= 0 ? it.rel.slice(0, slash) : '';
          const name = slash >= 0 ? it.rel.slice(slash + 1) : it.rel;
          const id = uppy.addFile({
            // Stable name (the relative path) so the tus fingerprint is identical
            // across sessions, which is what lets a refreshed upload resume.
            name: it.rel,
            type: 'application/octet-stream',
            data: new Blob([ct]),
            meta: {
              relativePath: dir,
              filename: name,
              filetype: it.file.type || '',
              base: baseDir,
            },
          });
          it.id = id;
          byId.set(id, it);
        } catch (err) {
          inFlight--;
          it.status = 'error';
          it.error = (err && err.message) || String(err);
        }
      }
    } finally {
      feeding = false;
      panel.touch();
    }
  }

  // Free a finished file's encrypted Blob and pull in the next queued file.
  function afterFileSettled(it) {
    if (it._freed) return;
    it._freed = true;
    it.file = null; // release the File reference
    inFlight = Math.max(0, inFlight - 1);
    feed();
    updateAggregate();
    maybeFinish();
  }

  function updateAggregate() {
    let total = 0;
    let uploaded = 0;
    let done = 0;
    let speed = 0;
    for (const it of items) {
      const tot = it.bytesTotal || it.size || 0;
      total += tot;
      uploaded += it.status === 'complete' ? tot : it.bytesUploaded || 0;
      if (it.status === 'complete') done++;
      if (it.status === 'uploading') speed += it.speed || 0;
    }
    const pct = total ? (uploaded / total) * 100 : done === items.length ? 100 : 0;
    const remaining = total - uploaded;
    const eta = speed > 0 ? remaining / speed : null;
    panel.setAggregate({
      pct,
      uploaded,
      total,
      done,
      count: items.length,
      eta,
    });
  }

  function maybeFinish() {
    if (finished) return;
    const settled = items.every(
      (it) => it.status === 'complete' || it.status === 'error',
    );
    if (!settled) return;
    if (queueIdx < items.length) return; // still feeding
    finished = true;
    const failed = items.filter((it) => it.status === 'error');
    const ok = items.length - failed.length;
    const tr = (k, p) => (typeof t === 'function' ? t(k, p) : k);
    let msg = failed.length
      ? tr('up_done_partial', { ok, failed: failed.length })
      : tr('up_done_all', { n: ok });
    if (skipped) {
      msg += ` · ${tr('up_skipped_note', { n: skipped })}`;
    }
    panel.setFooter(msg, failed.length > 0);
    panel.setControlEnabled('pause', false);
    panel.setControlEnabled('resume', false);
    panel.setControlEnabled('retry', failed.length > 0);
    if (typeof onComplete === 'function') onComplete();
  }

  // ----- uppy events -----
  uppy.on('upload-progress', (file, progress) => {
    const it = byId.get(file.id);
    if (!it) return;
    const now = Date.now();
    const b = progress.bytesUploaded || 0;
    it.bytesUploaded = b;
    it.bytesTotal = progress.bytesTotal || it.bytesTotal;
    it.pct = it.bytesTotal ? (b / it.bytesTotal) * 100 : 0;
    if (it.firstProgress) {
      it.firstProgress = false;
      // A first event already past 0 means tus picked up a stored offset.
      it.status = b > 0 && it.pct < 99 ? 'resuming' : 'uploading';
      it._lastT = now;
      it._lastB = b;
    } else {
      if (it.status === 'resuming' || it.status === 'retrying') it.status = 'uploading';
      const dt = (now - it._lastT) / 1000;
      if (dt >= 0.3) {
        it.speed = (b - it._lastB) / dt;
        it.eta = it.speed > 0 ? (it.bytesTotal - b) / it.speed : null;
        it._lastT = now;
        it._lastB = b;
      }
    }
    updateAggregate();
    panel.touch();
  });

  uppy.on('upload-success', (file) => {
    const it = byId.get(file.id);
    if (!it) return;
    it.status = 'complete';
    it.pct = 100;
    it.bytesUploaded = it.bytesTotal || it.size;
    uppy.removeFile(file.id); // drop the ciphertext Blob from memory
    afterFileSettled(it);
    panel.touch();
    // Let the caller refresh the sidebar as files land (it should debounce) so
    // uploaded files show up immediately, not only after everything finishes.
    if (typeof onFileComplete === 'function') onFileComplete();
  });

  uppy.on('upload-error', (file, error) => {
    const it = byId.get(file.id);
    if (!it) return;
    it.status = 'error';
    it.error = (error && error.message) || String(error);
    afterFileSettled(it);
    panel.touch();
  });

  uppy.on('restored', () => panel.touch());

  function teardown(cancel) {
    if (cancel) {
      try {
        uppy.cancelAll();
      } catch (e) {
        /* ignore */
      }
    }
    try {
      uppy.destroy();
    } catch (e) {
      /* ignore */
    }
    panel.destroy();
  }

  // Kick off.
  updateAggregate();
  await feed();
}

window.WOUpload = {
  start,
  isSupported: 'webkitdirectory' in document.createElement('input'),
};
