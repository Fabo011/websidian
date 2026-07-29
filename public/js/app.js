'use strict';

/* ---------- small helpers ---------- */

// A failed upload can leave the request body half-sent (the server answers
// early and stops draining), which makes `fetch` hang forever and the loading
// spinner never clear. An AbortController guarantees the promise always settles
// so callers' catch/finally run. Form uploads get a longer budget than JSON.
const API_TIMEOUT_MS = 30 * 1000;
// Large folder/zip imports can take many minutes to encrypt and upload, so the
// upload budget is generous. Keep this >= the server's UPLOAD_REQUEST_TIMEOUT_MIN
// so the client doesn't give up before the server finishes writing the files.
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
// Deleting or renaming a large folder recursively moves/removes many objects
// (slow on S3). Give those mutations the same generous budget as uploads so the
// client doesn't abort at API_TIMEOUT_MS and mislabel a slow op as a timeout.
const MUTATION_TIMEOUT_MS = UPLOAD_TIMEOUT_MS;

// Upload caps surfaced by the server (head partial). We validate the user's
// selection in the browser BEFORE encrypting/uploading so an oversized file or
// a too-large import is rejected up front with a clear message — no long wait
// and round-trip just to get a 400 back.
const MAX_UPLOAD_MB = Number(window.__WO_MAX_UPLOAD_MB__) || 2048;
const MAX_UPLOAD_FILE_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_IMPORT_FILES = Number(window.__WO_MAX_IMPORT_FILES__) || 20000;
const MAX_IMPORT_TOTAL_MB = Number(window.__WO_MAX_IMPORT_TOTAL_MB__) || 2048;
const MAX_IMPORT_TOTAL_BYTES = MAX_IMPORT_TOTAL_MB * 1024 * 1024;

// Pure size/limit helpers live in wo-util.js (loaded before this script) so
// they can be unit-tested without a DOM. fmtSize is byte formatting;
// uploadLimitError validates a { path, size } selection against the caps above.
const fmtSize = WOUtil.fmtSize;
function uploadLimitError(items) {
  return WOUtil.uploadLimitError(
    items,
    {
      maxImportTotalBytes: MAX_IMPORT_TOTAL_BYTES,
      maxImportFiles: MAX_IMPORT_FILES,
      maxUploadFileBytes: MAX_UPLOAD_FILE_BYTES,
    },
    t,
  );
}

async function api(method, url, body, isForm, timeoutMs) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const ctrl = new AbortController();
  opts.signal = ctrl.signal;
  // Most API calls abort after API_TIMEOUT_MS so the spinner always settles.
  // Long-running mutations (deleting/renaming a large folder, which recursively
  // moves/removes many objects on S3) pass an explicit, longer timeoutMs.
  const timer = setTimeout(
    () => ctrl.abort(),
    timeoutMs || (isForm ? UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS),
  );
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    // Abort (timeout) and network drops both land here; surface a clear,
    // translatable message instead of a hung spinner or a cryptic DOMException.
    const err = new Error(
      e && e.name === 'AbortError' ? t('request_timeout') : t('network_error'),
    );
    err.cause = e;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
  }
  if (res.status === 429) {
    // Rate limit reached: show a clear centered modal the user must confirm so
    // they understand what happened. Retry-After (seconds) is sent by the
    // server when available so we can tell the user how long to wait.
    const retry = parseInt(res.headers.get('retry-after') || '', 10);
    uiAlert(t('rate_limited_title'), {
      message:
        Number.isFinite(retry) && retry > 0
          ? t('rate_limited_retry', { seconds: retry })
          : t('rate_limited'),
    });
    const err = new Error('Rate limited');
    err.status = 429;
    err.data = data;
    throw err;
  }
  if (!res.ok) {
    const msg =
      data && (Array.isArray(data.message) ? data.message.join(' ') : data.message);
    const err = new Error(msg || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Delete an entry while streaming progress back. The server (with ?stream=1)
// moves/removes the folder's files one by one and emits NDJSON lines
// {done,total}; a final {ok:true} signals success, {error} a failure. onProgress
// is called for each {done,total}. Returns the final {ok} object.
async function apiDeleteStream(path, onProgress) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MUTATION_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(
      '/api/entry?stream=1&path=' + encodeURIComponent(path),
      { method: 'DELETE', credentials: 'same-origin', signal: ctrl.signal },
    );
  } catch (e) {
    clearTimeout(timer);
    throw new Error(
      e && e.name === 'AbortError' ? t('request_timeout') : t('network_error'),
    );
  }
  if (res.status === 401) {
    clearTimeout(timer);
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new Error(t('delete_failed_msg'));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.error) throw new Error(obj.error);
        if (obj.ok) result = obj;
        else if (typeof obj.done === 'number') onProgress(obj.done, obj.total);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return result || { ok: true };
}

const $ = (sel) => document.querySelector(sel);
const t = (key, vars) => (window.I18N ? window.I18N.t(key, vars) : key);
const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/* ---------- styled modal dialogs (replace native prompt/confirm) ---------- */

let modalActive = null; // { resolve, isPrompt }

function closeModal(result) {
  const overlay = $('#modal-overlay');
  overlay.hidden = true;
  const pending = modalActive;
  modalActive = null;
  if (pending) pending.resolve(result);
}

function openModal({ title, message, isPrompt, value, placeholder, okText, cancelText, danger, inputType, hideCancel }) {
  return new Promise((resolve) => {
    // If another modal is open, cancel it first.
    if (modalActive) closeModal(isPromptDefault(modalActive));
    modalActive = { resolve, isPrompt: !!isPrompt };

    $('#modal-title').textContent = title || '';
    const msgEl = $('#modal-message');
    if (message) {
      msgEl.textContent = message;
      msgEl.hidden = false;
    } else {
      msgEl.hidden = true;
    }

    const input = $('#modal-input');
    if (isPrompt) {
      input.hidden = false;
      input.type = inputType || 'text';
      input.value = value != null ? value : '';
      input.placeholder = placeholder || '';
    } else {
      input.hidden = true;
      input.type = 'text';
    }

    const ok = $('#modal-ok');
    const cancel = $('#modal-cancel');
    ok.textContent = okText || t('ok');
    cancel.textContent = cancelText || t('cancel');
    cancel.hidden = !!hideCancel;
    ok.classList.toggle('btn-danger', !!danger);

    $('#modal-overlay').hidden = false;

    if (isPrompt) {
      setTimeout(() => {
        input.focus();
        if (input.type === 'text' && input.value) {
          // Select the filename portion (before extension) for quick editing.
          const dot = input.value.lastIndexOf('.');
          input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
        } else {
          input.select();
        }
      }, 0);
    } else {
      setTimeout(() => ok.focus(), 0);
    }
  });
}

function isPromptDefault(state) {
  return state.isPrompt ? null : false;
}

function modalConfirm(result) {
  if (!modalActive) return;
  if (modalActive.isPrompt) {
    closeModal(result ? $('#modal-input').value : null);
  } else {
    closeModal(!!result);
  }
}

/** Styled replacement for window.prompt. Resolves to string or null. */
function uiPrompt(title, value, opts) {
  return openModal({
    title,
    isPrompt: true,
    value,
    okText: 'Create',
    ...(opts || {}),
  });
}

/** Styled replacement for window.confirm. Resolves to boolean. */
function uiConfirm(title, opts) {
  return openModal({ title, isPrompt: false, ...(opts || {}) }).then(
    (r) => r === true,
  );
}

/** Styled replacement for window.alert. Resolves when dismissed. */
function uiAlert(title, opts) {
  return openModal({
    title,
    isPrompt: false,
    hideCancel: true,
    okText: t('ok'),
    ...(opts || {}),
  });
}

(function setupModalEvents() {
  $('#modal-ok').addEventListener('click', () => modalConfirm(true));
  $('#modal-cancel').addEventListener('click', () => modalConfirm(false));
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) modalConfirm(false);
  });
  $('#modal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      modalConfirm(true);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (modalActive && e.key === 'Escape') {
      e.preventDefault();
      modalConfirm(false);
    }
  });
})();

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
// Editable text/code files (must mirror TEXT_EXTENSIONS in vault.service.ts).
const TEXT_EXTS = [
  'md', 'markdown', 'txt', 'json', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini',
  'conf', 'cfg', 'env', 'properties', 'xml', 'log',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'php', 'java', 'kt',
  'kts', 'go', 'rs', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'swift', 'scala',
  'lua', 'pl', 'r', 'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'dockerfile', 'gradle', 'tex',
];
// Binary office documents rendered read-only by the office viewer bundle.
const OFFICE_EXTS = ['docx', 'xlsx', 'xls', 'odt', 'ods'];
// Code/config files that are not markdown notes (shown with a code preview).
const CODE_EXTS = TEXT_EXTS.filter(
  (e) => e !== 'md' && e !== 'markdown' && e !== 'txt',
);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
function basename(p) {
  const parts = p.split('/');
  return parts[parts.length - 1];
}
function dirname(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}
function attachmentUrl(p) {
  return '/api/attachment?path=' + encodeURIComponent(p);
}

/* ---------- end-to-end encryption ---------- */

// The vault key (VK) lives only in the browser. WOCrypto restores it from this
// tab's sessionStorage on a fresh page load; if it is missing we ask the user
// to unlock by re-deriving it from their password (the server can hand us the
// wrapped key + salt but never the key itself).
let vaultKey = null;

/** Decrypted-attachment blob URL cache: vault path -> objectURL. */
const attachmentBlobCache = new Map();

/** Ensure the vault key is available, prompting for the password if needed. */
async function ensureVaultKey() {
  if (vaultKey) return vaultKey;
  vaultKey = await window.WOCrypto.getVaultKey();
  if (vaultKey) return vaultKey;
  // Fresh tab / cleared memory: re-derive from the password.
  vaultKey = await promptUnlock();
  return vaultKey;
}

/**
 * Prompt for the account password and unlock the vault key. Fetches the
 * (server-opaque) wrapped key + salt and unwraps locally.
 */
async function promptUnlock() {
  for (;;) {
    const password = await uiPrompt(t('unlock_title'), '', {
      title: t('unlock_title'),
      message: t('unlock_msg'),
      placeholder: t('password'),
      okText: t('unlock_action'),
      inputType: 'password',
    });
    if (password == null) {
      // User dismissed: without the key the app is unusable, so send to login.
      window.location.href = '/login';
      throw new Error('Vault locked');
    }
    try {
      const keys = await api('GET', '/api/account/keys');
      if (!keys || !keys.wrappedVaultKey || !keys.kdfSalt) {
        throw new Error('missing key material');
      }
      return await window.WOCrypto.unlockVaultKey(
        password,
        keys.kdfSalt,
        keys.wrappedVaultKey,
      );
    } catch (e) {
      await uiAlert(t('unlock_failed_title'), { message: t('unlock_failed_msg') });
    }
  }
}

/** Encrypt note text to the base64 ciphertext the file API expects. */
async function encryptContent(text) {
  const key = await ensureVaultKey();
  return window.WOCrypto.encryptTextToB64(key, text || '');
}

/** Decrypt base64 ciphertext returned by the file API back to text. */
async function decryptContent(b64) {
  if (b64 == null || b64 === '') return '';
  const key = await ensureVaultKey();
  // Tolerant: files written before E2E encryption was enabled are stored as
  // plaintext and are returned untouched so old content stays readable.
  return window.WOCrypto.decryptB64ToTextMaybe(key, b64);
}

/** Encrypt raw file bytes into a Blob of ciphertext for upload. */
async function encryptFileBlob(file) {
  const key = await ensureVaultKey();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ct = await window.WOCrypto.encryptBytes(key, bytes);
  return new Blob([ct], { type: 'application/octet-stream' });
}

/**
 * Fetch an encrypted attachment, decrypt it, and return a blob: URL the browser
 * can render directly. Results are cached per vault path for the page session.
 */
async function attachmentBlobUrl(path, mime) {
  if (attachmentBlobCache.has(path)) return attachmentBlobCache.get(path);
  const key = await ensureVaultKey();
  const res = await fetch(attachmentUrl(path), { credentials: 'same-origin' });
  if (!res.ok) throw new Error('attachment fetch failed');
  const cipher = new Uint8Array(await res.arrayBuffer());
  const plain = await window.WOCrypto.decryptBytesMaybe(key, cipher);
  const blob = new Blob([plain], { type: mime || mimeForPath(path) });
  const url = URL.createObjectURL(blob);
  attachmentBlobCache.set(path, url);
  return url;
}

/** Best-effort MIME type from a file extension for decrypted blob previews. */
function mimeForPath(path) {
  const ext = extOf(path);
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

/** Collect every vault-relative file path from the loaded tree for link resolution. */
function collectVaultPaths() {
  const paths = [];
  document.querySelectorAll('#tree [data-path]').forEach((el) => {
    if (el.getAttribute('data-type') !== 'dir') {
      paths.push(el.getAttribute('data-path'));
    }
  });
  return paths;
}

/* ---------- state ---------- */

const state = {
  selectedDir: '',
  current: null, // { path, ext }
  dirty: false,
  excalidraw: null,
  contextTarget: null,
  dragPath: null,
  dragType: null,
  expanded: new Set(), // folder paths that are currently expanded
  tree: [], // last-loaded tree, used to build search folder filters
};

/* ---------- tree ---------- */

// Mark a folder path (and all its ancestors) as expanded so its contents show.
function expandAncestors(dirPath) {
  if (!dirPath) return;
  const parts = dirPath.split('/');
  let acc = '';
  for (const part of parts) {
    acc = acc ? acc + '/' + part : part;
    state.expanded.add(acc);
  }
}

async function loadTree() {
  const tree = await api('GET', '/api/tree');
  state.tree = tree; // kept for the search overlay's folder filters
  const container = $('#tree');
  container.innerHTML = '';
  container.appendChild(buildList(tree));
  if (typeof markTreeActive === 'function') markTreeActive();
  // The vault changed shape; drop the cached full-text index so the next search
  // rebuilds it from the current files, and the graph so it reflects new/removed
  // notes and links.
  invalidateSearchIndex();
  if (typeof invalidateGraphCache === 'function') invalidateGraphCache();
}

// Throttled tree refresh used during an upload so the sidebar updates live as
// files land. Throttle (not debounce) so a continuous stream of completions
// still refreshes periodically — at most once per interval — instead of only
// after the whole upload goes quiet. Fires immediately, then trailing.
let _treeRefreshTs = 0;
let _treeRefreshTimer = null;
function refreshTreeSoon() {
  const INTERVAL = 1500;
  const run = () => {
    _treeRefreshTs = Date.now();
    _treeRefreshTimer = null;
    loadTree().catch(() => {});
  };
  const since = Date.now() - _treeRefreshTs;
  if (since >= INTERVAL) {
    run();
  } else if (!_treeRefreshTimer) {
    _treeRefreshTimer = setTimeout(run, INTERVAL - since);
  }
}

// Dropping on empty tree space moves an entry to the vault root.
(function setupRootDrop() {
  const tree = $('#tree');
  if (!tree) return;
  tree.addEventListener('dragover', (e) => {
    if (e.target.closest('.tree-row')) return; // handled by folder rows
    if (isExternalFileDrag(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      tree.classList.add('drop-target-root');
      return;
    }
    if (isInvalidMove(state.dragPath, state.dragType, '')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    tree.classList.add('drop-target-root');
  });
  tree.addEventListener('dragleave', (e) => {
    if (!tree.contains(e.relatedTarget)) tree.classList.remove('drop-target-root');
  });
  tree.addEventListener('drop', async (e) => {
    tree.classList.remove('drop-target-root');
    if (e.target.closest('.tree-row')) return;
    if (isExternalFileDrag(e)) {
      e.preventDefault();
      await uploadDataTransfer(e.dataTransfer, '');
      return;
    }
    if (isInvalidMove(state.dragPath, state.dragType, '')) return;
    e.preventDefault();
    await moveEntry(state.dragPath, '');
  });
})();

function buildList(nodes) {
  const ul = document.createElement('ul');
  for (const node of nodes) {
    // Hide websidian's own internal folder (encrypted app settings) from the
    // sidebar — the user never edits it by hand.
    if (node.path === RESERVED_DIR || node.path.startsWith(RESERVED_DIR + '/')) {
      continue;
    }
    ul.appendChild(buildItem(node));
  }
  return ul;
}

function buildItem(node) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.path = node.path;
  row.dataset.type = node.type;
  row.draggable = true;
  attachDragSource(row, node);

  const label = document.createElement('span');
  label.className = 'tree-label';

  if (node.type === 'dir') {
    const expanded = state.expanded.has(node.path);

    const caret = document.createElement('i');
    caret.className = expanded
      ? 'bi bi-chevron-down caret'
      : 'bi bi-chevron-right caret';
    label.appendChild(caret);

    const folderIcon = document.createElement('i');
    folderIcon.className = expanded
      ? 'bi bi-folder2-open tree-icon tree-icon-dir'
      : 'bi bi-folder tree-icon tree-icon-dir';
    label.appendChild(folderIcon);

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name;
    label.appendChild(name);
    row.appendChild(label);

    if (node.path === state.selectedDir) row.classList.add('selected');

    const childWrap = document.createElement('div');
    childWrap.className = 'tree-children';
    childWrap.hidden = !expanded;
    childWrap.appendChild(buildList(node.children || []));

    label.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = childWrap.hidden;
      childWrap.hidden = !open;
      caret.className = open
        ? 'bi bi-chevron-down caret'
        : 'bi bi-chevron-right caret';
      folderIcon.className = open
        ? 'bi bi-folder2-open tree-icon tree-icon-dir'
        : 'bi bi-folder tree-icon tree-icon-dir';
      if (open) {
        state.expanded.add(node.path);
      } else {
        state.expanded.delete(node.path);
      }
      selectDir(node.path, row);
    });

    // Folders are drop targets for moving entries into them.
    attachDropTarget(row, node.path);

    row.appendChild(makeMenuButton(node));
    li.appendChild(row);
    li.appendChild(childWrap);
  } else {
    const fileIco = document.createElement('i');
    fileIco.className = 'bi ' + fileIcon(node.ext) + ' tree-icon';
    label.appendChild(fileIco);

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name;
    label.appendChild(name);
    row.appendChild(label);
    row.appendChild(makeMenuButton(node));
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      openFile(node.path);
    });
    li.appendChild(row);
  }

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, node);
  });

  return li;
}

/* ---------- drag & drop (move entries between folders) ---------- */

function attachDragSource(row, node) {
  row.addEventListener('dragstart', (e) => {
    state.dragPath = node.path;
    state.dragType = node.type;
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.path);
    }
  });
  row.addEventListener('dragend', () => {
    state.dragPath = null;
    state.dragType = null;
    row.classList.remove('dragging');
    document
      .querySelectorAll('.drop-target')
      .forEach((el) => el.classList.remove('drop-target'));
  });
}

/** Returns true if `target` is the source itself, its parent, or a descendant. */
function isInvalidMove(fromPath, fromType, targetDir) {
  if (fromPath == null) return true;
  const parent = dirname(fromPath);
  if (parent === targetDir) return true; // already there
  if (targetDir === fromPath) return true; // onto itself
  if (fromType === 'dir' && (targetDir + '/').startsWith(fromPath + '/')) {
    return true; // into own descendant
  }
  return false;
}

function attachDropTarget(el, targetDir) {
  el.addEventListener('dragover', (e) => {
    if (isExternalFileDrag(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      el.classList.add('drop-target');
      return;
    }
    if (isInvalidMove(state.dragPath, state.dragType, targetDir)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drop-target');
    if (isExternalFileDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      await uploadDataTransfer(e.dataTransfer, targetDir);
      return;
    }
    if (isInvalidMove(state.dragPath, state.dragType, targetDir)) return;
    e.preventDefault();
    e.stopPropagation();
    await moveEntry(state.dragPath, targetDir);
  });
}

async function moveEntry(fromPath, targetDir) {
  const name = basename(fromPath);
  const to = targetDir ? targetDir + '/' + name : name;
  try {
    await api(
      'POST',
      '/api/rename',
      { from: fromPath, to },
      false,
      MUTATION_TIMEOUT_MS,
    );
  } catch (err) {
    flash(err.message || t('could_not_move'));
    return;
  }
  // Keep any open tabs in sync if they (or their folder) were moved.
  renameTabPaths(fromPath, to);
  // Keep the destination folder expanded so the moved item stays visible.
  expandAncestors(targetDir);
  await loadTree();
  flash(t('moved_to', { target: targetDir || t('vault_root') }));
}

/* ---------- drag & drop (upload files from the computer) ---------- */

/** True when the drag carries files from the user's computer (not a tree row). */
function isExternalFileDrag(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  // Internal tree-row drags set dragPath; everything else with a Files type is
  // an external file/folder coming from the desktop.
  if (state.dragPath != null) return false;
  return Array.from(dt.types || []).includes('Files');
}

/** Recursively collect { file, path } entries from a dropped file/folder. */
function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          out.push({ file, path: prefix + entry.name });
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const collected = [];
      const readBatch = () => {
        reader.readEntries(
          async (batch) => {
            if (!batch.length) {
              for (const child of collected) {
                await walkEntry(child, prefix + entry.name + '/', out);
              }
              resolve();
              return;
            }
            collected.push(...batch);
            readBatch();
          },
          () => resolve(),
        );
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

/** Read all files (with relative paths) from a drop's DataTransfer. */
async function readDataTransferEntries(dt) {
  const out = [];
  const items = dt.items ? Array.from(dt.items) : [];
  let usedEntries = false;
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
    if (entry) {
      usedEntries = true;
      await walkEntry(entry, '', out);
    }
  }
  if (!usedEntries) {
    for (const file of Array.from(dt.files || [])) {
      out.push({ file, path: file.name });
    }
  }
  return out;
}

/** Upload dropped files/folders into `targetDir`, preserving any structure. */
async function uploadDataTransfer(dt, targetDir) {
  const entries = await readDataTransferEntries(dt);
  if (!entries.length) return;
  // Route dropped files/folders through the resumable, chunked tus uploader so
  // a multi-GB drop never sends an over-100 MB request. Each file is encrypted
  // in the browser; its drop path (en.path) preserves the folder structure.
  try {
    await window.WOUpload.start({
      entries: entries.map((en) => ({ file: en.file, relativePath: en.path })),
      baseDir: targetDir,
      getKey: ensureVaultKey,
      t,
      onFileComplete: refreshTreeSoon,
      onComplete: () => {
        expandAncestors(targetDir);
        loadTree();
      },
    });
  } catch (err) {
    await uiAlert(t('upload_failed_title'), {
      message: err.message || t('upload_failed_msg'),
    });
  }
}

function fileIcon(ext) {
  if (IMAGE_EXTS.includes(ext)) return 'bi-file-earmark-image';
  if (ext === 'pdf') return 'bi-file-earmark-pdf';
  if (ext === 'excalidraw') return 'bi-pencil-square';
  if (ext === 'kanban') return 'bi-kanban';
  if (ext === 'chat') return 'bi-chat-dots';
  if (ext === 'md' || ext === 'markdown') return 'bi-file-earmark-text';
  if (ext === 'txt') return 'bi-file-earmark';
  if (ext === 'docx') return 'bi-file-earmark-word';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods')
    return 'bi-file-earmark-spreadsheet';
  if (ext === 'odt') return 'bi-file-earmark-richtext';
  if (ext === 'epub') return 'bi-book';
  if (CODE_EXTS.includes(ext)) return 'bi-file-earmark-code';
  return 'bi-paperclip';
}

function makeMenuButton(node) {
  const btn = document.createElement('button');
  btn.className = 'row-menu';
  btn.innerHTML = '<i class="bi bi-three-dots"></i>';
  btn.setAttribute('aria-label', 'Actions');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = btn.getBoundingClientRect();
    openContextMenu(rect.left, rect.bottom, node);
  });
  return btn;
}

/** Render a clickable breadcrumb of path segments into `el`. */
function renderBreadcrumb(el, path, options) {
  const opts = options || {};
  el.innerHTML = '';
  const rootCrumb = document.createElement('span');
  rootCrumb.className = 'crumb crumb-root';
  rootCrumb.innerHTML = '<i class="bi bi-house"></i>';
  rootCrumb.title = 'Vault root';
  if (opts.onNavigate) {
    rootCrumb.classList.add('crumb-link');
    rootCrumb.addEventListener('click', () => opts.onNavigate(''));
  }
  el.appendChild(rootCrumb);

  if (!path) return;
  const segments = path.split('/').filter(Boolean);
  let acc = '';
  segments.forEach((seg, i) => {
    acc = acc ? acc + '/' + seg : seg;
    const sep = document.createElement('i');
    sep.className = 'bi bi-chevron-right crumb-sep';
    el.appendChild(sep);

    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = seg;
    const isLast = i === segments.length - 1;
    const here = acc;
    if (opts.onNavigate && !isLast) {
      crumb.classList.add('crumb-link');
      crumb.addEventListener('click', () => opts.onNavigate(here));
    }
    if (isLast) crumb.classList.add('crumb-current');
    el.appendChild(crumb);
  });
}

function setSelectedDir(path) {
  state.selectedDir = path;
  renderBreadcrumb($('#selected-folder'), path, { onNavigate: setSelectedDir });
}

function selectDir(path, row) {
  document.querySelectorAll('.tree-row.selected').forEach((r) =>
    r.classList.remove('selected'),
  );
  if (row) row.classList.add('selected');
  setSelectedDir(path);
}

/** Select a folder by its path, highlighting its tree row if it is visible. */
function selectDirByPath(path) {
  let row = null;
  if (path) {
    row = document.querySelector(
      '.tree-row[data-path="' + (window.CSS && CSS.escape ? CSS.escape(path) : path) + '"]',
    );
  }
  selectDir(path, row);
}

/* ---------- context menu ---------- */

function openContextMenu(x, y, node) {
  state.contextTarget = node;
  const menu = $('#context-menu');
  const backdrop = $('#context-menu-backdrop');
  const isDir = node.type === 'dir';
  menu.querySelectorAll('[data-folder-only]').forEach((el) => {
    el.hidden = !isDir;
  });
  menu.hidden = false;
  const isMobile = window.matchMedia('(max-width: 800px)').matches;
  if (isMobile) {
    // On phones, show the menu centered with a backdrop so it is always
    // reachable instead of opening off-screen near the tapped row.
    menu.classList.add('context-menu-centered');
    menu.style.left = '';
    menu.style.top = '';
    if (backdrop) backdrop.hidden = false;
  } else {
    menu.classList.remove('context-menu-centered');
    if (backdrop) backdrop.hidden = true;
    // Clamp within the viewport so the menu never opens off-screen.
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }
}
function closeContextMenu() {
  $('#context-menu').hidden = true;
  const backdrop = $('#context-menu-backdrop');
  if (backdrop) backdrop.hidden = true;
  $('#context-menu').classList.remove('context-menu-centered');
  state.contextTarget = null;
}

document.addEventListener('click', () => closeContextMenu());

$('#context-menu').addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  const action = actionEl && actionEl.dataset.action;
  const node = state.contextTarget;
  if (!action || !node) return;
  closeContextMenu();
  if (action === 'rename') {
    const newName = await uiPrompt(t('rename'), node.name, {
      title: t('rename'),
      okText: t('rename'),
      placeholder: t('prompt_rename_ph'),
    });
    if (!newName || newName === node.name) return;
    const parent = dirname(node.path);
    const to = parent ? parent + '/' + newName : newName;
    await api(
      'POST',
      '/api/rename',
      { from: node.path, to },
      false,
      MUTATION_TIMEOUT_MS,
    );
    renameTabPaths(node.path, to);
    await loadTree();
  } else if (action === 'new-note') {
    await createNoteIn(node.path);
  } else if (action === 'new-file') {
    await createFileIn(node.path);
  } else if (action === 'new-kanban') {
    await createKanbanIn(node.path);
  } else if (action === 'new-folder') {
    await createFolderIn(node.path);
  } else if (action === 'upload') {
    // Target this folder, then open the file picker (same flow as the toolbar).
    selectDirByPath(node.path);
    $('#upload-input').click();
  } else if (action === 'import') {
    selectDirByPath(node.path);
    openImportModal();
  } else if (action === 'download') {
    try {
      if (node.type === 'dir') {
        await downloadFolderNode(node);
      } else {
        await downloadFileNode(node);
      }
    } catch {
      flash(t('download_failed'));
    }
  } else if (action === 'delete') {
    const ok = await uiConfirm(t('delete'), {
      message: t('confirm_delete_msg', { name: node.name }),
      okText: t('delete'),
      danger: true,
    });
    if (!ok) return;
    // Deleting a folder can remove many files (slow on S3). Stream real progress
    // so the user sees a moving bar instead of a multi-minute spinner.
    showProgress(t('delete_progress'));
    try {
      await apiDeleteStream(node.path, (done, total) => {
        updateProgress(done, total, t('progress_files', { done, total }));
      });
      await closeTabsUnder(node.path);
      // If the deleted folder was the active target (or contained it), the
      // cursor would still point at a path that no longer exists — creating
      // anything would silently resurrect it. Fall back to root.
      if (
        state.selectedDir === node.path ||
        state.selectedDir.startsWith(node.path + '/')
      ) {
        setSelectedDir('');
      }
      await loadTree();
      hideProgress();
    } catch (err) {
      hideProgress();
      await uiAlert(t('delete_failed_title'), {
        message: err.message || t('delete_failed_msg'),
      });
    }
  }
});

/* ---------- views ---------- */

function hideAllViews() {
  $('#welcome').hidden = true;
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  if (typeof stopGraphSim === 'function') stopGraphSim();
}
function showWelcome() {
  if (typeof deactivateTabs === 'function') deactivateTabs();
  hideAllViews();
  state.current = null;
  $('#welcome').hidden = false;
}

/* ---------- tabs ---------- */

// Open files are kept as tabs (Obsidian-style). Each tab holds everything
// needed to restore its view from memory, so switching tabs never refetches or
// re-decrypts. Live DOM for viewers (image/pdf/office) and Excalidraw stays
// mounted in per-tab panes; the shared markdown/text editor is restored from a
// cached string. At most MAX_OPEN_TABS files can be open at once.
const TABS = {
  list: [], // tab objects, in tab-bar order
  activeId: null,
};
// The operator's MAX_OPEN_TABS env value is the default limit. Users on their
// own storage (S3/WebDAV) may raise or lower it in settings, up to a hard cap.
const DEFAULT_MAX_OPEN_TABS = Math.max(1, Number(window.__WO_MAX_OPEN_TABS__) || 8);
const TAB_LIMIT_HARD_MAX = 25;

/** Effective open-tab limit. Honours the user's per-account override (stored in
 *  the vault prefs, so it syncs across devices) only on bring-your-own-storage
 *  deployments; otherwise the operator default stands. Clamped to [1, 25]. */
function maxOpenTabs() {
  if (USER_STORAGE) {
    const pref = getPref('maxOpenTabs');
    if (Number.isFinite(pref)) {
      return WOUtil.clampTabLimit(pref, TAB_LIMIT_HARD_MAX, DEFAULT_MAX_OPEN_TABS);
    }
  }
  return DEFAULT_MAX_OPEN_TABS;
}
// Whether the operator enabled end-to-end encrypted chat (surfaced from the
// server). When false, the Chat button + settings are hidden and no socket is
// opened.
const CHAT_ENABLED = window.__WO_CHAT_ENABLED__ !== false;
let tabSeq = 0;

function activeTab() {
  return TABS.list.find((tb) => tb.id === TABS.activeId) || null;
}

// Remember which files are open (and which is active) so a page reload restores
// the same set of tabs. Only paths are stored — content stays end-to-end
// encrypted and is re-fetched per tab on restore.
const OPEN_TABS_KEY = 'wo-open-tabs';
let restoringTabs = false;
function persistTabs() {
  if (restoringTabs) return;
  try {
    const active = activeTab();
    localStorage.setItem(
      OPEN_TABS_KEY,
      JSON.stringify({
        paths: TABS.list.map((tb) => tb.path),
        active: active ? active.path : null,
      }),
    );
  } catch (e) {
    /* storage blocked — restore is best-effort */
  }
}

async function restoreTabs() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || 'null');
  } catch (e) {
    saved = null;
  }
  if (!saved || !Array.isArray(saved.paths) || !saved.paths.length) return;
  restoringTabs = true;
  try {
    for (const p of saved.paths) {
      // Restore special (non-file) tabs by kind; otherwise open the file. Stay
      // quiet during restore — deleted/renamed files are simply skipped.
      if (p === SPECIAL_TABS.weblinks.path) {
        await openSpecialTab('weblinks', { silent: true });
      } else if (p === SPECIAL_TABS.calendar.path) {
        await openSpecialTab('calendar', { silent: true });
      } else if (p === SPECIAL_TABS.graph.path) {
        await openSpecialTab('graph', { silent: true });
      } else {
        await openFile(p, { silent: true });
      }
    }
  } finally {
    restoringTabs = false;
  }
  const target = TABS.list.find((tb) => tb.path === saved.active);
  if (target) await activateTab(target.id);
  renderTabbar();
}

function tabKindFor(ext) {
  if (ext === 'excalidraw') return 'excalidraw';
  if (ext === 'kanban') return 'kanban';
  if (ext === 'chat') return 'chat';
  if (TEXT_EXTS.includes(ext)) return 'editor';
  return 'viewer';
}

function renderTabbar() {
  const bar = $('#tabbar');
  bar.hidden = TABS.list.length === 0;
  bar.innerHTML = '';

  // Tab counter (open / max). Makes the MAX_OPEN_TABS limit transparent so the
  // user understands why a new file won't open once the cap is reached — the cap
  // protects the vault's storage connection (e.g. WebDAV) from too many
  // concurrent open files. Turns "full" when the limit is hit.
  const counter = document.createElement('span');
  const limit = maxOpenTabs();
  const full = TABS.list.length >= limit;
  counter.className = 'tab-count' + (full ? ' is-full' : '');
  counter.textContent = `${TABS.list.length}/${limit}`;
  // On own-storage deployments the counter is a shortcut to the limit setting.
  const adjustable = USER_STORAGE;
  counter.title = adjustable
    ? t('tabs_count_tip_adjust', { max: limit })
    : t('tabs_count_tip', { max: limit });
  counter.setAttribute('aria-label', counter.title);
  if (adjustable) {
    counter.classList.add('is-clickable');
    counter.setAttribute('role', 'button');
    counter.tabIndex = 0;
    counter.addEventListener('click', openTabLimitSetting);
    counter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openTabLimitSetting();
      }
    });
  }
  bar.appendChild(counter);

  for (const tab of TABS.list) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === TABS.activeId ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.setAttribute('role', 'tab');
    el.title = tab.special ? tab.title : tab.path;

    const icon = document.createElement('i');
    const iconName =
      tab.special && SPECIAL_TABS[tab.kind]
        ? SPECIAL_TABS[tab.kind].icon
        : fileIcon(tab.ext);
    icon.className = 'bi ' + iconName + ' tab-icon';
    el.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    el.appendChild(title);

    if (tab.dirty) {
      const dot = document.createElement('span');
      dot.className = 'tab-dirty';
      dot.title = t('tab_unsaved');
      el.appendChild(dot);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.setAttribute('aria-label', t('close_tab'));
    close.title = t('close_tab');
    close.innerHTML = '<i class="bi bi-x"></i>';
    el.appendChild(close);

    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      activateTab(tab.id);
    });
    // Middle-click closes the tab, like a browser.
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab.id);
      }
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    bar.appendChild(el);
  }
  persistTabs();
}

// Highlight tree rows that are open as tabs, and the active one.
function markTreeActive() {
  const open = new Set(TABS.list.map((tb) => tb.path));
  const active = activeTab() ? activeTab().path : null;
  document.querySelectorAll('#tree .tree-row').forEach((row) => {
    if (row.dataset.type === 'dir') return;
    const p = row.dataset.path;
    row.classList.toggle('tab-open', open.has(p));
    row.classList.toggle('tab-active', p === active);
  });
}

// Flip the active editor tab to "unsaved" without re-rendering the whole bar
// (this runs on every keystroke, so it stays cheap).
function markActiveDirty() {
  const tab = activeTab();
  if (!tab || tab.dirty) return;
  tab.dirty = true;
  const el = $('#tabbar').querySelector('.tab[data-tab-id="' + tab.id + '"]');
  if (el && !el.querySelector('.tab-dirty')) {
    const dot = document.createElement('span');
    dot.className = 'tab-dirty';
    el.insertBefore(dot, el.querySelector('.tab-close'));
  }
}

// Save the active editor tab's live state into its cache before switching away.
// Viewer / Excalidraw tabs keep their own live DOM, so nothing to capture there.
function snapshotActive() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'editor') return;
  tab.content = $('#editor').value;
  tab.dirty = state.dirty;
  tab.viewing = state.viewing;
  tab.scrollTop = state.viewing
    ? $('#preview').scrollTop
    : $('#editor').scrollTop;
}

async function openFile(path, opts = {}) {
  const silent = !!opts.silent;
  const existing = TABS.list.find((tb) => tb.path === path);
  if (existing) {
    await activateTab(existing.id);
    maybeCloseSidebar();
    return;
  }
  if (TABS.list.length >= maxOpenTabs()) {
    flash(t('tabs_limit', { max: maxOpenTabs() }));
    return;
  }
  const ext = extOf(path);
  const tab = {
    id: 't' + ++tabSeq,
    path,
    ext,
    kind: tabKindFor(ext),
    title: basename(path),
    version: null,
    dirty: false,
    content: '',
    viewing: false,
    scrollTop: 0,
    pane: null,
    blobUrl: null,
    excalidraw: null,
    kanban: null,
    epub: null,
    pdf: null,
    chat: null,
  };
  TABS.list.push(tab);
  renderTabbar();
  if (!silent) showLoading(t('opening_file'));
  try {
    await loadTabContent(tab);
  } catch (err) {
    TABS.list = TABS.list.filter((x) => x !== tab);
    renderTabbar();
    if (!silent) {
      hideLoading();
      await uiAlert(t('open_failed_title'), {
        message: err.message || t('open_failed_msg'),
      });
    }
    return;
  }
  if (!silent) hideLoading();
  await activateTab(tab.id);
  if (!silent) maybeCloseSidebar();
}

// Fetch + decrypt a freshly opened file once, building any persistent pane.
async function loadTabContent(tab) {
  if (tab.kind === 'editor') {
    const data = await api(
      'GET',
      '/api/file?path=' + encodeURIComponent(tab.path),
    );
    tab.content = await decryptContent(data.content);
    tab.version = data.version;
    const isMarkdown = tab.ext === 'md' || tab.ext === 'markdown';
    const isCode = CODE_EXTS.includes(tab.ext);
    // Markdown/code open in reading mode; plain text opens straight in edit.
    tab.viewing = isMarkdown || isCode;
  } else if (tab.kind === 'excalidraw') {
    let initial = null;
    try {
      const data = await api(
        'GET',
        '/api/file?path=' + encodeURIComponent(tab.path),
      );
      tab.version = data.version;
      const content = await decryptContent(data.content);
      initial = content ? JSON.parse(content) : null;
    } catch (e) {
      initial = null;
    }
    await ensureExcalidraw();
    const pane = document.createElement('div');
    pane.className = 'excalidraw-pane';
    pane.hidden = true;
    $('#excalidraw-root').appendChild(pane);
    tab.pane = pane;
    tab.excalidraw = window.ExcalidrawEditor.mount(pane, initial, {
      onChange: () => {
        markTabDirty(tab);
        scheduleAutosave();
      },
    });
  } else if (tab.kind === 'kanban') {
    let initial = null;
    try {
      const data = await api(
        'GET',
        '/api/file?path=' + encodeURIComponent(tab.path),
      );
      tab.version = data.version;
      const content = await decryptContent(data.content);
      initial = content ? WOUtil.kanbanNormalize(content) : null;
    } catch (e) {
      initial = null;
    }
    const pane = document.createElement('div');
    pane.className = 'kanban-pane';
    pane.hidden = true;
    $('#kanban-root').appendChild(pane);
    tab.pane = pane;
    tab.kanban = window.WOKanban.mount(pane, initial, {
      t,
      onChange: () => {
        markTabDirty(tab);
        scheduleAutosave();
      },
      confirm: (message) =>
        uiConfirm(t('kanban_confirm_title'), {
          message,
          okText: t('delete'),
          cancelText: t('cancel'),
          danger: true,
        }),
      notes: mdNoteList(),
      onOpenNote: (p) => openFile(p),
      sanitizeUrl: (u) => WOUtil.sanitizeLinkUrl(u),
      // Auto-save the board when a card is dragged into a different column.
      onMove: () => saveKanban(),
      // Create a new markdown note and hand its path back to be linked.
      onCreateNote: (title) => createKanbanLinkedNote(title),
    });
  } else if (tab.kind === 'chat') {
    await buildChatPane(tab);
  } else {
    await buildViewerPane(tab);
  }
}

// Build a persistent chat pane for a conversation tab. The partner is derived
// from the file path (chats/<partner>/<partner>.chat). The heavy lifting (keys,
// socket, history, persistence) lives in WOChat/WOChatUI.
async function buildChatPane(tab) {
  const partner = WOUtil.partnerFromChatPath(tab.path);
  if (!partner) throw new Error(t('chat_err_bad_username'));
  await ensureChatReady();
  const pane = document.createElement('div');
  pane.className = 'chat-root-pane';
  pane.hidden = true;
  $('#chat-root').appendChild(pane);
  tab.pane = pane;
  tab.partner = partner;
  tab.chat = window.WOChatUI.mountTab(pane, { partner, deps: chatDeps() });
}

// Build the persistent viewer pane (image / pdf / office) for a tab. Kept
// mounted so switching back never reloads the iframe or re-renders the doc.
async function buildViewerPane(tab) {
  const pane = document.createElement('div');
  pane.className = 'viewer-pane';
  pane.hidden = true;
  $('#viewer-body').appendChild(pane);
  tab.pane = pane;
  const ext = tab.ext;
  if (IMAGE_EXTS.includes(ext)) {
    const img = document.createElement('img');
    img.alt = tab.title;
    pane.appendChild(img);
    tab.blobUrl = await attachmentBlobUrl(tab.path);
    img.src = tab.blobUrl;
  } else if (ext === 'pdf') {
    await renderPdf(tab, pane);
  } else if (OFFICE_EXTS.includes(ext)) {
    await renderOffice(tab.path, ext, pane);
  } else if (ext === 'epub') {
    await renderEpub(tab, pane);
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('no_preview');
    pane.appendChild(p);
  }
}

async function activateTab(id) {
  const tab = TABS.list.find((tb) => tb.id === id);
  if (!tab) return;
  snapshotActive();
  TABS.activeId = id;
  hideAllViews();
  state.current = tab.special
    ? null
    : { path: tab.path, ext: tab.ext, version: tab.version };
  state.dirty = tab.dirty;
  state.excalidraw = tab.kind === 'excalidraw' ? tab.excalidraw : null;
  if (tab.kind === 'editor') activateEditorTab(tab);
  else if (tab.kind === 'excalidraw') activateExcalidrawTab(tab);
  else if (tab.kind === 'kanban') activateKanbanTab(tab);
  else if (tab.kind === 'chat') activateChatTab(tab);
  else if (tab.kind === 'weblinks') activateWeblinksTab(tab);
  else if (tab.kind === 'calendar') activateCalendarTab(tab);
  else if (tab.kind === 'graph') activateGraphTab(tab);
  else activateViewerTab(tab);
  renderTabbar();
  markTreeActive();
  renderSaveStatus();
}

function activateEditorTab(tab) {
  $('#editor-view').hidden = false;
  renderBreadcrumb($('#current-path'), tab.path);
  const editor = $('#editor');
  editor.value = tab.content;
  const isMarkdown = tab.ext === 'md' || tab.ext === 'markdown';
  const isCode = CODE_EXTS.includes(tab.ext);
  // Markdown and code/config files offer a reading view; plain .txt has none.
  $('#toggle-preview').style.display = isMarkdown || isCode ? '' : 'none';
  setViewMode(tab.viewing);
  const scroll = tab.scrollTop || 0;
  requestAnimationFrame(() => {
    (tab.viewing ? $('#preview') : editor).scrollTop = scroll;
  });
  if (!tab.viewing) editor.focus();
}

function activateViewerTab(tab) {
  $('#viewer-view').hidden = false;
  renderBreadcrumb($('#viewer-path'), tab.path);
  $('#viewer-body')
    .querySelectorAll('.viewer-pane')
    .forEach((p) => (p.hidden = p !== tab.pane));
  // epub.js cannot paginate/position while its pane is hidden (zero size), so it
  // renders on page one. Now that the pane is visible, re-paginate and re-anchor
  // to the saved reading position. rAF so the browser has applied the layout.
  if (tab.epub && tab.epub.resize) {
    requestAnimationFrame(() => tab.epub.resize());
  }
  // Same for the pdf.js viewer: it could not lay out (or anchor to the saved
  // page) while its pane was hidden and zero-sized.
  if (tab.pdf && tab.pdf.resize) {
    requestAnimationFrame(() => tab.pdf.resize());
  }
  const dl = $('#viewer-download');
  if (tab.blobUrl) {
    dl.href = tab.blobUrl;
    dl.setAttribute('download', tab.title);
  } else {
    dl.removeAttribute('href');
  }
}

function activateExcalidrawTab(tab) {
  $('#excalidraw-view').hidden = false;
  renderBreadcrumb($('#excalidraw-path'), tab.path);
  $('#excalidraw-root')
    .querySelectorAll('.excalidraw-pane')
    .forEach((p) => (p.hidden = p !== tab.pane));
}

function activateKanbanTab(tab) {
  $('#kanban-view').hidden = false;
  renderBreadcrumb($('#kanban-path'), tab.path);
  $('#kanban-root')
    .querySelectorAll('.kanban-pane')
    .forEach((p) => (p.hidden = p !== tab.pane));
}

// Which conversation is currently on screen (used to suppress notifications for
// the chat the user is already looking at).
function currentChatPartner() {
  const tab = activeTab();
  return tab && tab.kind === 'chat' ? tab.partner : null;
}

function activateChatTab(tab) {
  $('#chat-view').hidden = false;
  renderBreadcrumb($('#chat-path'), tab.path);
  $('#chat-root')
    .querySelectorAll('.chat-root-pane')
    .forEach((p) => (p.hidden = p !== tab.pane));
  if (tab.chat && tab.chat.activate) tab.chat.activate();
}

// Flag any tab (not just the active one) dirty and paint its unsaved dot.
// Used by custom editors whose changes come from callbacks, not #editor input.
function markTabDirty(tab) {
  if (!tab || tab.dirty) return;
  tab.dirty = true;
  if (tab.id === TABS.activeId) state.dirty = true;
  const el = $('#tabbar').querySelector('.tab[data-tab-id="' + tab.id + '"]');
  if (el && !el.querySelector('.tab-dirty')) {
    const dot = document.createElement('span');
    dot.className = 'tab-dirty';
    el.insertBefore(dot, el.querySelector('.tab-close'));
  }
}

// Special (non-file) tabs — web links and the calendar. They open as tabs so the
// user can switch between them and files without the view being torn down and
// rebuilt. Their data lives in module state (weblinksState / calendarState), so
// re-activating a tab just re-shows the view from memory — no refetch.
const SPECIAL_TABS = {
  weblinks: {
    path: '__weblinks__',
    icon: 'bi-link-45deg',
    titleKey: 'weblinks_title',
  },
  calendar: {
    path: '__calendar__',
    icon: 'bi-calendar3',
    titleKey: 'calendar_title',
  },
  graph: {
    path: '__graph__',
    icon: 'bi-diagram-3',
    titleKey: 'graph_title',
  },
};

function activateWeblinksTab() {
  $('#weblinks-view').hidden = false;
  renderWeblinks();
}

function activateCalendarTab() {
  $('#calendar-view').hidden = false;
  renderCalendar();
}

/**
 * Open (or focus) a special tab. `opts.refresh` reloads its data first — done on
 * an explicit sidebar-button click and always for a freshly created tab, but
 * NOT when the user merely clicks the tab (that re-shows from memory).
 */
async function openSpecialTab(kind, opts = {}) {
  const meta = SPECIAL_TABS[kind];
  if (!meta) return;
  let tab = TABS.list.find((tb) => tb.path === meta.path);
  const isNew = !tab;
  if (isNew && TABS.list.length >= maxOpenTabs()) {
    flash(t('tabs_limit', { max: maxOpenTabs() }));
    return;
  }
  if (isNew || opts.refresh) {
    const loadOpts = { silent: opts.silent, force: opts.force };
    const loader =
      kind === 'weblinks'
        ? loadWeblinksData
        : kind === 'calendar'
          ? loadCalendarView
          : loadGraphView;
    const ok = await loader(loadOpts);
    if (!ok) return; // load failed; don't create/leave a broken tab
  }
  if (isNew) {
    tab = {
      id: 't' + ++tabSeq,
      path: meta.path,
      ext: null,
      kind,
      special: true,
      title: t(meta.titleKey),
      version: null,
      dirty: false,
      content: '',
      viewing: false,
      scrollTop: 0,
      pane: null,
      blobUrl: null,
      excalidraw: null,
      epub: null,
      pdf: null,
    };
    TABS.list.push(tab);
    renderTabbar();
  }
  await activateTab(tab.id);
  if (!opts.silent) maybeCloseSidebar();
}

async function closeTab(id) {
  const idx = TABS.list.findIndex((tb) => tb.id === id);
  if (idx < 0) return;
  const tab = TABS.list[idx];
  if (tab.id === TABS.activeId) snapshotActive();
  if (tab.dirty) {
    const discard = await uiConfirm(t('tab_unsaved_title'), {
      message: t('tab_unsaved_msg', { name: tab.title }),
      okText: t('discard'),
      cancelText: t('cancel'),
      danger: true,
    });
    if (!discard) return;
  }
  // Note: the decrypted attachment blob URL is intentionally NOT revoked — the
  // blob cache is shared (e.g. with markdown image embeds), so other views may
  // still reference it.
  if (tab.excalidraw && window.ExcalidrawEditor.unmount) {
    try {
      window.ExcalidrawEditor.unmount(tab.excalidraw);
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.kanban && tab.kanban.destroy) {
    try {
      tab.kanban.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.epub && tab.epub.destroy) {
    try {
      tab.epub.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.pdf && tab.pdf.destroy) {
    try {
      tab.pdf.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.chat && tab.chat.destroy) {
    try {
      tab.chat.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.pane && tab.pane.parentNode) tab.pane.parentNode.removeChild(tab.pane);
  const wasActive = tab.id === TABS.activeId;
  TABS.list.splice(idx, 1);
  if (wasActive) {
    TABS.activeId = null;
    const next = TABS.list[idx] || TABS.list[idx - 1];
    if (next) {
      await activateTab(next.id);
    } else {
      hideAllViews();
      state.current = null;
      state.excalidraw = null;
      $('#welcome').hidden = false;
      renderTabbar();
      markTreeActive();
    }
  } else {
    renderTabbar();
    markTreeActive();
  }
}

// Re-fetch the active editor tab from the server (used after a save conflict
// when the user chooses to reload the latest instead of overwriting).
async function reloadActiveEditor() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'editor') return;
  const data = await api(
    'GET',
    '/api/file?path=' + encodeURIComponent(tab.path),
  );
  tab.content = await decryptContent(data.content);
  tab.version = data.version;
  tab.dirty = false;
  $('#editor').value = tab.content;
  state.current.version = data.version;
  state.dirty = false;
  clearAutosaveConflict(tab.path);
  if (state.viewing) renderPreviewNow();
  renderTabbar();
  renderSaveStatus();
}

// Keep open tabs in sync when a file/folder is renamed or moved. `from`/`to`
// are vault-relative paths; any tab at or under `from` is repointed to `to`.
function renameTabPaths(from, to) {
  let changed = false;
  for (const tab of TABS.list) {
    if (tab.path === from) {
      tab.path = to;
    } else if (tab.path.startsWith(from + '/')) {
      tab.path = to + tab.path.slice(from.length);
    } else {
      continue;
    }
    tab.title = basename(tab.path);
    tab.ext = extOf(tab.path);
    changed = true;
  }
  if (!changed) return;
  const active = activeTab();
  if (active) {
    state.current.path = active.path;
    const headerSel =
      active.kind === 'editor'
        ? '#current-path'
        : active.kind === 'viewer'
          ? '#viewer-path'
          : active.kind === 'kanban'
            ? '#kanban-path'
            : '#excalidraw-path';
    renderBreadcrumb($(headerSel), active.path);
  }
  renderTabbar();
  markTreeActive();
}

// Detach a tab's live DOM and drop it from the list without any prompt (used
// when its underlying file was deleted, so there is nothing left to save).
function forceCloseTab(tab) {
  if (tab.excalidraw && window.ExcalidrawEditor.unmount) {
    try {
      window.ExcalidrawEditor.unmount(tab.excalidraw);
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.kanban && tab.kanban.destroy) {
    try {
      tab.kanban.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.epub && tab.epub.destroy) {
    try {
      tab.epub.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.pdf && tab.pdf.destroy) {
    try {
      tab.pdf.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.chat && tab.chat.destroy) {
    try {
      tab.chat.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  if (tab.pane && tab.pane.parentNode) tab.pane.parentNode.removeChild(tab.pane);
  TABS.list = TABS.list.filter((x) => x !== tab);
}

// Close every tab at or under `path` (file or folder was deleted).
async function closeTabsUnder(path) {
  const doomed = TABS.list.filter(
    (tab) => tab.path === path || tab.path.startsWith(path + '/'),
  );
  if (!doomed.length) return;
  const closingActive = doomed.some((tab) => tab.id === TABS.activeId);
  for (const tab of doomed) forceCloseTab(tab);
  if (closingActive) {
    TABS.activeId = null;
    const next = TABS.list[0];
    if (next) {
      await activateTab(next.id);
      return;
    }
    hideAllViews();
    state.current = null;
    state.excalidraw = null;
    $('#welcome').hidden = false;
  }
  renderTabbar();
  markTreeActive();
}

// Leave the active file tab to show a non-file view (welcome, web links, graph)
// without closing any tabs: snapshot the editor and clear the active highlight.
function deactivateTabs() {
  snapshotActive();
  TABS.activeId = null;
  renderTabbar();
  markTreeActive();
}

/* ---------- text editor + preview ---------- */

$('#editor').addEventListener('input', () => {
  state.dirty = true;
  markActiveDirty();
  scheduleAutosave();
});

/** Switch the editor between edit mode (textarea) and reading mode (preview). */
function setViewMode(viewing) {
  const editor = $('#editor');
  const preview = $('#preview');
  const toggle = $('#toggle-preview');
  const toolbar = $('#editor-toolbar');
  const isMarkdown =
    state.current &&
    (state.current.ext === 'md' || state.current.ext === 'markdown');
  state.viewing = viewing;
  if (typeof closeWikiSuggest === 'function') closeWikiSuggest();
  if (viewing) {
    editor.hidden = true;
    preview.hidden = false;
    if (toolbar) toolbar.hidden = true;
    renderPreviewNow();
    toggle.innerHTML = '<i class="bi bi-pencil"></i> <span class="btn-label">' + t('edit') + '</span>';
    toggle.title = t('title_toggle_view');
  } else {
    preview.hidden = true;
    editor.hidden = false;
    if (toolbar) toolbar.hidden = !isMarkdown;
    toggle.innerHTML = '<i class="bi bi-eye"></i> <span class="btn-label">' + t('view') + '</span>';
    toggle.title = t('title_toggle_view');
  }
}

async function renderPreviewNow() {
  if (!state.current) return;
  const ext = state.current.ext;
  const isMarkdown = ext === 'md' || ext === 'markdown';
  const preview = $('#preview');
  try {
    if (isMarkdown) {
      // Render entirely in the browser: the server can no longer read the
      // (encrypted) note. Attachments render as a 1x1 placeholder first, then
      // their decrypted blob: URLs are swapped in asynchronously.
      preview.innerHTML = window.WOMarkdown.render($('#editor').value, {
        notePath: state.current.path,
        files: collectVaultPaths(),
        attachmentSrc: () => PLACEHOLDER_SRC,
      });
      await hydrateAttachments(preview);
    } else {
      preview.innerHTML = window.WOMarkdown.highlightFile(ext, $('#editor').value);
    }
    enhanceCodeBlocks(preview);
  } catch (e) {
    /* ignore preview errors */
  }
}

// Transparent 1x1 GIF used while an attachment's decrypted blob URL loads.
const PLACEHOLDER_SRC =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Replace placeholder attachment sources with decrypted blob: URLs. Every
 * rendered attachment carries its vault path in `data-wo-att`; we decrypt each
 * referenced file once and point the element at the resulting blob URL.
 */
async function hydrateAttachments(container) {
  const nodes = container.querySelectorAll('[data-wo-att]');
  const seen = new Map();
  await Promise.all(
    Array.from(nodes).map(async (el) => {
      const path = el.getAttribute('data-wo-att');
      if (!path) return;
      try {
        let urlP = seen.get(path);
        if (!urlP) {
          urlP = attachmentBlobUrl(path);
          seen.set(path, urlP);
        }
        const url = await urlP;
        if (el.tagName === 'IMG' || el.tagName === 'IFRAME') {
          el.src = url;
        } else if (el.tagName === 'A') {
          el.href = url;
        }
      } catch (e) {
        /* missing/unreadable attachment: leave placeholder */
      }
    }),
  );
}

/** Add a "copy" button to every highlighted code block in `container`. */
function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre.hljs').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    pre.classList.add('has-copy');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.title = t('copy');
    btn.setAttribute('aria-label', t('copy'));
    btn.innerHTML = '<i class="bi bi-clipboard"></i>';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      const text = code ? code.innerText : pre.innerText;
      const ok = await copyText(text);
      btn.innerHTML = ok
        ? '<i class="bi bi-check2"></i>'
        : '<i class="bi bi-clipboard-x"></i>';
      btn.classList.toggle('copied', ok);
      setTimeout(() => {
        btn.innerHTML = '<i class="bi bi-clipboard"></i>';
        btn.classList.remove('copied');
      }, 1200);
    });
    pre.appendChild(btn);
  });
}

/** Copy text to the clipboard, falling back to execCommand on older browsers. */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

$('#toggle-preview').addEventListener('click', () => {
  setViewMode(!state.viewing);
});

/* ---------- drag & drop attachments into the markdown editor ---------- */

/** Insert text at the editor caret, switching out of reading mode if needed. */
function insertIntoEditor(text) {
  const editor = $('#editor');
  if (state.viewing) setViewMode(false);
  const start = editor.selectionStart != null ? editor.selectionStart : editor.value.length;
  const end = editor.selectionEnd != null ? editor.selectionEnd : editor.value.length;
  const before = editor.value.slice(0, start);
  const after = editor.value.slice(end);
  const needNlBefore = before.length > 0 && !before.endsWith('\n');
  const needNlAfter = after.length > 0 && !after.startsWith('\n');
  const insert = (needNlBefore ? '\n' : '') + text + (needNlAfter ? '\n' : '');
  editor.value = before + insert + after;
  const pos = before.length + insert.length;
  editor.selectionStart = editor.selectionEnd = pos;
  editor.focus();
  fireEditorInput();
}

function currentIsMarkdown() {
  return (
    state.current &&
    (state.current.ext === 'md' || state.current.ext === 'markdown')
  );
}

/**
 * Upload files dropped onto the markdown editor into the note's own folder and
 * embed each one at the caret — images as `![[name]]`, other files as `[[name]]`.
 */
async function embedDroppedFiles(files) {
  if (!currentIsMarkdown()) return;
  const limitErr = uploadLimitError(
    Array.from(files).map((f) => ({ path: f.name, size: f.size })),
  );
  if (limitErr) {
    await uiAlert(t('upload_failed_title'), { message: limitErr });
    return;
  }
  const folder = dirname(state.current.path);
  showLoading(t('uploading'));
  const refs = [];
  try {
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', await encryptFileBlob(file), file.name);
      fd.append('folder', folder);
      const res = await api('POST', '/api/upload', fd, true);
      const name = basename((res && res.path) || file.name);
      const isImage = IMAGE_EXTS.includes(extOf(name));
      refs.push((isImage ? '![[' : '[[') + name + ']]');
    }
  } catch (err) {
    hideLoading();
    await uiAlert(t('upload_failed_title'), {
      message: err.message || t('upload_failed_msg'),
    });
    return;
  }
  hideLoading();
  insertIntoEditor(refs.join('\n'));
  expandAncestors(folder);
  await loadTree();
  flash(t('uploaded_n', { n: files.length }));
}

(function setupEditorDrop() {
  const body = $('#editor-body');
  if (!body) return;
  body.addEventListener('dragover', (e) => {
    if (!isExternalFileDrag(e) || !currentIsMarkdown()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    body.classList.add('drop-target-editor');
  });
  body.addEventListener('dragleave', (e) => {
    if (!body.contains(e.relatedTarget)) {
      body.classList.remove('drop-target-editor');
    }
  });
  body.addEventListener('drop', async (e) => {
    body.classList.remove('drop-target-editor');
    if (!isExternalFileDrag(e) || !currentIsMarkdown()) return;
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) await embedDroppedFiles(files);
  });
})();

// Prevent the browser from navigating away when a file is dropped outside a
// recognised drop zone (which would otherwise open the file and lose the app).
['dragover', 'drop'].forEach((evt) => {
  window.addEventListener(evt, (e) => {
    if (isExternalFileDrag(e)) e.preventDefault();
  });
});

/* ---------- markdown formatting toolbar ---------- */

// Line-prefix actions add a marker at the start of each selected line.
const MD_LINE_PREFIX = {
  list: '- ',
  checklist: '- [ ] ',
  h1: '# ',
  h2: '## ',
  h3: '### ',
  h4: '#### ',
  h5: '##### ',
  h6: '###### ',
};

/** Mark the editor dirty and refresh the preview after a programmatic edit. */
function fireEditorInput() {
  $('#editor').dispatchEvent(new Event('input', { bubbles: true }));
}

/** Wrap the current selection (or insert a placeholder) with before/after. */
function wrapSelection(before, after, placeholder) {
  const editor = $('#editor');
  const { selectionStart: start, selectionEnd: end, value } = editor;
  const selected = value.slice(start, end) || placeholder;
  editor.value = value.slice(0, start) + before + selected + after + value.slice(end);
  editor.selectionStart = start + before.length;
  editor.selectionEnd = start + before.length + selected.length;
  editor.focus();
  fireEditorInput();
}

/** Prefix every line spanned by the selection with the given marker. */
function applyLinePrefix(prefix) {
  const editor = $('#editor');
  const { selectionEnd: end, value } = editor;
  const lineStart = value.lastIndexOf('\n', editor.selectionStart - 1) + 1;
  const segment = value.slice(lineStart, end);
  const updated = segment
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
  editor.value = value.slice(0, lineStart) + updated + value.slice(end);
  editor.selectionStart = lineStart;
  editor.selectionEnd = lineStart + updated.length;
  editor.focus();
  fireEditorInput();
}

function applyMarkdown(action) {
  if (action === 'bold') {
    wrapSelection('**', '**', 'text');
  } else if (action === 'highlight') {
    wrapSelection('==', '==', 'text');
  } else if (action === 'image') {
    wrapSelection('![[', ']]', 'image.png');
  } else if (action === 'wikilink') {
    startWikilink();
  } else if (MD_LINE_PREFIX[action]) {
    applyLinePrefix(MD_LINE_PREFIX[action]);
  }
}

function closeHeadingMenu() {
  const menu = $('#md-heading-menu');
  if (menu) menu.hidden = true;
  const toggle = $('#editor-toolbar [data-md-heading-toggle]');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

$('#editor-toolbar').addEventListener('click', (e) => {
  const action = e.target.closest('[data-md]');
  if (action) {
    e.preventDefault();
    applyMarkdown(action.dataset.md);
    closeHeadingMenu();
    return;
  }
  const headingToggle = e.target.closest('[data-md-heading-toggle]');
  if (headingToggle) {
    e.preventDefault();
    const menu = $('#md-heading-menu');
    const open = menu.hidden;
    menu.hidden = !open;
    headingToggle.setAttribute('aria-expanded', String(open));
  }
});

// Close the heading menu when clicking outside the dropdown.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.md-dropdown')) {
    closeHeadingMenu();
  }
});

/* ---------- Obsidian-style list continuation ---------- */

// When the caret line is a list/task/ordered item, pressing Enter starts the
// next item automatically (so the user need not re-click the toolbar). Pressing
// Enter on an empty item instead clears the marker and exits the list.
const LIST_CONTINUE_RULES = [
  // Task list: `- [ ] `, `* [x] `, … → next blank task item.
  { re: /^(\s*)([-*+])(\s+)\[[ xX]\](\s+)/, next: (m) => `${m[1]}${m[2]}${m[3]}[ ]${m[4]}` },
  // Bullet list: `- `, `* `, `+ ` → same marker.
  { re: /^(\s*)([-*+])(\s+)/, next: (m) => `${m[1]}${m[2]}${m[3]}` },
  // Ordered list: `1. `, `2) ` → incremented number, same delimiter.
  { re: /^(\s*)(\d+)([.)])(\s+)/, next: (m) => `${m[1]}${Number(m[2]) + 1}${m[3]}${m[4]}` },
];

/**
 * Continue the current list item on Enter. Returns true when it handled the
 * keystroke (caller should suppress the default newline).
 */
function continueListItem() {
  const editor = $('#editor');
  const { selectionStart, selectionEnd, value } = editor;
  if (selectionStart !== selectionEnd) return false; // active selection → default
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const nl = value.indexOf('\n', selectionStart);
  const lineEnd = nl === -1 ? value.length : nl;
  const line = value.slice(lineStart, lineEnd);

  for (const rule of LIST_CONTINUE_RULES) {
    const m = rule.re.exec(line);
    if (!m) continue;
    const marker = m[0];
    // Empty item (only the marker) → exit the list by removing the marker.
    if (line.slice(marker.length).trim() === '') {
      editor.value = value.slice(0, lineStart) + value.slice(lineStart + marker.length);
      editor.selectionStart = editor.selectionEnd = lineStart;
      fireEditorInput();
      return true;
    }
    const insert = '\n' + rule.next(m);
    editor.value = value.slice(0, selectionStart) + insert + value.slice(selectionEnd);
    editor.selectionStart = editor.selectionEnd = selectionStart + insert.length;
    fireEditorInput();
    return true;
  }
  return false;
}

(function setupListContinuation() {
  const editor = $('#editor');
  if (!editor) return;
  // Desktop: keydown lets us honour Shift+Enter (soft break) and skip IME.
  editor.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (wikiSuggest.open) return; // suggestion popup handles Enter itself
    if (continueListItem()) e.preventDefault();
  });
  // Mobile: many virtual keyboards don't emit a usable Enter keydown, so fall
  // back to beforeinput. If keydown already handled it, the default newline was
  // prevented and this never fires for that keystroke.
  editor.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertLineBreak') return;
    if (wikiSuggest.open) return;
    if (continueListItem()) e.preventDefault();
  });
})();

/* ---------- wikilink autocomplete (Obsidian-style) ---------- */

// Typing `[[` (or pressing the toolbar wikilink button) opens a searchable
// popup of the vault's notes so the user can link without remembering exact
// names. The popup tracks the text between `[[` and the caret as a live query.
const wikiSuggest = {
  open: false,
  items: [],
  active: 0,
  queryStart: -1, // index just after the `[[`
};

// CSS properties copied onto the mirror element used to locate the caret pixel
// position inside the textarea (no native API exists for this).
const CARET_MIRROR_PROPS = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
  'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight',
  'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing',
  'wordSpacing', 'tabSize',
];

/** Pixel coordinates of the caret (relative to the textarea border box). */
function caretCoordinates(el, position) {
  const computed = window.getComputedStyle(el);
  const div = document.createElement('div');
  const style = div.style;
  style.position = 'absolute';
  style.visibility = 'hidden';
  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';
  style.overflow = 'hidden';
  CARET_MIRROR_PROPS.forEach((p) => { style[p] = computed[p]; });
  document.body.appendChild(div);
  div.textContent = el.value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = el.value.slice(position) || '.';
  div.appendChild(span);
  const coords = {
    top: span.offsetTop + parseInt(computed.borderTopWidth, 10),
    left: span.offsetLeft + parseInt(computed.borderLeftWidth, 10),
    height: parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10),
  };
  document.body.removeChild(div);
  return coords;
}

/** All markdown notes in the vault except the one being edited. */
function mdNoteList() {
  const cur = state.current ? state.current.path : null;
  return collectVaultPaths()
    .filter((p) => /\.(md|markdown)$/i.test(p) && p !== cur)
    .map((p) => ({ path: p, name: p.split('/').pop().replace(/\.(md|markdown)$/i, '') }));
}

/** Rank notes against the query: exact > prefix > substring > path match. */
function filterNotes(notes, query) {
  const q = query.trim().toLowerCase();
  if (!q) return notes.slice(0, 50);
  const scored = [];
  for (const n of notes) {
    const name = n.name.toLowerCase();
    const path = n.path.toLowerCase();
    let score = -1;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (path.includes(q)) score = 3;
    if (score >= 0) scored.push({ n, score });
  }
  scored.sort((a, b) => a.score - b.score || a.n.name.localeCompare(b.n.name));
  return scored.slice(0, 50).map((s) => s.n);
}

/** Obsidian-style link target: bare note name when unique, else full path. */
function wikiLinkName(file, notes) {
  const dupe = notes.filter(
    (o) => o.name.toLowerCase() === file.name.toLowerCase(),
  ).length > 1;
  return dupe ? file.path.replace(/\.(md|markdown)$/i, '') : file.name;
}

/** Detect an open `[[…` immediately before the caret on the current line. */
function detectWikilinkContext() {
  const editor = $('#editor');
  const pos = editor.selectionStart;
  if (pos !== editor.selectionEnd) return null;
  const value = editor.value;
  const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
  const before = value.slice(lineStart, pos);
  const m = /\[\[([^[\]\n]*)$/.exec(before);
  if (!m) return null;
  return { query: m[1], queryStart: pos - m[1].length };
}

function closeWikiSuggest() {
  if (!wikiSuggest.open) return;
  wikiSuggest.open = false;
  const box = $('#wikilink-suggest');
  if (box) {
    box.hidden = true;
    box.innerHTML = '';
  }
}

function renderWikiSuggest() {
  const box = $('#wikilink-suggest');
  if (!box) return;
  box.innerHTML = '';
  if (!wikiSuggest.items.length) {
    const empty = document.createElement('div');
    empty.className = 'wikilink-suggest-empty';
    empty.textContent = t('wikilink_no_match');
    box.appendChild(empty);
    box.hidden = false;
    return;
  }
  wikiSuggest.items.forEach((file, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'wikilink-suggest-item' + (i === wikiSuggest.active ? ' active' : '');
    item.dataset.idx = String(i);
    item.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.className = 'wikilink-suggest-name';
    name.textContent = file.name;
    item.appendChild(name);
    if (file.path !== file.name + '.md') {
      const path = document.createElement('span');
      path.className = 'wikilink-suggest-path';
      path.textContent = file.path;
      item.appendChild(path);
    }
    box.appendChild(item);
  });
  box.hidden = false;
}

/** Place the popup at the caret, flipping above the line if it would overflow. */
function positionWikiSuggest() {
  const editor = $('#editor');
  const box = $('#wikilink-suggest');
  if (!box || box.hidden) return;
  const coords = caretCoordinates(editor, editor.selectionStart);
  const surface = editor.parentElement; // .editor-surface (position: relative)
  const top = coords.top - editor.scrollTop + coords.height;
  const left = Math.max(4, coords.left - editor.scrollLeft);
  box.style.left = Math.min(left, surface.clientWidth - box.offsetWidth - 4) + 'px';
  if (top + box.offsetHeight > surface.clientHeight && coords.top - editor.scrollTop > box.offsetHeight) {
    // Not enough room below — show above the current line.
    box.style.top = (coords.top - editor.scrollTop - box.offsetHeight - 2) + 'px';
  } else {
    box.style.top = top + 'px';
  }
}

function updateWikiSuggest() {
  if (state.viewing) { closeWikiSuggest(); return; }
  const ctx = detectWikilinkContext();
  if (!ctx) { closeWikiSuggest(); return; }
  const notes = mdNoteList();
  wikiSuggest.notes = notes;
  wikiSuggest.items = filterNotes(notes, ctx.query);
  wikiSuggest.queryStart = ctx.queryStart;
  wikiSuggest.active = 0;
  wikiSuggest.open = true;
  renderWikiSuggest();
  positionWikiSuggest();
}

/** Insert the chosen note as a `[[link]]`, replacing the typed query. */
function selectWikiSuggest(index) {
  const file = wikiSuggest.items[index];
  if (!file) return;
  const editor = $('#editor');
  const value = editor.value;
  const pos = editor.selectionStart;
  const name = wikiLinkName(file, wikiSuggest.notes || mdNoteList());
  let tail = value.slice(pos);
  if (tail.startsWith(']]')) tail = tail.slice(2); // avoid doubling the closer
  const head = value.slice(0, wikiSuggest.queryStart); // keeps the leading `[[`
  editor.value = head + name + ']]' + tail;
  const caret = head.length + name.length + 2;
  editor.selectionStart = editor.selectionEnd = caret;
  closeWikiSuggest();
  editor.focus();
  fireEditorInput();
}

/** Toolbar wikilink button: drop a `[[` at the caret and open the popup. */
function startWikilink() {
  if (state.viewing) setViewMode(false);
  const editor = $('#editor');
  const { selectionStart: s, selectionEnd: e, value } = editor;
  const sel = value.slice(s, e); // reuse any selected text as the initial query
  const insert = '[[' + sel;
  editor.value = value.slice(0, s) + insert + value.slice(e);
  editor.selectionStart = editor.selectionEnd = s + insert.length;
  editor.focus();
  fireEditorInput();
  updateWikiSuggest();
}

(function setupWikiSuggest() {
  const editor = $('#editor');
  const box = $('#wikilink-suggest');
  if (!editor || !box) return;

  editor.addEventListener('input', updateWikiSuggest);
  editor.addEventListener('click', updateWikiSuggest);

  editor.addEventListener('keydown', (e) => {
    if (!wikiSuggest.open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      wikiSuggest.active = Math.min(wikiSuggest.active + 1, wikiSuggest.items.length - 1);
      renderWikiSuggest();
      const el = box.querySelector('.wikilink-suggest-item.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      wikiSuggest.active = Math.max(wikiSuggest.active - 1, 0);
      renderWikiSuggest();
      const el = box.querySelector('.wikilink-suggest-item.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (!wikiSuggest.items.length) { closeWikiSuggest(); return; }
      e.preventDefault();
      selectWikiSuggest(wikiSuggest.active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeWikiSuggest();
    }
  });

  // Tap/click a suggestion (mousedown so it beats the textarea blur).
  box.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.wikilink-suggest-item');
    if (!item) return;
    e.preventDefault();
    selectWikiSuggest(Number(item.dataset.idx));
  });

  editor.addEventListener('blur', () => {
    // Delay so a suggestion tap (which blurs the textarea) still registers.
    setTimeout(closeWikiSuggest, 150);
  });
  editor.addEventListener('scroll', () => {
    if (wikiSuggest.open) positionWikiSuggest();
  });
})();

$('#preview').addEventListener('click', (e) => {
  const link = e.target.closest('a.wo-wikilink');
  if (link) {
    e.preventDefault();
    const target = link.dataset.target;
    if (target) openFile(target);
  }
});

// Toggling a task-list checkbox in reading mode updates the source `- [ ]`
// marker and persists the change. Checkboxes carry a document-order index that
// maps to the Nth task line in the markdown source.
$('#preview').addEventListener('change', async (e) => {
  const box = e.target.closest('input.wo-task');
  if (!box || !state.current) return;
  const index = Number(box.dataset.taskIndex);
  if (!toggleTaskInSource(index, box.checked)) {
    return;
  }
  try {
    await saveCurrent();
  } catch (err) {
    // Revert the checkbox if the save failed so UI and source stay in sync.
    box.checked = !box.checked;
    toggleTaskInSource(index, box.checked);
  }
});

/**
 * Flip the Nth task-list marker in the editor source to checked/unchecked.
 * Returns true when a matching line was found and updated.
 */
function toggleTaskInSource(index, checked) {
  const editor = $('#editor');
  const lines = editor.value.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*[-*+]\s+\[)([ xX])(\])/.exec(lines[i]);
    if (!m) continue;
    if (count === index) {
      const at = m[1].length;
      lines[i] = lines[i].slice(0, at) + (checked ? 'x' : ' ') + lines[i].slice(at + 1);
      editor.value = lines.join('\n');
      return true;
    }
    count++;
  }
  return false;
}

async function saveCurrent(opts = {}) {
  if (!state.current) return;
  const auto = !!opts.auto;
  const payload = {
    path: state.current.path,
    content: await encryptContent($('#editor').value),
    baseVersion: state.current.version,
  };
  markSaving(true);
  let result;
  try {
    result = await api('PUT', '/api/file', payload);
  } catch (e) {
    markSaving(false);
    if (e.status === 409) {
      // Autosave must never silently clobber a change made on another device.
      // Pause autosave for this file and let the user resolve it manually.
      if (auto) {
        noteAutosaveConflict(payload.path);
        return;
      }
      const overwrite = await uiConfirm(t('conflict_file_title'), {
        message: t('conflict_file_msg'),
        okText: t('overwrite'),
        cancelText: t('reload_latest'),
      });
      if (overwrite) {
        delete payload.baseVersion;
        result = await api('PUT', '/api/file', payload);
      } else {
        await reloadActiveEditor();
        flash(t('reloaded_latest'));
        return;
      }
    } else {
      throw e;
    }
  }
  markSaving(false);
  clearAutosaveConflict(payload.path);
  if (result && result.version) state.current.version = result.version;
  state.dirty = false;
  const tab = activeTab();
  if (tab) {
    tab.version = state.current.version;
    tab.dirty = false;
    tab.content = $('#editor').value;
  }
  renderTabbar();
  renderSaveStatus();
  invalidateSearchIndex();
  invalidateGraphCache(); // note content (and thus its links) changed
  if (!auto) flash(t('saved'));
}
$('#save-btn').addEventListener('click', () => saveCurrent());

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    const tab = activeTab();
    if (tab && tab.kind === 'editor') saveCurrent();
    else if (tab && tab.kind === 'excalidraw' && state.excalidraw) saveExcalidraw();
    else if (tab && tab.kind === 'kanban' && tab.kanban) saveKanban();
  }
});

/* ---------- autosave -----------------------------------------------------
 * When enabled (a cross-device preference in the vault settings, default on),
 * edits are persisted to storage a couple of seconds after the user stops
 * typing/drawing. Two timers bound how often we write so the app never hammers
 * the storage backend or trips the server's /api rate limiter:
 *   - idle timer: fires AUTOSAVE_IDLE_MS after the last change (coalesces bursts)
 *   - hard cap:   guarantees a write at least every AUTOSAVE_MAX_MS during
 *                 continuous typing, so a nonstop editor still gets saved.
 * Autosave only ever runs for the ACTIVE, DIRTY file — opening or switching a
 * tab never triggers a write. On a 409 (the file changed on another device) it
 * pauses for that file and leaves the user to resolve it with a manual Save.
 */
const AUTOSAVE_IDLE_MS = 2000;
const AUTOSAVE_MAX_MS = 10000;
const autosave = {
  idleTimer: null,
  hardTimer: null,
  running: false,
  conflictPath: null,
};

/** Autosave on unless the user explicitly turned it off (default true). */
function autosaveEnabled() {
  const v = getPref('autosave');
  return v === undefined ? true : !!v;
}

/** A save-capable, currently-dirty active tab, or null. */
function autosaveTarget() {
  const tab = activeTab();
  if (!tab || !tab.dirty) return null;
  if (tab.kind === 'editor' || tab.kind === 'excalidraw' || tab.kind === 'kanban') {
    return tab;
  }
  return null;
}

function clearAutosaveTimers() {
  if (autosave.idleTimer) clearTimeout(autosave.idleTimer);
  if (autosave.hardTimer) clearTimeout(autosave.hardTimer);
  autosave.idleTimer = null;
  autosave.hardTimer = null;
}

/** Called on every edit. Debounces to idle, but caps the wait at AUTOSAVE_MAX_MS. */
function scheduleAutosave() {
  renderSaveStatus();
  if (!autosaveEnabled()) return;
  const tab = autosaveTarget();
  if (!tab) return;
  // Don't keep retrying a file that lost a conflict — wait for a manual save.
  if (autosave.conflictPath && autosave.conflictPath === tab.path) return;
  if (autosave.idleTimer) clearTimeout(autosave.idleTimer);
  autosave.idleTimer = setTimeout(runAutosave, AUTOSAVE_IDLE_MS);
  if (!autosave.hardTimer) {
    autosave.hardTimer = setTimeout(runAutosave, AUTOSAVE_MAX_MS);
  }
}

/** Perform one autosave of the active dirty tab, dispatching by kind. */
async function runAutosave() {
  clearAutosaveTimers();
  if (autosave.running) {
    // A save is already in flight — re-arm so the latest edits still land.
    scheduleAutosave();
    return;
  }
  if (!autosaveEnabled()) return;
  const tab = autosaveTarget();
  if (!tab) return;
  if (autosave.conflictPath && autosave.conflictPath === tab.path) return;
  autosave.running = true;
  try {
    if (tab.kind === 'editor') await saveCurrent({ auto: true });
    else if (tab.kind === 'excalidraw') await saveExcalidraw({ auto: true });
    else if (tab.kind === 'kanban') await saveKanban({ auto: true });
  } catch {
    // Network/other error — leave the tab dirty; the next edit reschedules.
  } finally {
    autosave.running = false;
  }
}

/** Remember that a file lost an autosave conflict; surface it in the status. */
function noteAutosaveConflict(path) {
  autosave.conflictPath = path;
  flash(t('autosave_conflict'));
  renderSaveStatus();
}

/** A manual save (or reload) resolved the file — resume autosaving it. */
function clearAutosaveConflict(path) {
  if (autosave.conflictPath === path) autosave.conflictPath = null;
}

// Track an in-flight save purely for the "Saving…" status line.
let savingNow = false;
function markSaving(on) {
  savingNow = !!on;
  renderSaveStatus();
}

/* ---------- last-saved status -------------------------------------------- */

// Map the active tab kind to its status <span> in the view header.
const SAVE_STATUS_IDS = {
  editor: 'editor-saved',
  excalidraw: 'excalidraw-saved',
  kanban: 'kanban-saved',
};

/**
 * Paint the "Saved · 2 min ago" / "Unsaved changes" / "Saving…" line next to
 * the active editor's Save button. The saved time is derived from the file's
 * version token (server mtime), so it reflects the real last write and stays
 * correct across devices. Hidden for non-editable views.
 */
function renderSaveStatus() {
  // Only the active view's status element should show anything.
  for (const id of Object.values(SAVE_STATUS_IDS)) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  const tab = activeTab();
  if (!tab) return;
  const el = document.getElementById(SAVE_STATUS_IDS[tab.kind]);
  if (!el) return;
  el.hidden = false;
  el.classList.remove('is-unsaved');
  if (savingNow) {
    el.textContent = t('last_saved_saving');
    return;
  }
  if (autosave.conflictPath && autosave.conflictPath === tab.path) {
    el.textContent = t('autosave_conflict');
    el.classList.add('is-unsaved');
    return;
  }
  if (tab.dirty) {
    el.textContent = t('last_saved_unsaved');
    el.classList.add('is-unsaved');
    return;
  }
  const rel = WOUtil.relativeSavedLabel(WOUtil.mtimeFromVersion(tab.version), Date.now());
  if (!rel) {
    el.hidden = true;
    return;
  }
  el.textContent = t('last_saved_prefix', { when: t(rel.key, { count: rel.count }) });
}

// Keep the relative time fresh ("just now" → "1 min ago") while a file is open.
setInterval(() => {
  if (!savingNow) renderSaveStatus();
}, 20000);

/* ---------- office document viewer (Word / Excel / OpenDocument) ---------- */

// Build a cache-busted URL for a lazy-loaded bundle. These <script> tags are
// injected at runtime (not rendered by EJS), so they must carry the asset
// version themselves — otherwise the immutable 1-year cache serves a stale copy
// forever after an update.
function bundleUrl(file) {
  const v = window.__WO_ASSET_V__;
  return '/public/js/' + file + (v ? '?v=' + encodeURIComponent(v) : '');
}

let officeLoading = null;
function ensureOffice() {
  if (window.OfficeViewer) return Promise.resolve();
  if (officeLoading) return officeLoading;
  officeLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = bundleUrl('office-bundle.js');
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load the document viewer.'));
    document.body.appendChild(s);
  });
  return officeLoading;
}

async function renderOffice(path, ext, body) {
  body.innerHTML = '';
  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = t('loading');
  body.appendChild(status);
  try {
    const key = await ensureVaultKey();
    const res = await fetch(attachmentUrl(path), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('fetch failed');
    const cipher = new Uint8Array(await res.arrayBuffer());
    const plain = await window.WOCrypto.decryptBytesMaybe(key, cipher);
    // OfficeViewer expects an ArrayBuffer; hand it the decrypted bytes' buffer.
    const buf = plain.buffer.slice(
      plain.byteOffset,
      plain.byteOffset + plain.byteLength,
    );
    await ensureOffice();
    // Guard against the tab being closed (its pane detached) while loading.
    if (!body.isConnected) return;
    body.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'office-doc';
    body.appendChild(container);
    if (ext === 'docx') {
      await window.OfficeViewer.renderDocx(container, buf);
    } else if (ext === 'odt') {
      window.OfficeViewer.renderOdt(container, buf);
    } else {
      window.OfficeViewer.renderSpreadsheet(container, buf);
    }
  } catch (e) {
    console.error('office preview failed:', ext, e);
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('no_preview');
    body.appendChild(p);
  }
}

/* ---------- epub e-book reader ---------- */

let epubLoading = null;
function ensureEpub() {
  if (window.EpubViewer) return Promise.resolve();
  if (epubLoading) return epubLoading;
  epubLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = bundleUrl('epub-bundle.js');
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load the e-book reader.'));
    document.body.appendChild(s);
  });
  return epubLoading;
}

async function renderEpub(tab, body) {
  body.innerHTML = '';
  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = t('loading');
  body.appendChild(status);
  try {
    const key = await ensureVaultKey();
    const res = await fetch(attachmentUrl(tab.path), {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('fetch failed');
    const cipher = new Uint8Array(await res.arrayBuffer());
    const plain = await window.WOCrypto.decryptBytesMaybe(key, cipher);
    // EpubViewer expects an ArrayBuffer; hand it the decrypted bytes' buffer.
    const buf = plain.buffer.slice(
      plain.byteOffset,
      plain.byteOffset + plain.byteLength,
    );
    await ensureEpub();
    // Guard against the tab being closed (its pane detached) while loading.
    if (!body.isConnected) return;
    body.innerHTML = '';
    const savedLoc = getReadingPos(tab.path);
    tab.epub = window.EpubViewer.mount(body, buf, {
      prevLabel: t('epub_prev'),
      nextLabel: t('epub_next'),
      locationKey: tab.path,
      // Cross-device resume: prefer the position synced from the vault; the
      // bundle still caches locally too. Save each page turn back to the vault.
      initialLocation: typeof savedLoc === 'string' ? savedLoc : undefined,
      onLocation: (cfi) => setReadingPos(tab.path, cfi),
    });
  } catch (e) {
    console.error('epub preview failed:', e);
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('no_preview');
    body.appendChild(p);
  }
}

/* ---------- pdf reader ---------- */

let pdfLoading = null;
function ensurePdf() {
  if (window.PdfViewer) return Promise.resolve();
  if (pdfLoading) return pdfLoading;
  pdfLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = bundleUrl('pdf-bundle.js');
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load the PDF reader.'));
    document.body.appendChild(s);
  });
  return pdfLoading;
}

async function renderPdf(tab, body) {
  body.innerHTML = '';
  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = t('loading');
  body.appendChild(status);
  try {
    const key = await ensureVaultKey();
    const res = await fetch(attachmentUrl(tab.path), {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('fetch failed');
    const cipher = new Uint8Array(await res.arrayBuffer());
    const plain = await window.WOCrypto.decryptBytesMaybe(key, cipher);
    const buf = plain.buffer.slice(
      plain.byteOffset,
      plain.byteOffset + plain.byteLength,
    );
    await ensurePdf();
    if (!body.isConnected) return;
    body.innerHTML = '';
    // Keep the header Download button working (we render via pdf.js, not an
    // iframe blob) using the bytes we already decrypted — no second fetch.
    try {
      tab.blobUrl = URL.createObjectURL(
        new Blob([buf], { type: 'application/pdf' }),
      );
    } catch (e) {
      /* download stays disabled if blob creation fails */
    }
    const savedPage = getReadingPos(tab.path);
    const savedZoom = getPref('pdfZoom');
    tab.pdf = window.PdfViewer.mount(body, buf, {
      workerSrc: bundleUrl('pdf-worker.js'),
      // Cross-device resume: jump to the page synced from the vault, and save
      // the page back as the user scrolls.
      initialPage: typeof savedPage === 'number' ? savedPage : undefined,
      onPage: (n) => setReadingPos(tab.path, n),
      // Zoom is a synced preference (shared across PDFs), not per-file.
      initialZoom: typeof savedZoom === 'number' ? savedZoom : undefined,
      onZoom: (z) => persistPref('pdfZoom', z),
      zoomInLabel: t('pdf_zoom_in'),
      zoomOutLabel: t('pdf_zoom_out'),
      errorText: t('no_preview'),
    });
  } catch (e) {
    console.error('pdf preview failed:', e);
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('no_preview');
    body.appendChild(p);
  }
}

/* ---------- excalidraw ---------- */

let excalidrawLoading = null;
function ensureExcalidraw() {
  if (window.ExcalidrawEditor) return Promise.resolve();
  if (excalidrawLoading) return excalidrawLoading;
  excalidrawLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = bundleUrl('excalidraw-bundle.js');
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Excalidraw editor.'));
    document.body.appendChild(s);
  });
  return excalidrawLoading;
}

async function saveExcalidraw(opts = {}) {
  if (!state.excalidraw || !state.current) return;
  const auto = !!opts.auto;
  const json = window.ExcalidrawEditor.serialize(state.excalidraw);
  const payload = {
    path: state.current.path,
    content: await encryptContent(json),
    baseVersion: state.current.version,
  };
  markSaving(true);
  let result;
  try {
    result = await api('PUT', '/api/file', payload);
  } catch (e) {
    markSaving(false);
    if (e.status === 409) {
      if (auto) {
        noteAutosaveConflict(payload.path);
        return;
      }
      const overwrite = await uiConfirm(t('conflict_drawing_title'), {
        message: t('conflict_drawing_msg'),
        okText: t('overwrite'),
        cancelText: t('cancel'),
      });
      if (!overwrite) {
        flash(t('save_cancelled'));
        return;
      }
      delete payload.baseVersion;
      result = await api('PUT', '/api/file', payload);
    } else {
      throw e;
    }
  }
  markSaving(false);
  clearAutosaveConflict(payload.path);
  if (result && result.version) state.current.version = result.version;
  const tab = activeTab();
  if (tab) {
    tab.version = state.current.version;
    tab.dirty = false;
  }
  state.dirty = false;
  renderTabbar();
  renderSaveStatus();
  if (!auto) flash(t('saved'));
}
$('#excalidraw-save').addEventListener('click', () => saveExcalidraw());

async function saveKanban(opts = {}) {
  const auto = !!opts.auto;
  const tab = activeTab();
  if (!tab || tab.kind !== 'kanban' || !tab.kanban || !state.current) return;
  const json = WOUtil.kanbanSerialize(tab.kanban.getBoard());
  const payload = {
    path: state.current.path,
    content: await encryptContent(json),
    baseVersion: state.current.version,
  };
  markSaving(true);
  let result;
  try {
    result = await api('PUT', '/api/file', payload);
  } catch (e) {
    markSaving(false);
    if (e.status === 409) {
      if (auto) {
        noteAutosaveConflict(payload.path);
        return;
      }
      const overwrite = await uiConfirm(t('conflict_kanban_title'), {
        message: t('conflict_kanban_msg'),
        okText: t('overwrite'),
        cancelText: t('cancel'),
      });
      if (!overwrite) {
        flash(t('save_cancelled'));
        return;
      }
      delete payload.baseVersion;
      result = await api('PUT', '/api/file', payload);
    } else {
      throw e;
    }
  }
  markSaving(false);
  clearAutosaveConflict(payload.path);
  if (result && result.version) state.current.version = result.version;
  tab.version = state.current.version;
  tab.dirty = false;
  state.dirty = false;
  renderTabbar();
  renderSaveStatus();
  if (!auto) flash(t('saved'));
}
$('#kanban-save').addEventListener('click', () => saveKanban());

/* ---------- create / upload / import ---------- */

async function createNoteIn(targetDir) {
  let name = await uiPrompt(t('prompt_new_note_title'), 'Untitled.md', {
    title: t('prompt_new_note_title'),
    placeholder: t('prompt_new_note_ph'),
  });
  if (!name) return;
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
  const path = targetDir ? targetDir + '/' + name : name;
  await api('PUT', '/api/file', { path, content: await encryptContent('') });
  expandAncestors(targetDir);
  await loadTree();
  openFile(path);
}

async function createFileIn(targetDir) {
  let name = await uiPrompt(t('prompt_new_file_title'), 'Untitled.excalidraw', {
    title: t('prompt_new_file_title'),
    message: t('prompt_new_file_msg'),
    placeholder: t('prompt_new_file_ph'),
  });
  if (!name) return;
  // "New drawing" defaults to an Excalidraw canvas when no extension is typed.
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.excalidraw';
  const path = targetDir ? targetDir + '/' + name : name;
  try {
    await api('PUT', '/api/file', { path, content: await encryptContent('') });
  } catch (e) {
    flash(e.message || t('could_not_create'));
    return;
  }
  expandAncestors(targetDir);
  await loadTree();
  openFile(path);
}

// Boards always land in the fixed `Kanban/` folder (created if missing),
// regardless of the selected folder — mirrors how templates work.
async function createKanbanIn(_dir, presetName) {
  // `presetName` (from the launcher's field) skips the prompt; an empty value
  // still falls back to the prompt so a bare "New board" click keeps working.
  let name = (presetName || '').trim();
  if (!name) {
    name = await uiPrompt(t('prompt_new_kanban_title'), 'Untitled.kanban', {
      title: t('prompt_new_kanban_title'),
      message: t('prompt_new_kanban_msg'),
      placeholder: t('prompt_new_kanban_ph'),
    });
  }
  if (!name) return false;
  // Default to the .kanban board format when no extension is typed.
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.kanban';
  const path = KANBAN_DIR + '/' + name;
  // Seed with localized starter columns so a new board is immediately usable.
  const board = WOUtil.kanbanDefaultBoard([
    t('kanban_default_col1'),
    t('kanban_default_col2'),
    t('kanban_default_col3'),
  ]);
  await api('POST', '/api/folder', { path: KANBAN_DIR }).catch(() => {});
  try {
    await api('PUT', '/api/file', {
      path,
      content: await encryptContent(WOUtil.kanbanSerialize(board)),
    });
  } catch (e) {
    flash(e.message || t('could_not_create'));
    return false;
  }
  expandAncestors(KANBAN_DIR);
  await loadTree();
  openFile(path);
  return true;
}

// Open the Kanban launcher: existing boards to open with one click, plus a
// field to create a new board by name. Mirrors the Web links open-directly UX.
async function openKanbanLauncher() {
  let boards = [];
  try {
    boards = await listKanbanBoards();
  } catch {
    boards = [];
  }
  openLauncher({
    title: t('kanban_launcher_title'),
    newGroup: t('kanban_launcher_new'),
    newPlaceholder: t('prompt_new_kanban_ph'),
    startLabel: t('kanban_launcher_new'),
    onStart: (value) => createKanbanIn(state.selectedDir, value),
    existingGroup: t('kanban_launcher_open_group'),
    emptyText: t('kanban_launcher_empty'),
    items: boards.map((p) => ({ label: p, value: p })),
    onOpen: (p) => openFile(p),
  });
}

// Every `.kanban` board in the vault, path-sorted (used by the launcher list).
async function listKanbanBoards() {
  const list = (await api('GET', '/api/files')) || [];
  return WOUtil.kanbanBoardsFromPaths(list.map((e) => e && e.path));
}

/**
 * Create a markdown note (in `Kanban/Notes`) to be linked to a card, and return
 * `{ path, name }` for the kanban editor to select. Returns null if the user
 * cancels or creation fails. `suggested` pre-fills the prompt from the card
 * title so a card "Design spec" offers "Design spec.md".
 */
async function createKanbanLinkedNote(suggested) {
  const seed = (suggested || '').trim();
  let name = await uiPrompt(
    t('prompt_new_kanban_note_title'),
    seed ? seed + '.md' : 'Untitled.md',
    {
      title: t('prompt_new_kanban_note_title'),
      message: t('prompt_new_kanban_note_msg'),
      placeholder: t('prompt_new_note_ph'),
    },
  );
  if (!name) return null;
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
  const dir = KANBAN_DIR + '/Notes';
  const path = dir + '/' + name;
  const title = name.replace(/\.[^.]+$/, '');
  await api('POST', '/api/folder', { path: dir }).catch(() => {});
  try {
    await api('PUT', '/api/file', {
      path,
      content: await encryptContent('# ' + title + '\n'),
    });
  } catch (e) {
    flash(e.message || t('could_not_create'));
    return null;
  }
  expandAncestors(dir);
  await loadTree();
  return { path, name: title };
}

async function createFolderIn(targetDir) {
  const name = await uiPrompt(t('prompt_new_folder_title'), '', {
    title: t('prompt_new_folder_title'),
    placeholder: t('prompt_new_folder_ph'),
  });
  if (!name) return;
  const path = targetDir ? targetDir + '/' + name : name;
  try {
    await api('POST', '/api/folder', { path });
  } catch (e) {
    flash(e.message || t('could_not_create'));
    return;
  }
  expandAncestors(path);
  await loadTree();
  // Only point the cursor at the new folder if it actually landed in the
  // vault. If the storage backend silently failed to create it, selecting it
  // anyway would leave the breadcrumb pointing at a folder that does not exist
  // (and a later file write would resurrect that phantom path). Surface the
  // failure instead.
  if (treeHasDir(state.tree, path)) {
    selectDirByPath(path);
  } else {
    flash(t('could_not_create'));
  }
}

/** True when `path` exists as a directory node anywhere in `nodes`. */
function treeHasDir(nodes, path) {
  for (const node of nodes || []) {
    if (node.type !== 'dir') continue;
    if (node.path === path) return true;
    if (path.startsWith(node.path + '/') && treeHasDir(node.children, path)) {
      return true;
    }
  }
  return false;
}

$('#new-file').addEventListener('click', () => createFileIn(state.selectedDir));
$('#new-kanban') &&
  $('#new-kanban').addEventListener('click', () => openKanbanLauncher());
$('#new-folder').addEventListener('click', () => createFolderIn(state.selectedDir));

/* ---------- notes: daily notes, templates, calendar ---------------------- */

// websidian's own internal, hidden folder (encrypted app settings live here).
const RESERVED_DIR = '.websidian';
const NOTES_SETTINGS_PATH = RESERVED_DIR + '/settings.json';
// User templates live in a fixed top-level folder, mirroring Obsidian.
const TEMPLATES_DIR = 'Templates';
const DEFAULT_DAILY_DIR = 'Daily';
// Kanban boards live in a fixed top-level folder, created on first use.
const KANBAN_DIR = 'Kanban';

// The full, decrypted settings object from `.websidian/settings.json`. Holds
// everything that should follow the user across devices: the daily-note folder,
// UI preferences (theme/font/contrast/language) and per-file reading positions
// (epub CFI, pdf page). `null` until first load. localStorage stays the instant
// cache for UI prefs — this file is only the cross-device source of truth, read
// once after unlock and written back on a debounce, so it never blocks the UI.
let vaultSettings = null;

/** Load (and cache) the full encrypted settings object; {} when absent. */
async function loadVaultSettings(force) {
  if (vaultSettings && !force) return vaultSettings;
  let cfg = {};
  try {
    const data = await api(
      'GET',
      '/api/file?path=' + encodeURIComponent(NOTES_SETTINGS_PATH),
    );
    cfg = JSON.parse(await decryptContent(data.content || '')) || {};
  } catch {
    cfg = {}; // no settings file yet, or unreadable — use defaults
  }
  if (!cfg || typeof cfg !== 'object') cfg = {};
  vaultSettings = cfg;
  return vaultSettings;
}

let settingsSaveTimer = null;
/** Encrypt and write the cached settings object now. */
async function flushVaultSettings() {
  settingsSaveTimer = null;
  if (!vaultSettings) return;
  await api('POST', '/api/folder', { path: RESERVED_DIR }).catch(() => {});
  await api('PUT', '/api/file', {
    path: NOTES_SETTINGS_PATH,
    content: await encryptContent(JSON.stringify(vaultSettings)),
  });
}
/** Debounced background write — coalesces rapid changes (e.g. page turns). */
function saveVaultSettingsSoon() {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(
    () => flushVaultSettings().catch(() => {}),
    800,
  );
}

/** Current daily-note folder (normalized), from settings or the default. */
function getDailyNotePath() {
  const raw = vaultSettings && vaultSettings.dailyNotePath;
  return WOUtil.normalizeVaultPath(raw || '') || DEFAULT_DAILY_DIR;
}

// ---- Cross-device UI preferences + reading positions ----------------------
// localStorage is applied instantly at page load (see partials/head.ejs) so the
// UI never flashes; these helpers additionally mirror the value into the vault
// settings file so it follows the user to other devices.

/** Read a UI preference from the loaded settings (undefined if unset). */
function getPref(key) {
  return vaultSettings && vaultSettings.prefs
    ? vaultSettings.prefs[key]
    : undefined;
}

/** Record a UI preference into the settings object (debounced write). */
function persistPref(key, value) {
  if (!vaultSettings) return; // not synced yet — localStorage still holds it
  if (!vaultSettings.prefs || typeof vaultSettings.prefs !== 'object') {
    vaultSettings.prefs = {};
  }
  if (vaultSettings.prefs[key] === value) return; // no change → no write/echo
  vaultSettings.prefs[key] = value;
  saveVaultSettingsSoon();
}

/**
 * After unlock, reconcile the device with the vault: apply any UI preferences
 * saved on another device (theme/font/contrast/language) over the local cache.
 * Runs before tabs are restored so reading positions are available at mount.
 * The apply* helpers short-circuit persistPref when the value is unchanged, so
 * this never echoes a write back.
 */
async function syncSettingsFromVault() {
  let cfg;
  try {
    cfg = await loadVaultSettings();
  } catch {
    return;
  }
  const p = (cfg && cfg.prefs) || {};
  if (p.theme === 'light' || p.theme === 'dark') applyTheme(p.theme);
  if (Number.isFinite(p.fontSize)) applyFontSize(p.fontSize);
  if (p.contrast === 'high' || p.contrast === 'normal') applyContrast(p.contrast);
  if (
    p.lang &&
    window.I18N &&
    typeof window.I18N.set === 'function' &&
    p.lang !== window.I18N.lang
  ) {
    window.I18N.set(p.lang);
  }
}

/** Saved reading position for a file (epub CFI string / pdf page number). */
function getReadingPos(path) {
  const r = vaultSettings && vaultSettings.reading;
  if (r && Object.prototype.hasOwnProperty.call(r, path)) return r[path];
  return null;
}

/** Store a file's reading position (debounced write). */
function setReadingPos(path, pos) {
  if (pos == null || pos === '') return;
  if (!vaultSettings) return; // not synced yet
  if (!vaultSettings.reading || typeof vaultSettings.reading !== 'object') {
    vaultSettings.reading = {};
  }
  if (vaultSettings.reading[path] === pos) return;
  vaultSettings.reading[path] = pos;
  saveVaultSettingsSoon();
}

/** True if a file exists at `path` anywhere in the current tree. */
function treeHasFile(nodes, path) {
  for (const node of nodes || []) {
    if (node.type === 'file' && node.path === path) return true;
    if (node.type === 'dir' && treeHasFile(node.children, path)) return true;
  }
  return false;
}

/** List markdown templates (paths) found in the Templates folder. */
function listTemplates() {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === 'dir') {
        if (node.path === TEMPLATES_DIR || node.path.startsWith(TEMPLATES_DIR + '/')) {
          walk(node.children);
        }
      } else if (
        node.path.startsWith(TEMPLATES_DIR + '/') &&
        (node.ext === 'md' || node.ext === 'markdown')
      ) {
        out.push(node.path);
      }
    }
  };
  walk(state.tree);
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Create a new template file in the Templates folder and open it. */
async function createTemplate() {
  let name = await uiPrompt(t('prompt_new_template_title'), 'Untitled.md', {
    title: t('prompt_new_template_title'),
    message: t('prompt_new_template_msg'),
    placeholder: t('prompt_new_note_ph'),
  });
  if (!name) return;
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
  const path = TEMPLATES_DIR + '/' + name;
  await api('POST', '/api/folder', { path: TEMPLATES_DIR }).catch(() => {});
  try {
    await api('PUT', '/api/file', {
      path,
      content: await encryptContent('# {{title}}\n'),
    });
  } catch (e) {
    flash(e.message || t('could_not_create'));
    return;
  }
  expandAncestors(TEMPLATES_DIR);
  await loadTree();
  openFile(path);
}

/**
 * Create a markdown note, optionally seeded from a template. Prompts for the
 * template (blank = default) then the name, applying {{date}}/{{time}}/{{title}}
 * placeholders to the chosen template's content.
 */
async function createNoteWithTemplate(targetDir) {
  const templates = listTemplates();
  let templatePath = '';
  if (templates.length) {
    templatePath = await pickTemplate(templates);
    if (templatePath === null) return; // cancelled
  }
  let name = await uiPrompt(t('prompt_new_note_title'), 'Untitled.md', {
    title: t('prompt_new_note_title'),
    placeholder: t('prompt_new_note_ph'),
  });
  if (!name) return;
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
  const path = targetDir ? targetDir + '/' + name : name;
  let body = '';
  if (templatePath) {
    try {
      const data = await api(
        'GET',
        '/api/file?path=' + encodeURIComponent(templatePath),
      );
      const raw = await decryptContent(data.content || '');
      body = WOUtil.applyTemplate(raw, { title: name.replace(/\.[^.]+$/, '') });
    } catch {
      flash(t('template_load_failed'));
    }
  }
  try {
    await api('PUT', '/api/file', { path, content: await encryptContent(body) });
  } catch (e) {
    flash(e.message || t('could_not_create'));
    return;
  }
  expandAncestors(targetDir);
  await loadTree();
  openFile(path);
}

/**
 * Show the template picker overlay and resolve with the chosen template path,
 * '' for "no template", or null if cancelled.
 */
function pickTemplate(templates) {
  return new Promise((resolve) => {
    const overlay = $('#template-overlay');
    const list = $('#template-list');
    list.innerHTML = '';
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      overlay.hidden = true;
      list.innerHTML = '';
      resolve(val);
    };
    const addOption = (label, value, icon) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'template-option';
      const i = document.createElement('i');
      i.className = 'bi ' + icon;
      const span = document.createElement('span');
      span.textContent = label;
      btn.append(i, span);
      btn.addEventListener('click', () => done(value));
      list.appendChild(btn);
    };
    addOption(t('template_blank'), '', 'bi-file-earmark');
    for (const path of templates) {
      addOption(
        path.slice(TEMPLATES_DIR.length + 1).replace(/\.[^.]+$/, ''),
        path,
        'bi-file-earmark-text',
      );
    }
    $('#template-cancel').onclick = () => done(null);
    $('#template-close').onclick = () => done(null);
    overlay.addEventListener(
      'click',
      (e) => {
        if (e.target === overlay) done(null);
      },
      { once: true },
    );
    overlay.hidden = false;
  });
}

/** Create (or open, if it already exists) today's daily note. */
async function createDailyNote() {
  await loadVaultSettings();
  const dir = getDailyNotePath();
  const name = WOUtil.formatDailyDate(new Date()) + '.md';
  const path = dir + '/' + name;
  if (treeHasFile(state.tree, path)) {
    openFile(path);
    return;
  }
  await api('POST', '/api/folder', { path: dir }).catch(() => {});
  try {
    await api('PUT', '/api/file', {
      path,
      content: await encryptContent('# ' + WOUtil.formatDailyDate(new Date()) + '\n'),
    });
  } catch (e) {
    flash(e.message || t('could_not_create'));
    return;
  }
  expandAncestors(dir);
  await loadTree();
  openFile(path);
}

$('#new-note').addEventListener('click', () =>
  createNoteWithTemplate(state.selectedDir),
);
$('#new-daily') &&
  $('#new-daily').addEventListener('click', () => createDailyNote());
$('#new-template') &&
  $('#new-template').addEventListener('click', () => createTemplate());

$('#upload-btn').addEventListener('click', () => $('#upload-input').click());
$('#upload-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  const limitErr = uploadLimitError(
    files.map((f) => ({ path: f.name, size: f.size })),
  );
  if (limitErr) {
    await uiAlert(t('upload_failed_title'), { message: limitErr });
    return;
  }
  showLoading(t('uploading'));
  try {
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', await encryptFileBlob(file), file.name);
      fd.append('folder', state.selectedDir);
      await api('POST', '/api/upload', fd, true);
    }
    await loadTree();
    flash(t('uploaded_n', { n: files.length }));
  } catch (err) {
    await uiAlert(t('upload_failed_title'), {
      message: err.message || t('upload_failed_msg'),
    });
  } finally {
    hideLoading();
  }
});

// Import offers a styled choice between a .zip file (no browser warning) and a
// folder upload. Folder selection relies on `webkitdirectory`, which makes the
// browser show its own non-styleable "upload all files" confirmation — the zip
// path avoids that entirely.
function openImportModal() {
  $('#import-overlay').hidden = false;
}
function closeImportModal() {
  $('#import-overlay').hidden = true;
}

async function runImport(files) {
  if (!files.length) return;
  // Folders upload through the resumable, chunked tus uploader (window.WOUpload),
  // which encrypts each file in the browser and sends it in 50 MB chunks so no
  // request exceeds Cloudflare's 100 MB body limit. The folder structure is
  // preserved via each file's webkitRelativePath. No artificial size/count caps
  // here — the storage quota is the real limit, enforced server-side.
  try {
    const entries = files.map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }));
    // Per-file size is the one hard cap that still applies to folder imports:
    // a single file over the limit can never upload (the server rejects it), so
    // tell the user up front which file is too large instead of failing silently.
    // Total-size / file-count caps are intentionally NOT applied here — folders
    // upload chunked and are only bounded by the storage quota (enforced server-side).
    const big = entries.find((en) => en.file.size > MAX_UPLOAD_FILE_BYTES);
    if (big) {
      await uiAlert(t('import_failed_title'), {
        message: t('file_too_large', {
          name: (big.relativePath || big.file.name).split('/').pop(),
        }),
      });
      return;
    }
    const dir = state.selectedDir;
    await window.WOUpload.start({
      entries,
      baseDir: dir,
      getKey: ensureVaultKey,
      t,
      onFileComplete: refreshTreeSoon,
      onComplete: () => {
        expandAncestors(dir);
        loadTree();
      },
    });
  } catch (err) {
    await uiAlert(t('import_failed_title'), {
      message: err.message || t('import_failed_msg'),
    });
  }
}

(function setupImport() {
  const folderInput = $('#import-input');
  const supportsDir = 'webkitdirectory' in document.createElement('input');
  if (supportsDir) {
    folderInput.webkitdirectory = true;
  } else {
    folderInput.setAttribute('accept', '*/*');
  }

  const onChange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await runImport(files);
  };
  folderInput.addEventListener('change', onChange);

  $('#import-btn').addEventListener('click', openImportModal);
  $('#import-modal-close').addEventListener('click', closeImportModal);
  $('#import-overlay').addEventListener('click', (e) => {
    if (e.target === $('#import-overlay')) closeImportModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#import-overlay').hidden) closeImportModal();
  });
  $('#import-folder-choice').addEventListener('click', () => {
    closeImportModal();
    folderInput.click();
  });
})();

$('#export-btn').addEventListener('click', async () => {
  const btn = $('#export-btn');
  if (btn.disabled) return;
  const icon = btn.querySelector('i');
  const originalIconClass = icon ? icon.className : '';
  btn.disabled = true;
  if (icon) icon.className = 'bi bi-arrow-repeat spin';
  try {
    // Build the export archive in the browser: the server only holds
    // ciphertext, so we fetch every file, decrypt it with the vault key, and
    // zip the plaintext locally. Show real per-file progress since a large vault
    // can take minutes.
    const key = await ensureVaultKey();
    showProgress(t('export_progress'));
    // Full backup: include hidden files (e.g. .websidian/settings.json) so the
    // export is a complete copy of the vault.
    const list = await api('GET', '/api/files?hidden=1');
    const files = {};
    const total = (list || []).length;
    let done = 0;
    updateProgress(0, total, t('progress_files', { done: 0, total }));
    for (const entry of list || []) {
      const res = await fetch(attachmentUrl(entry.path), {
        credentials: 'same-origin',
      });
      if (res.ok) {
        const cipher = new Uint8Array(await res.arrayBuffer());
        try {
          files[entry.path] = await window.WOCrypto.decryptBytesMaybe(
            key,
            cipher,
          );
        } catch (e) {
          /* skip files that fail to decrypt */
        }
      }
      done += 1;
      updateProgress(done, total, t('progress_files', { done, total }));
    }
    // Always include websidian's own settings file. Some storage backends omit
    // dotfiles from the file listing, so fetch it explicitly by path (read by
    // path works everywhere) to guarantee a complete backup.
    if (!files[NOTES_SETTINGS_PATH]) {
      try {
        const res = await fetch(attachmentUrl(NOTES_SETTINGS_PATH), {
          credentials: 'same-origin',
        });
        if (res.ok) {
          const cipher = new Uint8Array(await res.arrayBuffer());
          files[NOTES_SETTINGS_PATH] = await window.WOCrypto.decryptBytesMaybe(
            key,
            cipher,
          );
        }
      } catch (e) {
        /* no settings file yet — nothing to add */
      }
    }
    // Packaging the zip is a single synchronous step with no sub-progress.
    updateProgress(total, total, t('export_packaging'));
    const zipped = window.WOZip.zip(files);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = 'vault-' + stamp + '.zip';
    const blob = new Blob([zipped], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    flash(t('export_failed'));
  } finally {
    hideProgress();
    btn.disabled = false;
    if (icon) icon.className = originalIconClass;
  }
});

/** Trigger a browser download for an in-memory blob. */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Fetch a single vault file, decrypt it, and download the plaintext. */
async function downloadFileNode(node) {
  const key = await ensureVaultKey();
  const res = await fetch(attachmentUrl(node.path), {
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('fetch failed');
  const cipher = new Uint8Array(await res.arrayBuffer());
  const plain = await window.WOCrypto.decryptBytesMaybe(key, cipher);
  const blob = new Blob([plain], { type: mimeForPath(node.path) });
  triggerDownload(blob, basename(node.path));
}

/** Decrypt every file under a folder and download them as a single zip. */
async function downloadFolderNode(node) {
  const key = await ensureVaultKey();
  showProgress(t('export_progress'));
  try {
    const list = await api('GET', '/api/files');
    const prefix = node.path + '/';
    const entries = (list || []).filter(
      (e) => e.path === node.path || e.path.startsWith(prefix),
    );
    // Keep the folder name as the archive root by stripping its parent path.
    const parent = dirname(node.path);
    const strip = parent ? parent + '/' : '';
    const files = {};
    const total = entries.length;
    let done = 0;
    updateProgress(0, total, t('progress_files', { done: 0, total }));
    for (const entry of entries) {
      const res = await fetch(attachmentUrl(entry.path), {
        credentials: 'same-origin',
      });
      if (res.ok) {
        const cipher = new Uint8Array(await res.arrayBuffer());
        try {
          const rel = entry.path.startsWith(strip)
            ? entry.path.slice(strip.length)
            : entry.path;
          files[rel] = await window.WOCrypto.decryptBytesMaybe(key, cipher);
        } catch (e) {
          /* skip files that fail to decrypt */
        }
      }
      done += 1;
      updateProgress(done, total, t('progress_files', { done, total }));
    }
    updateProgress(total, total, t('export_packaging'));
    const zipped = window.WOZip.zip(files);
    const blob = new Blob([zipped], { type: 'application/zip' });
    triggerDownload(blob, basename(node.path) + '.zip');
  } finally {
    hideProgress();
  }
}

/* ---------- trash ---------- */

function openTrashModal() {
  $('#trash-overlay').hidden = false;
  loadTrashList();
}
function closeTrashModal() {
  $('#trash-overlay').hidden = true;
}

function formatTrashDate(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

async function loadTrashList() {
  const listEl = $('#trash-list');
  listEl.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'trash-empty-msg';
  loading.textContent = t('loading');
  listEl.appendChild(loading);
  try {
    const items = await api('GET', '/api/trash');
    renderTrashList(items || []);
  } catch (err) {
    listEl.textContent = '';
    const msg = document.createElement('div');
    msg.className = 'trash-empty-msg';
    msg.textContent = err.message || t('trash_load_failed');
    listEl.appendChild(msg);
  }
}

function renderTrashList(items) {
  const listEl = $('#trash-list');
  const emptyBtn = $('#trash-empty-btn');
  listEl.textContent = '';
  if (!items.length) {
    const msg = document.createElement('div');
    msg.className = 'trash-empty-msg';
    msg.textContent = t('trash_empty_state');
    listEl.appendChild(msg);
    emptyBtn.disabled = true;
    return;
  }
  emptyBtn.disabled = false;
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'trash-row';

    const icon = document.createElement('i');
    icon.className =
      'bi ti ' + (it.type === 'dir' ? 'bi-folder-fill' : 'bi-file-earmark');
    row.appendChild(icon);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'tname';
    name.textContent = it.name;
    const path = document.createElement('div');
    path.className = 'tpath';
    path.textContent = it.path;
    meta.appendChild(name);
    meta.appendChild(path);
    row.appendChild(meta);

    const date = document.createElement('span');
    date.className = 'tdate';
    date.textContent = formatTrashDate(it.deletedAt);
    row.appendChild(date);

    const restore = document.createElement('button');
    restore.className = 'trestore';
    restore.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i>';
    restore.appendChild(document.createTextNode(' ' + t('trash_restore')));
    restore.addEventListener('click', () => restoreTrashItem(it, restore));
    row.appendChild(restore);

    listEl.appendChild(row);
  }
}

async function restoreTrashItem(it, btn) {
  btn.disabled = true;
  try {
    await api('POST', '/api/trash/restore', { id: it.id });
    flash(t('trash_restored', { name: it.name }));
    await loadTrashList();
    await loadTree();
  } catch (err) {
    btn.disabled = false;
    await uiAlert(t('trash_restore_failed_title'), {
      message: err.message || t('trash_restore_failed_msg'),
    });
  }
}

(function setupTrash() {
  $('#trash-btn').addEventListener('click', openTrashModal);
  $('#trash-modal-close').addEventListener('click', closeTrashModal);
  $('#trash-overlay').addEventListener('click', (e) => {
    if (e.target === $('#trash-overlay')) closeTrashModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#trash-overlay').hidden) closeTrashModal();
  });
  $('#trash-empty-btn').addEventListener('click', async () => {
    // Close the trash overlay first: it shares z-index with the confirm
    // dialog (.modal-overlay) and sits later in the DOM, so it would paint
    // on top of the confirm and hide it.
    closeTrashModal();
    const ok = await uiConfirm(t('trash_empty'), {
      message: t('trash_empty_confirm'),
      okText: t('trash_empty'),
      danger: true,
    });
    if (!ok) return;
    showProgress(t('trash_emptying'));
    try {
      await api('DELETE', '/api/trash', undefined, false, MUTATION_TIMEOUT_MS);
      hideProgress();
      flash(t('trash_emptied'));
      await loadTree();
    } catch (err) {
      hideProgress();
      await uiAlert(t('trash_empty_failed_title'), {
        message: err.message || t('trash_empty_failed_msg'),
      });
    }
  });
})();

/* ---------- search ---------- */

// Client-side content index. The server can only match file *names* now (it
// holds ciphertext), so full-text search runs in the browser over decrypted
// notes. To avoid re-downloading the whole vault on every reload, decrypted
// note text is cached in IndexedDB — sealed again under the vault key — and
// keyed by a server-supplied version token (mtime+size). Each sync fetches
// only the notes whose version changed and drops ones that were deleted.
const searchIndex = { built: false, building: null, docs: [] };

const SEARCH_DB_NAME = 'wo-search';
const SEARCH_DB_STORE = 'notes';

// Extensions worth indexing for full-text search (text-like notes/config).
const SEARCH_EXTS = new Set([
  'md', 'markdown', 'txt', 'json', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini',
  'html', 'htm', 'xml', 'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'py',
  'rb', 'php', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'sh', 'sql', 'log',
]);

/** Open (and lazily create) the IndexedDB holding the cached content index. */
function openSearchDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(SEARCH_DB_NAME, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SEARCH_DB_STORE)) {
        db.createObjectStore(SEARCH_DB_STORE, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Promisify a single IDBRequest. */
function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Apply a batch of puts/deletes to the cache store in one transaction. */
function persistCachedNotes(db, puts, deletes) {
  if (!puts.length && !deletes.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEARCH_DB_STORE, 'readwrite');
    const store = tx.objectStore(SEARCH_DB_STORE);
    for (const rec of puts) store.put(rec);
    for (const path of deletes) store.delete(path);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Wipe the cached content index (e.g. on logout). Best effort. */
async function clearSearchCache() {
  invalidateSearchIndex();
  try {
    const db = await openSearchDb();
    await new Promise((resolve) => {
      const tx = db.transaction(SEARCH_DB_STORE, 'readwrite');
      tx.objectStore(SEARCH_DB_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
    db.close();
  } catch (e) {
    /* nothing cached / IndexedDB unavailable */
  }
}

// Run `fn` over `items` with at most `limit` in flight at once. Results keep
// input order; rejected tasks surface their error (callers handle per-item).
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// How many note downloads/decryptions to run concurrently while (re)building the
// content index. The old serial loop meant one network round-trip per note —
// minutes on a large vault. A pool keeps the pipe full without hammering it.
const INDEX_CONCURRENCY = 12;

async function buildSearchIndex() {
  if (searchIndex.built) return;
  if (searchIndex.building) return searchIndex.building;
  searchIndex.building = (async () => {
    const key = await ensureVaultKey();
    const list = (await api('GET', '/api/files')) || [];

    // Only text-like notes are worth indexing; map each to its version token.
    const wanted = list.filter((e) => SEARCH_EXTS.has(extOf(e.path)));
    const wantedVersions = new Map(wanted.map((e) => [e.path, e.version]));

    // Load whatever we cached last time (may be empty / unavailable).
    let db = null;
    let cached = [];
    try {
      db = await openSearchDb();
      const tx = db.transaction(SEARCH_DB_STORE, 'readonly');
      cached = (await idbRequest(tx.objectStore(SEARCH_DB_STORE).getAll())) || [];
    } catch (e) {
      db = null; // Private mode etc.: fall back to memory-only (no persistence).
    }

    // Reuse cache entries whose version still matches the server; decrypt them
    // (in parallel) straight into the in-memory index — no network.
    const docs = [];
    const fresh = new Set();
    const reusable = cached.filter(
      (rec) => rec.version != null && rec.version === wantedVersions.get(rec.path),
    );
    const decoded = await mapPool(reusable, INDEX_CONCURRENCY, async (rec) => {
      try {
        const bytes = await window.WOCrypto.decryptBytes(key, rec.cipher);
        return { path: rec.path, name: basename(rec.path), text: new TextDecoder().decode(bytes) };
      } catch (e) {
        return null; // unreadable cache entry: refetch below
      }
    });
    for (const doc of decoded) {
      if (doc) {
        docs.push(doc);
        fresh.add(doc.path);
      }
    }

    // Download + decrypt only the notes that are new or changed since last sync,
    // running up to INDEX_CONCURRENCY transfers at once.
    const puts = [];
    const toFetch = wanted.filter((e) => !fresh.has(e.path));
    const fetched = await mapPool(toFetch, INDEX_CONCURRENCY, async (entry) => {
      try {
        const res = await fetch(attachmentUrl(entry.path), {
          credentials: 'same-origin',
        });
        if (!res.ok) return null;
        const cipher = new Uint8Array(await res.arrayBuffer());
        const bytes = await window.WOCrypto.decryptBytesMaybe(key, cipher);
        const text = new TextDecoder().decode(bytes);
        // Re-seal under the vault key so nothing readable sits in IndexedDB.
        const sealed = await window.WOCrypto.encryptBytes(key, bytes);
        return {
          doc: { path: entry.path, name: basename(entry.path), text },
          put: { path: entry.path, version: entry.version, cipher: sealed },
        };
      } catch (e) {
        return null; // skip unreadable files
      }
    });
    for (const r of fetched) {
      if (r) {
        docs.push(r.doc);
        puts.push(r.put);
      }
    }

    // Evict cache entries for files that vanished or are no longer indexable.
    const deletes = cached
      .map((r) => r.path)
      .filter((p) => !wantedVersions.has(p));

    if (db) {
      try {
        await persistCachedNotes(db, puts, deletes);
      } catch (e) {
        /* persistence is best effort; the in-memory index is still valid */
      }
      db.close();
    }

    searchIndex.docs = docs;
    searchIndex.built = true;
    searchIndex.building = null;
  })();
  return searchIndex.building;
}

/**
 * Invalidate the in-memory content index after the vault changes. The persisted
 * IndexedDB cache is kept: the next build re-syncs it incrementally (by version
 * token) instead of re-downloading every note.
 */
function invalidateSearchIndex() {
  searchIndex.built = false;
  searchIndex.building = null;
  searchIndex.docs = [];
}

/** Search decrypted notes for `q`, returning {path, name, snippet} matches. */
function searchContent(q) {
  const needle = q.toLowerCase();
  const hits = [];
  for (const doc of searchIndex.docs) {
    const idx = doc.text.toLowerCase().indexOf(needle);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 30);
    const end = Math.min(doc.text.length, idx + needle.length + 30);
    let snippet = doc.text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = '…' + snippet;
    if (end < doc.text.length) snippet = snippet + '…';
    hits.push({ path: doc.path, name: doc.name, snippet });
  }
  return hits;
}

// Search runs only on an explicit trigger (Enter or the search button), never
// while typing — this keeps a single query under the /api rate limit and avoids
// a slow server walk per keystroke. `searching` guards against double-submits.
let searching = false;

// Overlay state. `epoch` is bumped to abort an in-flight search: each async step
// checks it before rendering, so clicking a result (or closing) stops the search
// rather than letting a slow content-index build overwrite the view.
const searchState = {
  excluded: new Set(), // top-level folder paths excluded from results
  lastHits: [], // unfiltered hits from the last run, for re-filtering
  lastIndexing: false,
  epoch: 0,
};

/** Drop hits that live inside an excluded top-level folder. */
function filterExcluded(hits) {
  if (!searchState.excluded.size) return hits;
  return hits.filter((h) => {
    for (const dir of searchState.excluded) {
      if (h.path === dir || h.path.startsWith(dir + '/')) return false;
    }
    return true;
  });
}

/** Build the exclude-folder filter chips from the current tree's top folders. */
function buildSearchFilters() {
  const wrap = $('#search-filters-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  const dirs = (state.tree || []).filter((n) => n.type === 'dir');
  if (!dirs.length) {
    wrap.innerHTML =
      '<span class="search-filters-none">' + t('search_no_folders') + '</span>';
    return;
  }
  // Drop stale exclusions for folders that no longer exist.
  const present = new Set(dirs.map((d) => d.path));
  for (const p of [...searchState.excluded]) {
    if (!present.has(p)) searchState.excluded.delete(p);
  }
  for (const dir of dirs) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'search-chip';
    const icon = document.createElement('i');
    const label = document.createElement('span');
    label.textContent = dir.name;
    chip.appendChild(icon);
    chip.appendChild(label);
    const sync = () => {
      const on = searchState.excluded.has(dir.path);
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      icon.className = on ? 'bi bi-check-lg' : 'bi bi-folder';
      chip.title = on
        ? t('search_excluded_title', { name: dir.name })
        : t('search_exclude_title', { name: dir.name });
    };
    sync();
    chip.addEventListener('click', () => {
      if (searchState.excluded.has(dir.path)) searchState.excluded.delete(dir.path);
      else searchState.excluded.add(dir.path);
      sync();
      // Re-render the existing results with the new filter, no re-query.
      renderResults($('#search-results'), searchState.lastHits, searchState.lastIndexing);
    });
    wrap.appendChild(chip);
  }
}

function openSearchOverlay() {
  buildSearchFilters();
  const overlay = $('#search-overlay');
  overlay.hidden = false;
  const input = $('#search-input');
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function closeSearchOverlay() {
  // Abort any in-flight search so a late content-index build can't repaint.
  searchState.epoch++;
  searching = false;
  const btn = $('#search-btn');
  if (btn) btn.disabled = false;
  $('#search-overlay').hidden = true;
}

async function runSearch(q) {
  const box = $('#search-results');
  if (!q.trim()) {
    box.innerHTML = '';
    searchState.lastHits = [];
    return;
  }
  if (searching) return;
  searching = true;
  const epoch = ++searchState.epoch;
  const btn = $('#search-btn');
  if (btn) btn.disabled = true;
  // Show a spinner immediately: the server name search plus building/syncing the
  // local content index can take a moment on a large vault.
  box.innerHTML =
    '<div class="search-loading"><span class="search-spinner"></span>' +
    t('searching') +
    '</div>';
  try {
    await runSearchInner(q, box, epoch);
  } finally {
    if (epoch === searchState.epoch) {
      searching = false;
      if (btn) btn.disabled = false;
    }
  }
}

/** Merge local content matches for `q` into a list of (name) hits, in place. */
function mergeContentHits(hits, q) {
  const byPath = new Set(hits.map((h) => h.path));
  for (const ch of searchContent(q)) {
    if (byPath.has(ch.path)) {
      const existing = hits.find((h) => h.path === ch.path);
      if (existing && !existing.snippet) existing.snippet = ch.snippet;
    } else {
      hits.push(ch);
      byPath.add(ch.path);
    }
  }
}

/** Render the results list. `indexing` appends a "searching contents" note. */
function renderResults(box, hits, indexing) {
  searchState.lastHits = hits;
  searchState.lastIndexing = indexing;
  const shown = filterExcluded(hits);
  box.innerHTML = '';
  if (!shown.length && !indexing) {
    box.innerHTML = '<div class="search-empty">' + t('no_matches') + '</div>';
    return;
  }
  for (const hit of shown) {
    const item = document.createElement('button');
    item.className = 'search-hit';
    const title = document.createElement('div');
    title.className = 'search-hit-name';
    title.textContent = hit.name;
    item.appendChild(title);
    if (hit.snippet) {
      const sn = document.createElement('div');
      sn.className = 'search-hit-snippet';
      sn.textContent = hit.snippet;
      item.appendChild(sn);
    }
    item.addEventListener('click', () => {
      // Clicking a result stops any still-running search for reliability.
      closeSearchOverlay();
      $('#search-input').value = '';
      openFile(hit.path);
    });
    box.appendChild(item);
  }
  if (indexing) {
    const note = document.createElement('div');
    note.className = 'search-loading';
    note.innerHTML = '<span class="search-spinner"></span>' + t('searching_contents');
    box.appendChild(note);
  }
}

async function runSearchInner(q, box, epoch) {
  // Name matches come from the server (fast) and are shown immediately. Content
  // matches need the local decrypted index; if it isn't warm yet we render name
  // hits first, build the index in the background, then fold content hits in.
  let hits = [];
  try {
    const nameHits = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    hits = Array.isArray(nameHits) ? nameHits.slice() : [];
  } catch (e) {
    hits = [];
  }
  if (epoch !== searchState.epoch) return; // aborted

  if (searchIndex.built) {
    mergeContentHits(hits, q);
    renderResults(box, hits, false);
    return;
  }

  // Index cold: paint name hits now (with an "indexing" note) so the user isn't
  // staring at a spinner while the vault content index warms up.
  renderResults(box, hits, true);
  try {
    await buildSearchIndex();
    if (epoch !== searchState.epoch) return; // aborted while indexing
    mergeContentHits(hits, q);
  } catch (e) {
    /* content search unavailable; keep name hits only */
  }
  if (epoch !== searchState.epoch) return; // aborted
  renderResults(box, hits, false);
}

$('#search-open-btn').addEventListener('click', openSearchOverlay);
$('#search-close').addEventListener('click', closeSearchOverlay);
$('#search-overlay').addEventListener('click', (e) => {
  if (e.target === $('#search-overlay')) closeSearchOverlay();
});
$('#search-btn').addEventListener('click', () =>
  runSearch($('#search-input').value),
);
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runSearch(e.target.value);
  }
});
// Clearing the field (native "x" or empty) clears results without searching.
$('#search-input').addEventListener('input', (e) => {
  if (!e.target.value.trim()) {
    $('#search-results').innerHTML = '';
    searchState.lastHits = [];
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#search-overlay').hidden) closeSearchOverlay();
});

/* ---------- chrome: theme, sidebar, logout ---------- */

/* Theme is chosen in Account settings (the old topbar toggle moved there). */
function applyTheme(next) {
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('wo-theme', next);
  } catch (e) {
    /* ignore */
  }
  persistPref('theme', next);
  syncThemeButtons();
}
function syncThemeButtons() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  document.querySelectorAll('[data-theme-set]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-theme-set') === cur);
  });
}
document.querySelectorAll('[data-theme-set]').forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.getAttribute('data-theme-set')));
});
syncThemeButtons();

/* Font size and contrast are chosen in Account settings too. */
function applyFontSize(px) {
  document.documentElement.style.setProperty('--app-font-size', px + 'px');
  try {
    localStorage.setItem('wo-font-size', String(px));
  } catch (e) {
    /* ignore */
  }
  persistPref('fontSize', px);
  syncFontButtons();
}
function syncFontButtons() {
  const cur = parseInt(
    getComputedStyle(document.documentElement).getPropertyValue('--app-font-size'),
    10,
  ) || 15;
  document.querySelectorAll('[data-font-set]').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.getAttribute('data-font-set'), 10) === cur);
  });
}
document.querySelectorAll('[data-font-set]').forEach((btn) => {
  btn.addEventListener('click', () =>
    applyFontSize(parseInt(btn.getAttribute('data-font-set'), 10)),
  );
});
syncFontButtons();

function applyContrast(mode) {
  if (mode === 'high') {
    document.documentElement.setAttribute('data-contrast', 'high');
  } else {
    document.documentElement.removeAttribute('data-contrast');
  }
  try {
    localStorage.setItem('wo-contrast', mode);
  } catch (e) {
    /* ignore */
  }
  persistPref('contrast', mode);
  syncContrastButtons();
}
function syncContrastButtons() {
  const cur = document.documentElement.getAttribute('data-contrast') === 'high' ? 'high' : 'normal';
  document.querySelectorAll('[data-contrast-set]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-contrast-set') === cur);
  });
}
document.querySelectorAll('[data-contrast-set]').forEach((btn) => {
  btn.addEventListener('click', () => applyContrast(btn.getAttribute('data-contrast-set')));
});
syncContrastButtons();

function toggleSidebar(force) {
  const sidebar = $('#sidebar');
  const backdrop = $('#sidebar-backdrop');
  const open = force !== undefined ? force : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  backdrop.hidden = !open;
}
$('#sidebar-toggle').addEventListener('click', () => toggleSidebar());
$('#sidebar-backdrop').addEventListener('click', () => toggleSidebar(false));

/* ---------- resizable sidebar ---------- */
(function setupSidebarResize() {
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 600;
  const resizer = $('#sidebar-resizer');
  if (!resizer) return;

  const clamp = (w) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
  const applyWidth = (w) => {
    document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
  };

  // Restore the persisted width.
  try {
    const saved = parseInt(localStorage.getItem('wo-sidebar-width'), 10);
    if (Number.isFinite(saved)) applyWidth(clamp(saved));
  } catch (e) {
    /* ignore */
  }

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const w = clamp(e.clientX);
    applyWidth(w);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('sidebar-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const cur = parseInt(
      getComputedStyle($('#sidebar')).width,
      10,
    );
    if (Number.isFinite(cur)) {
      try {
        localStorage.setItem('wo-sidebar-width', String(cur));
      } catch (e) {
        /* ignore */
      }
    }
  };
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('sidebar-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  // Double-click resets to the default width.
  resizer.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--sidebar-width');
    try {
      localStorage.removeItem('wo-sidebar-width');
    } catch (e) {
      /* ignore */
    }
  });
})();

/* ---------- resizable / collapsible actions (button) area ---------- */
(function setupToolsArea() {
  const sidebar = $('#sidebar');
  const tools = $('#sidebar-tools');
  const resizer = $('#tools-resizer');
  const toggle = $('#tools-toggle');
  if (!sidebar || !tools) return;

  const TOOLS_MIN = 44;
  const TOOLS_MAX = 600;
  const clamp = (h) => Math.min(TOOLS_MAX, Math.max(TOOLS_MIN, h));
  const applyHeight = (h) => {
    // Set both so a user-chosen height can also exceed the default max-height cap.
    tools.style.height = `${h}px`;
    tools.style.maxHeight = `${h}px`;
  };
  const clearHeight = () => {
    tools.style.removeProperty('height');
    tools.style.removeProperty('max-height');
  };

  // Restore persisted height + collapsed state.
  try {
    const saved = parseInt(localStorage.getItem('wo-tools-height'), 10);
    if (Number.isFinite(saved)) applyHeight(clamp(saved));
    if (localStorage.getItem('wo-tools-collapsed') === '1') {
      sidebar.classList.add('tools-collapsed');
      if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        const label = t('tools_toggle_show');
        toggle.setAttribute('title', label);
        toggle.setAttribute('aria-label', label);
      }
    }
  } catch (e) {
    /* ignore */
  }

  // Collapse / expand the whole actions area to free room for the file tree.
  const setCollapsed = (collapsed) => {
    sidebar.classList.toggle('tools-collapsed', collapsed);
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!collapsed));
      const label = t(collapsed ? 'tools_toggle_show' : 'tools_toggle_hide');
      toggle.setAttribute('title', label);
      toggle.setAttribute('aria-label', label);
    }
    try {
      localStorage.setItem('wo-tools-collapsed', collapsed ? '1' : '0');
    } catch (e) {
      /* ignore */
    }
  };
  if (toggle) {
    toggle.addEventListener('click', () =>
      setCollapsed(!sidebar.classList.contains('tools-collapsed')),
    );
  }

  if (!resizer) return;
  let dragging = false;
  let startY = 0;
  let startH = 0;
  const onMove = (e) => {
    if (!dragging) return;
    applyHeight(clamp(startH + (e.clientY - startY)));
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('tools-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const cur = parseInt(getComputedStyle(tools).height, 10);
    if (Number.isFinite(cur)) {
      try {
        localStorage.setItem('wo-tools-height', String(cur));
      } catch (e) {
        /* ignore */
      }
    }
  };
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = tools.offsetHeight;
    resizer.classList.add('dragging');
    document.body.classList.add('tools-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  // Double-click resets to the natural (content) height.
  resizer.addEventListener('dblclick', () => {
    clearHeight();
    try {
      localStorage.removeItem('wo-tools-height');
    } catch (e) {
      /* ignore */
    }
  });
})();
document.querySelectorAll('[data-mobile-back]').forEach((btn) => {
  btn.addEventListener('click', () => toggleSidebar(true));
});

/* ---------- language switcher ---------- */
(function setupLanguage() {
  // The switcher itself is auto-wired by i18n.js; here we only re-render the
  // dynamic labels (view/edit toggle) when the language changes.
  document.addEventListener('wo-langchange', () => {
    if (state.current && state.current.ext !== 'excalidraw' && !$('#editor-view').hidden) {
      setViewMode(!!state.viewing);
    }
    if (typeof renderTabbar === 'function') renderTabbar();
    // Follow the language choice to other devices too.
    if (window.I18N && window.I18N.lang) persistPref('lang', window.I18N.lang);
  });
})();

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  // Forget the vault key so it can't be reused by a later session in this tab.
  window.WOCrypto.clearVaultKey();
  // Drop the cached content index so the next user can't read it.
  await clearSearchCache();
  window.location.href = '/login';
});

/* ---------- account dashboard ---------- */

function formatBytes(bytes) {
  if (!bytes || bytes < 0) bytes = 0;
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[i];
}

function openDashboard() {
  $('#dashboard-overlay').hidden = false;
  // Always open on the first (General) section, like a fresh settings window.
  // reveal=false so mobile shows the nav list first.
  showSettingsPane('general', false);
  const search = $('#settings-search');
  if (search) search.value = '';
  applySettingsSearch('');
  syncThemeButtons();
  loadAccount();
  loadDailyPathSetting();
  loadAutosaveSetting();
  if (CHAT_ENABLED) loadChatBlocks();
}

/** Reflect the current autosave preference in the settings toggle. */
async function loadAutosaveSetting() {
  const toggle = document.getElementById('autosave-toggle');
  if (!toggle) return;
  try {
    await loadVaultSettings();
  } catch {
    /* fall back to the default below */
  }
  toggle.checked = autosaveEnabled();
}

(function setupAutosaveSetting() {
  const toggle = document.getElementById('autosave-toggle');
  if (!toggle) return;
  toggle.addEventListener('change', () => {
    persistPref('autosave', toggle.checked);
    // Turning it on mid-edit should catch up the current dirty file; turning it
    // off should cancel any pending write immediately.
    if (toggle.checked) scheduleAutosave();
    else clearAutosaveTimers();
    renderSaveStatus();
    flash(t('autosave_saved'));
  });
})();

/** Populate the daily-note folder field from the (encrypted) settings. */
async function loadDailyPathSetting() {
  const input = $('#daily-path-input');
  if (!input) return;
  try {
    await loadVaultSettings();
    input.value = getDailyNotePath();
  } catch {
    input.value = DEFAULT_DAILY_DIR;
  }
}

(function setupDailyPathSetting() {
  const input = $('#daily-path-input');
  const save = $('#daily-path-save');
  const note = $('#daily-path-note');
  if (!input || !save) return;
  save.addEventListener('click', async () => {
    const clean = WOUtil.normalizeVaultPath(input.value) || DEFAULT_DAILY_DIR;
    input.value = clean;
    save.disabled = true;
    try {
      const cfg = await loadVaultSettings();
      cfg.dailyNotePath = clean;
      await flushVaultSettings(); // explicit Save → write immediately
      if (note) {
        note.hidden = false;
        note.textContent = t('daily_path_saved');
      }
      flash(t('daily_path_saved'));
    } catch (e) {
      flash(e.message || t('could_not_create'));
    } finally {
      save.disabled = false;
    }
  });
})();

function closeDashboard() {
  $('#dashboard-overlay').hidden = true;
}

/* ---------- settings navigation, search, mobile slide ---------- */

function showSettingsPane(name, reveal = true) {
  const modal = document.querySelector('.settings-modal');
  document.querySelectorAll('.settings-nav-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-pane') === name);
  });
  document.querySelectorAll('.settings-pane').forEach((pane) => {
    const match = pane.getAttribute('data-pane') === name;
    pane.classList.toggle('active', match);
    pane.hidden = !match;
  });
  // On mobile, only slide into the pane on an explicit pick; opening the
  // dashboard lands on the nav list (iOS/Firefox-settings behaviour). Desktop
  // shows nav + pane side by side regardless.
  if (modal) modal.classList.toggle('pane-open', reveal);
  const body = $('#settings-body');
  if (body) body.scrollTop = 0;
}

function backToSettingsNav() {
  const modal = document.querySelector('.settings-modal');
  if (modal) modal.classList.remove('pane-open');
}

/** Filter setting groups across every pane by free-text query. */
function applySettingsSearch(raw) {
  const body = $('#settings-body');
  if (!body) return;
  const q = (raw || '').trim().toLowerCase();
  const noRes = $('#settings-no-results');
  if (!q) {
    body.classList.remove('is-searching');
    body.querySelectorAll('.settings-group.is-hidden').forEach((g) =>
      g.classList.remove('is-hidden'),
    );
    body.querySelectorAll('.settings-pane[data-empty]').forEach((p) =>
      p.removeAttribute('data-empty'),
    );
    if (noRes) noRes.hidden = true;
    return;
  }
  body.classList.add('is-searching');
  let anyHit = false;
  body.querySelectorAll('.settings-pane').forEach((pane) => {
    let paneHit = false;
    pane.querySelectorAll('.settings-group').forEach((group) => {
      const hit = group.textContent.toLowerCase().includes(q);
      group.classList.toggle('is-hidden', !hit);
      if (hit) paneHit = true;
    });
    // Match the pane/category title too so e.g. "account" surfaces the section.
    const titleEl = pane.querySelector('.settings-pane-title');
    const titleHit = titleEl && titleEl.textContent.toLowerCase().includes(q);
    if (titleHit) {
      pane.querySelectorAll('.settings-group.is-hidden').forEach((g) =>
        g.classList.remove('is-hidden'),
      );
      paneHit = true;
    }
    if (paneHit) {
      pane.removeAttribute('data-empty');
      anyHit = true;
    } else {
      pane.setAttribute('data-empty', '1');
    }
  });
  if (noRes) noRes.hidden = anyHit;
}

async function loadAccount() {
  const fill = $('#usage-fill');
  const text = $('#usage-text');
  fill.style.width = '0%';
  fill.classList.remove('warn', 'full');
  text.textContent = t('loading');
  try {
    const info = await api('GET', '/api/account');
    $('#dashboard-username').textContent = info.username;
    if (info.unlimited || !info.quotaBytes) {
      fill.style.width = '0%';
      text.textContent = t('usage_unlimited', { used: formatBytes(info.usedBytes) });
    } else {
      const pct = Math.min(100, (info.usedBytes / info.quotaBytes) * 100);
      fill.style.width = pct.toFixed(1) + '%';
      if (pct >= 100) fill.classList.add('full');
      else if (pct >= 80) fill.classList.add('warn');
      text.textContent = t('usage_of', {
        used: formatBytes(info.usedBytes),
        total: formatBytes(info.quotaBytes),
        pct: pct.toFixed(pct >= 10 ? 0 : 1),
      });
    }
    await renderPlan(info);
    await loadStorageSection();
  } catch (e) {
    text.textContent = t('usage_error');
  }
}

/** Whether this deployment runs in bring-your-own-storage mode. */
const USER_STORAGE = document.body.getAttribute('data-user-storage') === '1';

/** Load and prefill the dashboard storage-provider section (user-storage mode). */
async function loadStorageSection() {
  if (!USER_STORAGE) return;
  const cur = $('#dash-storage-current');
  const badge = $('#dash-storage-status');
  try {
    const cfg = await api('GET', '/api/account/storage');
    const form = window.StorageForm && window.StorageForm.get('dash');
    if (form) form.prefill(cfg);
    if (cur) {
      cur.textContent = cfg.configured
        ? t('storage_connected_to', {
            provider:
              cfg.driver === 'managed'
                ? t('storage_type_managed')
                : cfg.driver === 's3'
                  ? t('storage_type_s3')
                  : t('storage_type_webdav'),
          })
        : t('storage_not_connected');
    }
    if (badge) {
      badge.classList.remove('is-unknown', 'is-connected', 'is-disconnected');
      badge.classList.add(cfg.configured ? 'is-connected' : 'is-disconnected');
    }
    renderMaxTabsSetting(cfg);
  } catch (e) {
    renderMaxTabsSetting(null);
    if (cur) cur.textContent = t('storage_not_connected');
    if (badge) {
      badge.classList.remove('is-unknown', 'is-connected');
      badge.classList.add('is-disconnected');
    }
  }
}

/** Show the "Open tabs" limit control only for a connected bring-your-own
 *  storage provider (S3/WebDAV) — managed users keep the operator default —
 *  and prefill it with the current effective limit + default hint. */
function renderMaxTabsSetting(cfg) {
  const group = document.getElementById('max-tabs-group');
  if (!group) return;
  const byo =
    !!cfg &&
    cfg.configured &&
    (cfg.driver === 's3' || cfg.driver === 'webdav');
  group.hidden = !byo;
  if (!byo) return;
  const input = document.getElementById('max-tabs-input');
  if (input) input.value = String(maxOpenTabs());
  const def = document.getElementById('max-tabs-default');
  if (def) {
    def.textContent = t('tabs_setting_default', {
      n: DEFAULT_MAX_OPEN_TABS,
      max: TAB_LIMIT_HARD_MAX,
    });
  }
}

/** Open Settings on the File storage pane, focused on the tab-limit control.
 *  Wired to the tab counter on own-storage deployments. */
function openTabLimitSetting() {
  openDashboard();
  showSettingsPane('storage', true);
  setTimeout(() => {
    const inp = document.getElementById('max-tabs-input');
    if (inp && !inp.closest('[hidden]')) inp.focus();
  }, 0);
}

/** Persist the user's open-tab limit (clamped to [1, 25]) and re-render. */
function saveMaxTabsSetting() {
  const input = document.getElementById('max-tabs-input');
  if (!input) return;
  const n = WOUtil.clampTabLimit(
    input.value,
    TAB_LIMIT_HARD_MAX,
    DEFAULT_MAX_OPEN_TABS,
  );
  input.value = String(n);
  persistPref('maxOpenTabs', n);
  renderTabbar();
  flash(t('tabs_setting_saved'));
}

/** Re-test and save the storage credentials entered in the dashboard. */
async function saveStorageSection() {
  const form = window.StorageForm && window.StorageForm.get('dash');
  const btn = $('#dash-storage-save');
  const err = $('#dash-storage-error');
  if (!form) return;
  if (err) err.hidden = true;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/account/storage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(form.collect()),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      form.showStatus('ok', t('storage_saved'));
      await loadAccount();
    } else if (data && data.code) {
      form.showStatus('fail', form.errMessage(data.code));
    } else if (err) {
      err.textContent = Array.isArray(data.message)
        ? data.message.join(' ')
        : data.message || t('storage_save_failed');
      err.hidden = false;
    }
  } catch (e) {
    if (err) {
      err.textContent = t('storage_save_failed');
      err.hidden = false;
    }
  }
  if (btn) btn.disabled = false;
}

function planLabel(tier) {
  if (tier === 'plus') {
    const gb = _billingConfig && _billingConfig.planGb ? _billingConfig.planGb : 3;
    return t('plan_plus_name', { gb });
  }
  return t('plan_free');
}

let _billingConfig = null;
async function billingConfig() {
  if (_billingConfig === null) {
    try {
      const cfg = await api('GET', '/api/billing/config');
      _billingConfig = {
        enabled: Boolean(cfg && cfg.enabled),
        ready: Boolean(cfg && cfg.ready),
        planGb: cfg && cfg.planGb ? cfg.planGb : 3,
        planPrice: (cfg && cfg.planPrice) || '',
        donationLink: (cfg && cfg.donationLink) || '',
        contactEmail: (cfg && cfg.contactEmail) || '',
      };
    } catch {
      _billingConfig = {
        enabled: false,
        ready: false,
        planGb: 3,
        planPrice: '',
        donationLink: '',
        contactEmail: '',
      };
    }
  }
  return _billingConfig;
}

async function billingEnabled() {
  return (await billingConfig()).enabled;
}

/** Show/hide the Plan entry in the settings nav. */
function setPlanNav(visible) {
  const navItem = document.querySelector('.settings-nav-item[data-pane="plan"]');
  if (navItem) navItem.hidden = !visible;
  // If the plan pane is hidden but currently selected, fall back to General.
  if (!visible && navItem && navItem.classList.contains('active')) {
    showSettingsPane('general');
    backToSettingsNav();
  }
}

async function renderPlan(info) {
  // Own bring-your-own storage (s3/webdav) hosts no plans/billing. Managed users
  // store on the app's backend and ARE billed, so they keep the Plan section.
  if (info && info.userStorageEnabled && !info.managed) {
    setPlanNav(false);
    return;
  }
  const warning = $('#plan-warning');
  const planValue = $('#plan-value');
  const validRow = $('#plan-valid-row');
  const validVal = $('#plan-valid');
  const privilegedHint = $('#plan-privileged-hint');
  const upgrade = $('#plan-upgrade');
  const manageBtn = $('#manage-billing-btn');
  const unavailable = $('#billing-unavailable');
  const donationLink = $('#plan-donation-link');
  const commercial = $('#plan-commercial');
  const commercialEmail = $('#plan-commercial-email');

  // When billing is switched off (self-hosting) there are no plans to manage:
  // hide the whole nav entry and just show storage usage elsewhere.
  const cfg = await billingConfig();
  setPlanNav(cfg.enabled);
  if (!cfg.enabled) {
    return;
  }

  // Reset.
  warning.hidden = true;
  warning.classList.remove('danger');
  validRow.hidden = true;
  privilegedHint.hidden = true;
  upgrade.hidden = true;
  manageBtn.hidden = true;
  unavailable.hidden = true;
  if (donationLink) donationLink.hidden = true;
  if (commercial) commercial.hidden = true;

  // Voluntary donation link (DONATION_LINK), and the commercial-use note that
  // points at CONTACT_EMAIL — commercial use requires a paid plan.
  if (donationLink && cfg.donationLink) {
    donationLink.href = cfg.donationLink;
    donationLink.hidden = false;
  }
  const commercialMail =
    cfg.contactEmail || document.body.getAttribute('data-contact') || '';
  if (commercial && commercialEmail && commercialMail) {
    commercialEmail.textContent = commercialMail;
    commercialEmail.href = 'mailto:' + commercialMail;
    const copyBtn = $('#plan-commercial-copy');
    if (copyBtn) copyBtn.setAttribute('data-copy-email', commercialMail);
    commercial.hidden = false;
  }

  planValue.textContent = planLabel(info.effectiveTier || 'free');

  // Privileged accounts: complimentary storage, no billing whatsoever. Hide the
  // entire plan/billing entry (no plan, no upgrade, no manage-subscription).
  if (info.privileged) {
    setPlanNav(false);
    return;
  }

  // Warnings (most severe first).
  if (info.blacklisted) {
    warning.textContent = t('plan_blacklisted');
    warning.classList.add('danger');
    warning.hidden = false;
  } else if (info.warnExpiringSoon) {
    warning.textContent = t('plan_warn_expiring', {
      days: info.daysUntilExpiry != null ? info.daysUntilExpiry : 0,
    });
    warning.hidden = false;
  }

  // Paid-through date.
  if (info.paidActive && info.currentPeriodEnd) {
    validRow.hidden = false;
    try {
      validVal.textContent = new Date(info.currentPeriodEnd).toLocaleDateString();
    } catch {
      validVal.textContent = String(info.currentPeriodEnd);
    }
  }

  // Offer the single paid plan only while the user is on the free tier.
  const tier = info.effectiveTier || 'free';
  const donationNote = $('#plan-donation-note');
  upgrade.hidden = tier !== 'free';
  if (donationNote) donationNote.hidden = upgrade.hidden;

  // Label the upgrade button with the configured size + suggested donation.
  const upgradeLabel = $('#plan-upgrade-label');
  if (upgradeLabel) {
    upgradeLabel.textContent = cfg.planPrice
      ? t('upgrade_plus_priced', { gb: cfg.planGb, price: cfg.planPrice })
      : t('upgrade_plus_gb', { gb: cfg.planGb });
  }

  // Feature is on but Stripe isn't configured yet: show the button disabled
  // and a hint so the operator knows checkout will not work until keys are set.
  if (!cfg.ready) {
    unavailable.hidden = false;
    upgrade.querySelectorAll('button').forEach((b) => (b.disabled = true));
  } else {
    upgrade.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }

  // Allow managing/cancelling an existing subscription.
  if (cfg.ready && info.subscriptionStatus && info.subscriptionStatus !== 'none') {
    manageBtn.hidden = false;
  }
}

async function startCheckout(plan) {
  try {
    const { url } = await api('POST', '/api/billing/checkout', { plan });
    if (url) window.location.href = url;
  } catch (e) {
    flash((e && e.message) || t('billing_error'));
  }
}

async function openBillingPortal() {
  try {
    const { url } = await api('POST', '/api/billing/portal');
    if (url) window.location.href = url;
  } catch (e) {
    flash((e && e.message) || t('billing_error'));
  }
}


async function deleteAccount() {
  const password = await uiPrompt(t('delete_account'), '', {
    title: t('delete_account'),
    message: t('del_acc_msg'),
    placeholder: t('del_acc_ph'),
    inputType: 'password',
    okText: t('del_acc_ok'),
    danger: true,
  });
  if (!password) return;

  // Use a direct fetch so a wrong-password 401 does not trigger the global
  // redirect that api() performs.
  let res;
  try {
    res = await fetch('/api/account', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    flash(t('network_error'));
    return;
  }
  if (res.ok) {
    window.location.href = '/login';
    return;
  }
  if (res.status === 401) {
    flash(t('wrong_password'));
    return;
  }
  let msg = t('could_not_delete');
  try {
    const data = await res.json();
    if (data && data.message) {
      msg = Array.isArray(data.message) ? data.message.join(' ') : data.message;
    }
  } catch {
    /* ignore */
  }
  flash(msg);
}

/* ---------- change password ---------- */

function openChangePassword() {
  const overlay = $('#change-password-overlay');
  $('#cp-current').value = '';
  $('#cp-new').value = '';
  $('#cp-confirm').value = '';
  $('#cp-code').value = '';
  const err = $('#cp-error');
  err.hidden = true;
  err.textContent = '';
  overlay.hidden = false;
  $('#cp-current').focus();
}

function closeChangePassword() {
  $('#change-password-overlay').hidden = true;
}

function showChangePasswordError(msg) {
  const err = $('#cp-error');
  err.textContent = msg;
  err.hidden = false;
}

async function submitChangePassword(e) {
  if (e) e.preventDefault();
  const currentPassword = $('#cp-current').value;
  const newPassword = $('#cp-new').value;
  const confirm = $('#cp-confirm').value;
  const code = $('#cp-code').value.trim();

  if (!currentPassword || !newPassword || !code) {
    showChangePasswordError(t('cp_fill_all'));
    return;
  }
  if (newPassword.length < 8) {
    showChangePasswordError(t('cp_too_short'));
    return;
  }
  if (newPassword !== confirm) {
    showChangePasswordError(t('cp_mismatch'));
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    showChangePasswordError(t('cp_bad_code'));
    return;
  }

  const btn = $('#cp-submit');
  btn.disabled = true;

  // Re-wrap the vault key for the new password entirely in the browser. The
  // server stores the new wrapped key + salt but never sees the vault key. We
  // fetch the current wrapped key + salt, unwrap with the old password, and
  // re-wrap with the new one. The vault itself is NOT re-encrypted.
  let rewrap;
  try {
    const keys = await api('GET', '/api/account/keys');
    if (!keys || !keys.wrappedVaultKey || !keys.kdfSalt) {
      throw new Error('missing key material');
    }
    const { newKdfSalt, newWrappedVaultKey } =
      await window.WOCrypto.rewrapForNewPassword(
        currentPassword,
        keys.kdfSalt,
        keys.wrappedVaultKey,
        newPassword,
      );
    rewrap = { newKdfSalt, newWrappedVaultKey };
  } catch (e) {
    btn.disabled = false;
    showChangePasswordError(t('cp_wrong_current') || t('cp_failed'));
    return;
  }

  // Direct fetch so a 400/401 does not trigger the global auth redirect.
  let res;
  try {
    res = await fetch('/api/account/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword,
        newPassword,
        code,
        newKdfSalt: rewrap.newKdfSalt,
        newWrappedVaultKey: rewrap.newWrappedVaultKey,
      }),
    });
  } catch {
    btn.disabled = false;
    showChangePasswordError(t('network_error'));
    return;
  }
  btn.disabled = false;

  if (res.ok) {
    closeChangePassword();
    flash(t('cp_success'));
    return;
  }

  let msg = t('cp_failed');
  try {
    const data = await res.json();
    if (data && data.message) {
      msg = Array.isArray(data.message) ? data.message.join(' ') : data.message;
    }
  } catch {
    /* ignore */
  }
  showChangePasswordError(msg);
}

/* ---------- reset authenticator (2FA / TOTP) ---------- */

function openResetTotp() {
  const overlay = $('#reset-totp-overlay');
  $('#rt-current').value = '';
  $('#rt-current-code').value = '';
  $('#rt-new-code').value = '';
  $('#rt-secret').textContent = '';
  $('#rt-qr').src = '';
  $('#rt-verify-error').hidden = true;
  $('#rt-confirm-error').hidden = true;
  $('#reset-totp-verify-form').hidden = false;
  $('#reset-totp-confirm-form').hidden = true;
  overlay.hidden = false;
  $('#rt-current').focus();
}

function closeResetTotp() {
  $('#reset-totp-overlay').hidden = true;
}

function showResetTotpError(sel, msg) {
  const err = $(sel);
  err.textContent = msg;
  err.hidden = false;
}

async function submitResetTotpVerify(e) {
  if (e) e.preventDefault();
  const currentPassword = $('#rt-current').value;
  const code = $('#rt-current-code').value.trim();
  $('#rt-verify-error').hidden = true;

  if (!currentPassword || !code) {
    showResetTotpError('#rt-verify-error', t('cp_fill_all'));
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    showResetTotpError('#rt-verify-error', t('cp_bad_code'));
    return;
  }

  const btn = $('#rt-verify-submit');
  btn.disabled = true;
  // Direct fetch so a 400/401 does not trigger the global auth redirect.
  let res;
  try {
    res = await fetch('/api/account/totp/init', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, code }),
    });
  } catch {
    btn.disabled = false;
    showResetTotpError('#rt-verify-error', t('network_error'));
    return;
  }
  btn.disabled = false;

  if (res.ok) {
    let data;
    try {
      data = await res.json();
    } catch {
      showResetTotpError('#rt-verify-error', t('rt_failed'));
      return;
    }
    $('#rt-qr').src = data.qrDataUrl;
    $('#rt-secret').textContent = data.secret;
    $('#reset-totp-verify-form').hidden = true;
    $('#reset-totp-confirm-form').hidden = false;
    $('#rt-new-code').focus();
    return;
  }

  let msg = t('rt_failed');
  try {
    const data = await res.json();
    if (data && data.message) {
      msg = Array.isArray(data.message) ? data.message.join(' ') : data.message;
    }
  } catch {
    /* ignore */
  }
  showResetTotpError('#rt-verify-error', msg);
}

async function submitResetTotpConfirm(e) {
  if (e) e.preventDefault();
  const code = $('#rt-new-code').value.trim();
  $('#rt-confirm-error').hidden = true;

  if (!/^\d{6}$/.test(code)) {
    showResetTotpError('#rt-confirm-error', t('cp_bad_code'));
    return;
  }

  const btn = $('#rt-confirm-submit');
  btn.disabled = true;
  let res;
  try {
    res = await fetch('/api/account/totp', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    btn.disabled = false;
    showResetTotpError('#rt-confirm-error', t('network_error'));
    return;
  }
  btn.disabled = false;

  if (res.ok) {
    closeResetTotp();
    flash(t('rt_success'));
    return;
  }

  let msg = t('rt_failed');
  try {
    const data = await res.json();
    if (data && data.message) {
      msg = Array.isArray(data.message) ? data.message.join(' ') : data.message;
    }
  } catch {
    /* ignore */
  }
  showResetTotpError('#rt-confirm-error', msg);
}

$('#account-btn').addEventListener('click', openDashboard);
$('#dashboard-close').addEventListener('click', closeDashboard);

// Settings: left-nav section switching.
document.querySelectorAll('.settings-nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    const search = $('#settings-search');
    if (search && search.value) {
      search.value = '';
      applySettingsSearch('');
    }
    showSettingsPane(item.getAttribute('data-pane'));
  });
});
// Settings: mobile "back to sections" button.
(function () {
  const back = $('#settings-back');
  if (back) back.addEventListener('click', backToSettingsNav);
})();
// Settings: live search across all sections.
(function () {
  const input = $('#settings-search');
  if (input) input.addEventListener('input', () => applySettingsSearch(input.value));
})();
// Settings: copy-to-clipboard buttons for contact email (General + Plan).
document.querySelectorAll('.email-copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const email = btn.getAttribute('data-copy-email') || '';
    if (!email) return;
    const ok = await copyText(email);
    const prev = btn.innerHTML;
    btn.innerHTML = ok
      ? '<i class="bi bi-check2"></i>'
      : '<i class="bi bi-clipboard-x"></i>';
    btn.classList.toggle('copied', ok);
    setTimeout(() => {
      btn.innerHTML = prev;
      btn.classList.remove('copied');
    }, 1200);
  });
});

// Bring-your-own storage: dashboard save button + the "connect storage" nudge
// shown to existing accounts that have not set a provider yet.
(function () {
  const saveBtn = document.getElementById('dash-storage-save');
  if (saveBtn) saveBtn.addEventListener('click', saveStorageSection);
  const maxTabsSave = document.getElementById('max-tabs-save');
  if (maxTabsSave) maxTabsSave.addEventListener('click', saveMaxTabsSetting);
  const maxTabsInput = document.getElementById('max-tabs-input');
  if (maxTabsInput) {
    maxTabsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveMaxTabsSetting();
      }
    });
  }
  const setupBtn = document.getElementById('storage-setup-btn');
  if (setupBtn) {
    setupBtn.addEventListener('click', () => {
      const ov = document.getElementById('storage-setup-overlay');
      if (ov) ov.hidden = true;
      openDashboard();
      showSettingsPane('storage');
      setTimeout(() => {
        const s = document.getElementById('storage-provider-section');
        if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    });
  }
})();
$('#dashboard-overlay').addEventListener('click', (e) => {
  if (e.target === $('#dashboard-overlay')) closeDashboard();
});
$('#delete-account-btn').addEventListener('click', deleteAccount);
$('#change-password-btn').addEventListener('click', openChangePassword);
$('#change-password-close').addEventListener('click', closeChangePassword);
$('#cp-cancel').addEventListener('click', closeChangePassword);
$('#change-password-form').addEventListener('submit', submitChangePassword);
$('#change-password-overlay').addEventListener('click', (e) => {
  if (e.target === $('#change-password-overlay')) closeChangePassword();
});
$('#reset-totp-btn').addEventListener('click', openResetTotp);
$('#reset-totp-close').addEventListener('click', closeResetTotp);
$('#rt-verify-cancel').addEventListener('click', closeResetTotp);
$('#rt-confirm-cancel').addEventListener('click', closeResetTotp);
$('#reset-totp-verify-form').addEventListener('submit', submitResetTotpVerify);
$('#reset-totp-confirm-form').addEventListener('submit', submitResetTotpConfirm);
$('#reset-totp-overlay').addEventListener('click', (e) => {
  if (e.target === $('#reset-totp-overlay')) closeResetTotp();
});
$('#rt-copy-secret').addEventListener('click', async () => {
  const secret = $('#rt-secret').textContent;
  if (!secret) return;
  try {
    await navigator.clipboard.writeText(secret);
    const btn = $('#rt-copy-secret');
    const original = btn.textContent;
    btn.textContent = t('copied');
    setTimeout(() => (btn.textContent = original), 1500);
  } catch {
    /* clipboard unavailable */
  }
});
$('#plan-upgrade').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-plan]');
  if (btn) startCheckout(btn.getAttribute('data-plan'));
});
$('#manage-billing-btn').addEventListener('click', openBillingPortal);
document.addEventListener('keydown', (e) => {
  if (!$('#change-password-overlay').hidden && e.key === 'Escape') {
    closeChangePassword();
    return;
  }
  if (!$('#reset-totp-overlay').hidden && e.key === 'Escape') {
    closeResetTotp();
    return;
  }
  if (!$('#dashboard-overlay').hidden && e.key === 'Escape') {
    closeDashboard();
  }
});

/* close mobile sidebar after opening a file */
function maybeCloseSidebar() {
  if (window.innerWidth <= 800) toggleSidebar(false);
}

/* ---------- web link manager ---------- */

const WEBLINKS_DIR = 'weblinks';
const WEBLINKS_CSV = 'weblinks/weblinks.csv';
// CSV parse/serialize/sanitize helpers (and the Linky-compatible header) live
// in wo-util.js (loaded before this script) so they can be unit-tested without
// a DOM. Bind them to the names the rest of this file already uses.
const serializeWeblinks = (links) => WOUtil.serializeWeblinks(links);
const csvToLinks = (text) => WOUtil.csvToLinks(text);
const sanitizeLinkUrl = (value) => WOUtil.sanitizeLinkUrl(value);

const weblinksState = {
  // { name, description, category, url, username, contactName, contactPhone,
  //   contactEmail, notes }
  links: [],
  version: null, // last loaded file version, for concurrent-edit detection
  editIndex: null, // index being edited, or null when adding
  filter: '',
};

/** Persist the current links to the vault CSV (create folder/file as needed). */
async function saveWeblinks() {
  const csv = serializeWeblinks(weblinksState.links);
  const res = await api('PUT', '/api/file', {
    path: WEBLINKS_CSV,
    content: await encryptContent(csv),
    baseVersion: weblinksState.version || undefined,
  });
  weblinksState.version = res.version;
}

/**
 * Load (or first-time create) the weblinks CSV into `weblinksState`. On first
 * use this creates the `weblinks` folder and an empty CSV. Returns true on
 * success; on failure shows an alert (unless silent) and returns false. The
 * view is shown separately by the tab machinery so switching back never
 * reloads.
 */
async function loadWeblinksData(opts = {}) {
  showLoading(t('loading'));
  try {
    let data;
    try {
      data = await api(
        'GET',
        '/api/file?path=' + encodeURIComponent(WEBLINKS_CSV),
      );
    } catch (err) {
      if (err.status === 400 || err.status === 404) {
        // First run: create the folder and an empty CSV with just the header.
        await api('POST', '/api/folder', { path: WEBLINKS_DIR }).catch(() => {});
        data = await api('PUT', '/api/file', {
          path: WEBLINKS_CSV,
          content: await encryptContent(serializeWeblinks([])),
        });
        await loadTree();
      } else {
        throw err;
      }
    }
    weblinksState.links = csvToLinks(await decryptContent(data.content || ''));
    weblinksState.version = data.version || null;
    weblinksState.filter = '';
    const search = $('#weblinks-search');
    if (search) search.value = '';
    return true;
  } catch (err) {
    if (!opts.silent) {
      await uiAlert(t('open_failed_title'), {
        message: err.message || t('weblinks_load_failed'),
      });
    }
    return false;
  } finally {
    hideLoading();
  }
}

function renderWeblinks() {
  const list = $('#weblinks-list');
  const empty = $('#weblinks-empty');
  const count = $('#weblinks-count');
  if (!list) return;
  list.innerHTML = '';

  const q = weblinksState.filter.trim().toLowerCase();
  const visible = weblinksState.links
    .map((link, index) => ({ link, index }))
    .filter(({ link }) => {
      if (!q) return true;
      return [
        link.name,
        link.url,
        link.description,
        link.category,
        link.username,
        link.contactName,
        link.contactPhone,
        link.contactEmail,
        link.notes,
      ]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });

  count.textContent = t('weblinks_count_n', { n: weblinksState.links.length });

  if (!weblinksState.links.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const { link, index } of visible) {
    list.appendChild(buildWeblinkCard(link, index));
  }
}

function buildWeblinkCard(link, index) {
  const card = document.createElement('div');
  card.className = 'weblink-card';

  const main = document.createElement('div');
  main.className = 'weblink-main';

  const a = document.createElement('a');
  a.className = 'weblink-name';
  a.href = link.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const icon = document.createElement('i');
  icon.className = 'bi bi-box-arrow-up-right';
  const nameText = document.createElement('span');
  nameText.textContent = link.name || link.url;
  a.appendChild(nameText);
  a.appendChild(icon);
  main.appendChild(a);

  const url = document.createElement('span');
  url.className = 'weblink-url';
  url.textContent = link.url;
  main.appendChild(url);

  if (link.description) {
    const desc = document.createElement('p');
    desc.className = 'weblink-desc';
    desc.textContent = link.description;
    main.appendChild(desc);
  }
  if (link.category) {
    const tag = document.createElement('span');
    tag.className = 'weblink-tag';
    tag.textContent = link.category;
    main.appendChild(tag);
  }

  // Optional Linky fields — render each only when present.
  const meta = [];
  if (link.username)
    meta.push([t('weblinks_field_username'), link.username, null]);
  if (link.contactName)
    meta.push([t('weblinks_field_contact_name'), link.contactName, null]);
  if (link.contactPhone)
    meta.push([
      t('weblinks_field_contact_phone'),
      link.contactPhone,
      'tel:' + link.contactPhone,
    ]);
  if (link.contactEmail)
    meta.push([
      t('weblinks_field_contact_email'),
      link.contactEmail,
      'mailto:' + link.contactEmail,
    ]);
  if (meta.length) {
    const dl = document.createElement('dl');
    dl.className = 'weblink-meta';
    for (const [label, value, href] of meta) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (href) {
        const link2 = document.createElement('a');
        link2.href = href;
        link2.textContent = value;
        dd.appendChild(link2);
      } else {
        dd.textContent = value;
      }
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    main.appendChild(dl);
  }
  if (link.notes) {
    const notes = document.createElement('p');
    notes.className = 'weblink-notes';
    notes.textContent = link.notes;
    main.appendChild(notes);
  }
  card.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'weblink-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'icon-btn';
  copyBtn.title = t('weblinks_copy');
  copyBtn.setAttribute('aria-label', t('weblinks_copy'));
  copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(link.url);
    if (ok) flash(t('weblinks_copied'));
    else
      await uiAlert(t('open_failed_title'), {
        message: t('weblinks_copy_failed'),
      });
  });
  actions.appendChild(copyBtn);

  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn';
  editBtn.title = t('weblinks_edit');
  editBtn.setAttribute('aria-label', t('weblinks_edit'));
  editBtn.innerHTML = '<i class="bi bi-pencil"></i>';
  editBtn.addEventListener('click', () => openWeblinkModal(index));
  actions.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn';
  delBtn.title = t('delete');
  delBtn.setAttribute('aria-label', t('delete'));
  delBtn.innerHTML = '<i class="bi bi-trash"></i>';
  delBtn.addEventListener('click', () => deleteWeblink(index));
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

/**
 * Fill the category <datalist> with the existing category names so the modal's
 * category field both recommends and lets the user search saved categories.
 */
function populateWeblinkCategories() {
  const dl = $('#weblink-category-list');
  if (!dl) return;
  dl.innerHTML = '';
  for (const cat of WOUtil.weblinkCategories(weblinksState.links)) {
    const opt = document.createElement('option');
    opt.value = cat;
    dl.appendChild(opt);
  }
}

function openWeblinkModal(index) {
  weblinksState.editIndex = typeof index === 'number' ? index : null;
  const editing = weblinksState.editIndex !== null;
  const link = editing ? weblinksState.links[weblinksState.editIndex] : null;
  $('#weblink-modal-title').querySelector('span').textContent = editing
    ? t('weblinks_edit')
    : t('weblinks_add');
  populateWeblinkCategories();
  $('#weblink-url').value = link ? link.url : '';
  $('#weblink-name').value = link ? link.name : '';
  $('#weblink-category').value = link ? link.category : '';
  $('#weblink-description').value = link ? link.description : '';
  $('#weblink-username').value = link ? link.username || '' : '';
  $('#weblink-contact-name').value = link ? link.contactName || '' : '';
  $('#weblink-contact-phone').value = link ? link.contactPhone || '' : '';
  $('#weblink-contact-email').value = link ? link.contactEmail || '' : '';
  $('#weblink-notes').value = link ? link.notes || '' : '';
  $('#weblink-error').hidden = true;
  $('#weblink-overlay').hidden = false;
  setTimeout(() => $('#weblink-url').focus(), 0);
}

function closeWeblinkModal() {
  $('#weblink-overlay').hidden = true;
  weblinksState.editIndex = null;
}

async function submitWeblink(e) {
  e.preventDefault();
  const url = sanitizeLinkUrl($('#weblink-url').value);
  const errEl = $('#weblink-error');
  if (!url) {
    errEl.textContent = t('weblinks_invalid_url');
    errEl.hidden = false;
    return;
  }
  const record = {
    name: $('#weblink-name').value.trim() || url,
    description: $('#weblink-description').value.trim(),
    url,
    category: $('#weblink-category').value.trim(),
    username: $('#weblink-username').value.trim(),
    contactName: $('#weblink-contact-name').value.trim(),
    contactPhone: $('#weblink-contact-phone').value.trim(),
    contactEmail: $('#weblink-contact-email').value.trim(),
    notes: $('#weblink-notes').value.trim(),
  };
  showLoading(t('loading'));
  try {
    if (weblinksState.editIndex !== null) {
      weblinksState.links[weblinksState.editIndex] = record;
    } else {
      weblinksState.links.push(record);
    }
    await saveWeblinks();
    closeWeblinkModal();
    renderWeblinks();
    flash(t('weblinks_saved'));
  } catch (err) {
    errEl.textContent = err.message || t('weblinks_load_failed');
    errEl.hidden = false;
  } finally {
    hideLoading();
  }
}

async function deleteWeblink(index) {
  const ok = await uiConfirm(t('weblinks_delete_title'), {
    message: t('weblinks_delete_msg'),
    okText: t('delete'),
    danger: true,
  });
  if (!ok) return;
  showLoading(t('loading'));
  try {
    weblinksState.links.splice(index, 1);
    await saveWeblinks();
    renderWeblinks();
    flash(t('weblinks_deleted'));
  } catch (err) {
    await uiAlert(t('open_failed_title'), {
      message: err.message || t('weblinks_load_failed'),
    });
  } finally {
    hideLoading();
  }
}

/**
 * Merge CSV text into the weblinks vault file, de-duplicating by URL (existing
 * entries win). With `opts.ensureLoaded` the current file is loaded first so
 * callers outside the Web links tab (e.g. importing a CSV received in chat) can
 * never clobber existing links or hit a stale version. Returns true on success.
 */
/**
 * Delete a whole category: pick an existing category, confirm (the dialog shows
 * how many links will be removed), then drop every link in it. Destructive, so
 * it always confirms first.
 */
async function deleteWeblinkCategory() {
  const cats = WOUtil.weblinkCategories(weblinksState.links);
  if (!cats.length) {
    await uiAlert(t('weblinks_del_cat'), {
      message: t('weblinks_no_categories'),
    });
    return;
  }
  const cat = await pickFromList(t('weblinks_del_cat_pick'), cats);
  if (cat == null) return;
  const inCat = WOUtil.linksInCategory(weblinksState.links, cat);
  const ok = await uiConfirm(t('weblinks_del_cat'), {
    message: t('weblinks_del_cat_msg', { category: cat, n: inCat.length }),
    okText: t('delete'),
    danger: true,
  });
  if (!ok) return;
  showLoading(t('loading'));
  try {
    const key = cat.trim().toLowerCase();
    weblinksState.links = weblinksState.links.filter(
      (l) =>
        (l.category ? String(l.category) : '').trim().toLowerCase() !== key,
    );
    await saveWeblinks();
    renderWeblinks();
    flash(t('weblinks_del_cat_done', { n: inCat.length }));
  } catch (err) {
    await uiAlert(t('open_failed_title'), {
      message: err.message || t('weblinks_load_failed'),
    });
  } finally {
    hideLoading();
  }
}

async function importWeblinksFromText(text, opts = {}) {
  const incoming = csvToLinks(text);
  if (!incoming.length) {
    await uiAlert(t('import_failed_title'), {
      message: t('weblinks_import_failed'),
    });
    return false;
  }
  if (opts.ensureLoaded) {
    const ok = await loadWeblinksData({ silent: true });
    if (!ok) {
      await uiAlert(t('import_failed_title'), {
        message: t('weblinks_load_failed'),
      });
      return false;
    }
  }
  showLoading(t('importing'));
  try {
    const seen = new Set(weblinksState.links.map((l) => l.url));
    let added = 0;
    for (const link of incoming) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      weblinksState.links.push(link);
      added++;
    }
    await saveWeblinks();
    renderWeblinks();
    flash(t('weblinks_imported_n', { n: added }));
    return true;
  } catch (err) {
    await uiAlert(t('import_failed_title'), {
      message: err.message || t('weblinks_import_failed'),
    });
    return false;
  } finally {
    hideLoading();
  }
}

async function importWeblinksCsv(file) {
  try {
    await importWeblinksFromText(await file.text());
  } catch {
    await uiAlert(t('import_failed_title'), {
      message: t('weblinks_import_failed'),
    });
  }
}

/**
 * Fetch + decrypt the weblinks CSV on demand and return its links, so features
 * outside the Web links tab (e.g. sharing from chat) always get a fresh copy
 * even when the tab was never opened. Returns [] on any error / missing file.
 */
async function getWeblinksForShare() {
  try {
    const data = await api(
      'GET',
      '/api/file?path=' + encodeURIComponent(WEBLINKS_CSV),
    );
    return csvToLinks(await decryptContent(data.content || ''));
  } catch {
    return [];
  }
}

/**
 * Ask the user which links to include — all, or one existing category — via the
 * shared searchable picker. Resolves to `{ category, links }` (category is ''
 * for "all links") or null if the user cancelled.
 */
async function pickWeblinksScope(links) {
  const cats = WOUtil.weblinkCategories(links);
  const allLabel = t('weblinks_export_all');
  const choice = await pickFromList(t('weblinks_export_pick'), [
    allLabel,
    ...cats,
  ]);
  if (choice == null) return null;
  const category = choice === allLabel ? '' : choice;
  return { category, links: WOUtil.linksInCategory(links, category) };
}

/** Export the current links (all or a chosen category) as a downloaded CSV. */
async function exportWeblinks() {
  if (!weblinksState.links.length) {
    await uiAlert(t('weblinks_export'), { message: t('weblinks_none') });
    return;
  }
  const scope = await pickWeblinksScope(weblinksState.links);
  if (!scope) return;
  const csv = serializeWeblinks(scope.links);
  triggerDownload(
    new Blob([csv], { type: 'text/csv' }),
    WOUtil.weblinksCsvFilename(scope.category),
  );
  flash(t('weblinks_exported'));
}

/**
 * Build a weblinks CSV (all or one category) as a ready-to-send chat
 * attachment `{ name, mime, bytes }`, or null if there are no links or the
 * user cancelled. Injected into the chat layer via `chatDeps`.
 */
async function pickWeblinksCsvAttachment() {
  const links = await getWeblinksForShare();
  if (!links.length) {
    await uiAlert(t('weblinks_export'), { message: t('weblinks_none') });
    return null;
  }
  const scope = await pickWeblinksScope(links);
  if (!scope) return null;
  const csv = serializeWeblinks(scope.links);
  return {
    name: WOUtil.weblinksCsvFilename(scope.category),
    mime: 'text/csv',
    bytes: new TextEncoder().encode(csv),
  };
}

(function setupWeblinks() {
  $('#weblinks-btn').addEventListener('click', () =>
    openSpecialTab('weblinks', { refresh: true }),
  );
  $('#weblink-add').addEventListener('click', () => openWeblinkModal(null));
  $('#weblink-form').addEventListener('submit', submitWeblink);
  $('#weblink-cancel').addEventListener('click', closeWeblinkModal);
  $('#weblink-modal-close').addEventListener('click', closeWeblinkModal);
  $('#weblink-overlay').addEventListener('click', (e) => {
    if (e.target === $('#weblink-overlay')) closeWeblinkModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#weblink-overlay').hidden) closeWeblinkModal();
  });

  $('#weblink-export').addEventListener('click', exportWeblinks);
  $('#weblink-del-category').addEventListener('click', deleteWeblinkCategory);

  const importInput = $('#weblinks-import-input');
  $('#weblink-import').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (file) await importWeblinksCsv(file);
  });

  $('#weblinks-search').addEventListener(
    'input',
    debounce((e) => {
      weblinksState.filter = e.target.value;
      renderWeblinks();
    }, 120),
  );
})();

/* ---------- wikilink graph ---------- */

// A force-directed graph of the vault: each markdown note is a node, each
// `[[wikilink]]` (or `![[embed]]`) between two notes is an edge. Because note
// contents are end-to-end encrypted, the graph is built client-side by fetching
// and decrypting every note, then extracting and resolving its links.
const graphState = {
  nodes: [],
  edges: [],
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  alpha: 0,
  raf: null,
  dpr: 1,
  active: null, // node currently hovered (mouse) or tapped (touch)
  pendingSim: false, // true after a (re)build so the tab re-runs the force sim
  dragNode: null,
  panning: false,
  moved: false,
  startX: 0,
  startY: 0,
  pointers: new Map(),
  pinchDist: 0,
  pinchScale: 1,
};

const GRAPH_FORCES = {
  repulsion: 2600,
  springLen: 70,
  springK: 0.02,
  gravity: 0.025,
  damping: 0.82,
};

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Pull every `[[target]]` / `![[target]]` out of note text (alias/anchor stripped). */
function extractWikiTargets(text) {
  const out = [];
  const re = /!?\[\[([^\]\n]+)\]\]/g;
  let m;
  while ((m = re.exec(text))) {
    const inner = m[1].split('|')[0].split('#')[0].trim();
    if (inner) out.push(inner);
  }
  return out;
}

function buildNoteIndex(paths) {
  const byPath = new Map();
  const byName = new Map();
  for (const p of paths) {
    byPath.set(p.toLowerCase(), p);
    const base = p.split('/').pop().replace(/\.(md|markdown)$/i, '').toLowerCase();
    if (!byName.has(base)) byName.set(base, p);
  }
  return { byPath, byName };
}

/** Resolve a wikilink target to an actual note path (or null for non-notes). */
function resolveNotePath(target, idx) {
  const clean = target.replace(/^\.\//, '').trim();
  const lc = clean.toLowerCase();
  if (idx.byPath.has(lc)) return idx.byPath.get(lc);
  if (idx.byPath.has(lc + '.md')) return idx.byPath.get(lc + '.md');
  if (idx.byPath.has(lc + '.markdown')) return idx.byPath.get(lc + '.markdown');
  const base = clean.split('/').pop().replace(/\.(md|markdown)$/i, '').toLowerCase();
  if (idx.byName.has(base)) return idx.byName.get(base);
  return null;
}

/** Fetch every note's ciphertext in one request, then build nodes + edges. */
async function buildGraphData() {
  // One bulk call (the server streams every note's ciphertext) instead of one
  // GET per note — fast and avoids tripping the rate limiter on large vaults.
  const rows = await api('GET', '/api/graph/notes'); // [{ path, content }]
  const idx = buildNoteIndex(rows.map((r) => r.path));
  const nodes = rows.map((r) => ({
    id: r.path,
    name: r.path.split('/').pop().replace(/\.(md|markdown)$/i, ''),
    x: 0, y: 0, vx: 0, vy: 0, r: 4, deg: 0,
  }));
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = [];
  const seen = new Set();

  for (const row of rows) {
    const a = indexOf.get(row.path);
    if (a == null) continue;
    let text;
    try {
      text = await decryptContent(row.content || '');
    } catch (e) {
      continue; // unreadable note → still shown as an isolated node
    }
    for (const tgt of extractWikiTargets(text)) {
      const dest = resolveNotePath(tgt, idx);
      if (!dest || dest === row.path) continue;
      const b = indexOf.get(dest);
      if (b == null) continue;
      const key = a < b ? a + ':' + b : b + ':' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b });
      nodes[a].deg++;
      nodes[b].deg++;
    }
  }
  for (const n of nodes) n.r = 4 + Math.min(9, Math.sqrt(n.deg) * 2);
  return { nodes, edges };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function resizeGraphCanvas() {
  const canvas = $('#graph-canvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  graphState.dpr = dpr;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

function graphCenter() {
  const canvas = $('#graph-canvas');
  return {
    cx: canvas.clientWidth / 2 + graphState.offsetX,
    cy: canvas.clientHeight / 2 + graphState.offsetY,
  };
}

function nodeScreenPos(n) {
  const { cx, cy } = graphCenter();
  return { x: cx + n.x * graphState.scale, y: cy + n.y * graphState.scale };
}

function screenToWorld(px, py) {
  const { cx, cy } = graphCenter();
  return { x: (px - cx) / graphState.scale, y: (py - cy) / graphState.scale };
}

function graphNodeAt(px, py) {
  // Iterate back-to-front so the topmost (last drawn) node wins.
  for (let i = graphState.nodes.length - 1; i >= 0; i--) {
    const n = graphState.nodes[i];
    const p = nodeScreenPos(n);
    const r = clampNum(n.r * graphState.scale, 4, 26) + 4;
    if ((px - p.x) ** 2 + (py - p.y) ** 2 <= r * r) return n;
  }
  return null;
}

function graphSimStep() {
  const { nodes, edges } = graphState;
  const f = GRAPH_FORCES;
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
      const d = Math.sqrt(d2);
      const rep = f.repulsion / d2;
      a.vx += (dx / d) * rep; a.vy += (dy / d) * rep;
      b.vx -= (dx / d) * rep; b.vy -= (dy / d) * rep;
    }
  }
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const force = (d - f.springLen) * f.springK;
    a.vx += (dx / d) * force; a.vy += (dy / d) * force;
    b.vx -= (dx / d) * force; b.vy -= (dy / d) * force;
  }
  for (const nd of nodes) {
    nd.vx += -nd.x * f.gravity;
    nd.vy += -nd.y * f.gravity;
    nd.vx *= f.damping;
    nd.vy *= f.damping;
    if (nd !== graphState.dragNode) {
      nd.x += nd.vx * graphState.alpha;
      nd.y += nd.vy * graphState.alpha;
    }
  }
}

function drawGraph() {
  const canvas = $('#graph-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = graphState.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const edgeColor = cssVar('--graph-edge') || '#888';
  const edgeActiveColor = cssVar('--graph-edge-active') || cssVar('--accent') || '#7c6cf6';
  const nodeColor = cssVar('--accent') || '#7c6cf6';
  const textColor = cssVar('--text') || '#ddd';
  const s = graphState.scale;
  const showLabels = graphState.nodes.length <= 40 || s >= 1.4;
  const activeIdx = graphState.active ? graphState.nodes.indexOf(graphState.active) : -1;

  // Connection lines are always fully opaque so they stay clearly visible —
  // including while a node is hovered. The hovered node's own edges are then
  // redrawn on top in the accent colour so its connections stand out.
  ctx.globalAlpha = 1;
  ctx.strokeStyle = edgeColor;
  ctx.lineWidth = 1.2;
  for (const e of graphState.edges) {
    if (e.a === activeIdx || e.b === activeIdx) continue; // drawn highlighted below
    const a = nodeScreenPos(graphState.nodes[e.a]);
    const b = nodeScreenPos(graphState.nodes[e.b]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  if (activeIdx >= 0) {
    ctx.strokeStyle = edgeActiveColor;
    ctx.lineWidth = 2;
    for (const e of graphState.edges) {
      if (e.a !== activeIdx && e.b !== activeIdx) continue;
      const a = nodeScreenPos(graphState.nodes[e.a]);
      const b = nodeScreenPos(graphState.nodes[e.b]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  ctx.font = '12px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const nd of graphState.nodes) {
    const p = nodeScreenPos(nd);
    const r = clampNum(nd.r * s, 3, 26);
    const active = nd === graphState.active;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = nodeColor;
    ctx.globalAlpha = active ? 1 : 0.92;
    ctx.fill();
    if (active) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = textColor;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (showLabels || active) {
      ctx.fillStyle = textColor;
      ctx.fillText(nd.name, p.x, p.y + r + 3);
    }
  }
}

function positionGraphTooltip() {
  const tip = $('#graph-tooltip');
  if (!tip || !graphState.active) return;
  const p = nodeScreenPos(graphState.active);
  tip.style.left = p.x + 'px';
  tip.style.top = p.y + 'px';
}

function showGraphTooltip(node) {
  const tip = $('#graph-tooltip');
  if (!tip) return;
  graphState.active = node;
  if (!node) { tip.hidden = true; return; }
  tip.innerHTML = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = node.name;
  btn.addEventListener('click', () => openFile(node.id));
  tip.appendChild(btn);
  tip.hidden = false;
  positionGraphTooltip();
}

function requestGraphDraw() {
  if (graphState.raf) return;
  drawGraph();
  positionGraphTooltip();
}

function graphLoop() {
  graphSimStep();
  graphState.alpha *= 0.985;
  drawGraph();
  positionGraphTooltip();
  if (graphState.alpha > 0.02 || graphState.dragNode) {
    graphState.raf = requestAnimationFrame(graphLoop);
  } else {
    graphState.raf = null;
  }
}

function startGraphSim(alpha) {
  graphState.alpha = Math.max(graphState.alpha, alpha == null ? 1 : alpha);
  if (!graphState.raf) graphState.raf = requestAnimationFrame(graphLoop);
}

function stopGraphSim() {
  if (graphState.raf) cancelAnimationFrame(graphState.raf);
  graphState.raf = null;
}

function graphZoomAround(px, py, factor) {
  const canvas = $('#graph-canvas');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const s0 = graphState.scale;
  const s1 = clampNum(s0 * factor, 0.2, 4);
  const cx0 = w / 2 + graphState.offsetX;
  const cy0 = h / 2 + graphState.offsetY;
  const wx = (px - cx0) / s0;
  const wy = (py - cy0) / s0;
  graphState.scale = s1;
  graphState.offsetX = px - w / 2 - wx * s1;
  graphState.offsetY = py - h / 2 - wy * s1;
  requestGraphDraw();
}

// Timestamp of the last successful graph build. The built nodes/edges live in
// `graphState` (with their settled positions), so reopening the graph within
// the TTL reuses them — no refetch, no re-simulation. The vault key changes
// (note saved, created, renamed, deleted) clear this via invalidateGraphCache().
let graphBuiltAt = 0;
function graphCacheTtl() {
  return Number(window.__WO_GRAPH_CACHE_TTL_MS__) || 0;
}
function invalidateGraphCache() {
  graphBuiltAt = 0;
}

/**
 * Reveal the graph view and (re)draw the current `graphState` layout. Called by
 * the tab machinery, so it does NOT hide other views or touch tabs — that is
 * handled by activateTab. Re-runs the force sim only when the data was just
 * (re)built (`pendingSim`); a plain tab switch keeps the user's pan/zoom.
 */
function activateGraphTab() {
  const n = graphState.nodes.length;
  graphState.active = null;
  $('#graph-view').hidden = false;
  $('#graph-empty').hidden = n > 0;
  $('#graph-hint').hidden = n === 0;
  $('#graph-tooltip').hidden = true;
  const resim = graphState.pendingSim;
  graphState.pendingSim = false;
  // Defer sizing until the view is laid out so clientWidth/Height are correct.
  requestAnimationFrame(() => {
    resizeGraphCanvas();
    if (resim) startGraphSim(1);
    else requestGraphDraw();
  });
}

/**
 * Ensure `graphState` holds a usable layout, rebuilding from the vault's notes
 * unless a fresh cached layout already exists (or `opts.force`). Returns true on
 * success; on failure alerts (unless silent) and returns false. Sets
 * `graphState.pendingSim` when a rebuild happened so the view re-simulates.
 */
async function loadGraphView(opts = {}) {
  const ttl = graphCacheTtl();
  const fresh =
    !opts.force &&
    graphBuiltAt &&
    graphState.nodes.length &&
    Date.now() - graphBuiltAt < ttl;
  if (fresh) {
    // Reuse the cached layout (keeps the user's pan/zoom too).
    graphState.pendingSim = false;
    return true;
  }
  showLoading(t('graph_building'));
  try {
    const data = await buildGraphData();
    graphState.nodes = data.nodes;
    graphState.edges = data.edges;
    graphState.scale = 1;
    graphState.offsetX = 0;
    graphState.offsetY = 0;
    const n = data.nodes.length;
    const radius = Math.max(80, n * 11);
    data.nodes.forEach((nd, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      const jitter = 0.5 + Math.random() * 0.3;
      nd.x = Math.cos(a) * radius * jitter;
      nd.y = Math.sin(a) * radius * jitter;
    });
    graphBuiltAt = Date.now();
    graphState.pendingSim = true;
    return true;
  } catch (err) {
    if (!opts.silent) {
      await uiAlert(t('open_failed_title'), {
        message: err.message || t('graph_failed'),
      });
    }
    return false;
  } finally {
    hideLoading();
  }
}

(function setupGraph() {
  const btn = $('#graph-btn');
  if (btn)
    btn.addEventListener('click', () => openSpecialTab('graph', { refresh: true }));
  const canvas = $('#graph-canvas');
  if (!canvas) return;

  $('#graph-zoom-in').addEventListener('click', () => {
    graphZoomAround(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.25);
  });
  $('#graph-zoom-out').addEventListener('click', () => {
    graphZoomAround(canvas.clientWidth / 2, canvas.clientHeight / 2, 0.8);
  });
  $('#graph-refresh').addEventListener('click', () =>
    openSpecialTab('graph', { refresh: true, force: true }),
  );

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    graphZoomAround(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  const localPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const pt = localPoint(e);
    graphState.pointers.set(e.pointerId, pt);
    if (graphState.pointers.size === 2) {
      const pts = [...graphState.pointers.values()];
      graphState.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      graphState.pinchScale = graphState.scale;
      graphState.dragNode = null;
      graphState.panning = false;
      return;
    }
    graphState.moved = false;
    graphState.startX = pt.x;
    graphState.startY = pt.y;
    const node = graphNodeAt(pt.x, pt.y);
    if (node) {
      graphState.dragNode = node;
      graphState.panning = false;
    } else {
      graphState.dragNode = null;
      graphState.panning = true;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const pt = localPoint(e);
    if (graphState.pointers.has(e.pointerId)) graphState.pointers.set(e.pointerId, pt);

    // Pinch-to-zoom with two active pointers.
    if (graphState.pointers.size === 2 && graphState.pinchDist > 0) {
      const pts = [...graphState.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const target = graphState.pinchScale * (dist / graphState.pinchDist);
      graphZoomAround(mid.x, mid.y, clampNum(target, 0.2, 4) / graphState.scale);
      return;
    }

    // Hover (mouse with no button held) → highlight + tooltip.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      const node = graphNodeAt(pt.x, pt.y);
      if (node !== graphState.active) {
        showGraphTooltip(node);
        requestGraphDraw();
      }
      return;
    }

    if (Math.abs(pt.x - graphState.startX) > 4 || Math.abs(pt.y - graphState.startY) > 4) {
      graphState.moved = true;
    }
    if (graphState.dragNode) {
      const w = screenToWorld(pt.x, pt.y);
      graphState.dragNode.x = w.x;
      graphState.dragNode.y = w.y;
      graphState.dragNode.vx = 0;
      graphState.dragNode.vy = 0;
      startGraphSim(0.3);
    } else if (graphState.panning) {
      graphState.offsetX += pt.x - graphState.startX;
      graphState.offsetY += pt.y - graphState.startY;
      graphState.startX = pt.x;
      graphState.startY = pt.y;
      requestGraphDraw();
    }
  });

  const endPointer = (e) => {
    const pt = localPoint(e);
    const wasNode = graphState.dragNode;
    const tapped = !graphState.moved;
    graphState.pointers.delete(e.pointerId);
    if (graphState.pointers.size < 2) graphState.pinchDist = 0;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);

    if (tapped) {
      const node = graphNodeAt(pt.x, pt.y);
      if (node) {
        if (e.pointerType === 'mouse') {
          openFile(node.id); // desktop: a click opens straight away
        } else {
          showGraphTooltip(node); // touch: reveal the name, tap it to open
          requestGraphDraw();
        }
      } else if (e.pointerType !== 'mouse') {
        showGraphTooltip(null); // tap on empty space dismisses the label
        requestGraphDraw();
      }
    }
    graphState.dragNode = null;
    graphState.panning = false;
    if (wasNode) startGraphSim(0.1);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', (e) => {
    graphState.pointers.delete(e.pointerId);
    graphState.dragNode = null;
    graphState.panning = false;
  });

  window.addEventListener('resize', () => {
    if ($('#graph-view').hidden) return;
    resizeGraphCanvas();
    requestGraphDraw();
  });
})();

/* ---------- calendar ------------------------------------------------------ */

// Which month the calendar is currently showing, and the last day->files map.
// `dueByDay` maps a YYYY-MM-DD key to kanban card due entries for that day.
const calendarState = {
  year: 0,
  month: 0,
  byDay: new Map(),
  dueByDay: new Map(),
  selected: null,
};

/** Fetch every file and bucket by local last-modified day (skips internals). */
async function loadCalendarData() {
  const files = await api('GET', '/api/files');
  // Show every user file (incl. templates & daily notes); only websidian's own
  // internal settings folder is hidden.
  calendarState.byDay = WOUtil.filesByDay(files, [RESERVED_DIR]);
  calendarState.dueByDay = await loadKanbanDueDates(files);
}

/**
 * Read every `.kanban` board and bucket its dated cards by due day, so a card's
 * due date shows up on the calendar. Boards that fail to load/parse are skipped
 * (a broken board must not blank the whole calendar).
 */
async function loadKanbanDueDates(files) {
  const map = new Map();
  const boards = (files || []).filter(
    (f) => f && f.path && extOf(f.path) === 'kanban',
  );
  for (const f of boards) {
    let board;
    try {
      const data = await api(
        'GET',
        '/api/file?path=' + encodeURIComponent(f.path),
      );
      board = WOUtil.kanbanNormalize(await decryptContent(data.content || ''));
    } catch {
      continue;
    }
    for (const entry of WOUtil.kanbanDueEntries(board, f.path)) {
      const arr = map.get(entry.due);
      if (arr) arr.push(entry);
      else map.set(entry.due, [entry]);
    }
  }
  return map;
}

/** Combined per-day counts (files + kanban due cards) for the month grid. */
function calendarCounts() {
  const merged = new Map();
  for (const [key, arr] of calendarState.byDay) merged.set(key, arr.length);
  for (const [key, arr] of calendarState.dueByDay) {
    merged.set(key, (merged.get(key) || 0) + arr.length);
  }
  return merged;
}

/**
 * Load the calendar data (files bucketed by day) into `calendarState` and
 * default to the current month. Returns true on success; on failure shows an
 * alert (unless silent) and returns false. Rendering/showing the view is done
 * by the tab machinery so switching back never reloads.
 */
async function loadCalendarView(opts = {}) {
  showLoading(t('calendar_loading'));
  try {
    await loadCalendarData();
  } catch (err) {
    hideLoading();
    if (!opts.silent) {
      await uiAlert(t('open_failed_title'), {
        message: err.message || t('calendar_failed'),
      });
    }
    return false;
  }
  hideLoading();
  const now = new Date();
  if (!calendarState.year) {
    calendarState.year = now.getFullYear();
    calendarState.month = now.getMonth();
  }
  calendarState.selected = null;
  return true;
}

/** Month name in the active language via the browser's Intl formatter. */
function monthLabel(year, month) {
  const lang = (window.I18N && window.I18N.lang) || 'en';
  try {
    return new Date(year, month, 1).toLocaleDateString(lang, {
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return year + '-' + String(month + 1).padStart(2, '0');
  }
}

/** Render the month grid and (if a day is selected) its file list. */
function renderCalendar() {
  const counts = calendarCounts();
  const model = WOUtil.buildCalendarModel(
    calendarState.year,
    calendarState.month,
    counts,
  );
  $('#calendar-title').textContent = monthLabel(
    calendarState.year,
    calendarState.month,
  );

  // Weekday header (Mon..Sun), localized short names.
  const lang = (window.I18N && window.I18N.lang) || 'en';
  const dow = $('#calendar-dow');
  dow.innerHTML = '';
  for (let d = 0; d < 7; d++) {
    const ref = new Date(2024, 0, 1 + d); // 2024-01-01 is a Monday
    const cell = document.createElement('span');
    cell.className = 'calendar-dow-cell';
    try {
      cell.textContent = ref.toLocaleDateString(lang, { weekday: 'short' });
    } catch {
      cell.textContent = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][d];
    }
    dow.appendChild(cell);
  }

  const todayKey = WOUtil.formatDailyDate(new Date());
  const grid = $('#calendar-grid');
  grid.innerHTML = '';
  for (const week of model.weeks) {
    for (const cell of week) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'calendar-cell';
      if (!cell.inMonth) btn.classList.add('is-other-month');
      if (cell.key === todayKey) btn.classList.add('is-today');
      if (cell.key === calendarState.selected) btn.classList.add('is-selected');
      if (cell.count > 0) btn.classList.add('has-files');

      const num = document.createElement('span');
      num.className = 'calendar-day-num';
      num.textContent = String(cell.day);
      btn.appendChild(num);

      if (cell.count > 0) {
        const badge = document.createElement('span');
        badge.className = 'calendar-count';
        badge.textContent = String(cell.count);
        badge.title = t('calendar_files_n', { n: cell.count });
        btn.appendChild(badge);
      }

      btn.addEventListener('click', () => {
        calendarState.selected =
          calendarState.selected === cell.key ? null : cell.key;
        renderCalendar();
      });
      grid.appendChild(btn);
    }
  }

  renderCalendarDayList();
}

/** Render the list of files for the currently selected day. */
function renderCalendarDayList() {
  const panel = $('#calendar-daylist');
  const heading = $('#calendar-daylist-title');
  const list = $('#calendar-daylist-files');
  const empty = $('#calendar-daylist-empty');
  const key = calendarState.selected;
  list.innerHTML = '';
  if (!key) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  heading.textContent = key;
  const files = calendarState.byDay.get(key) || [];
  const dues = calendarState.dueByDay.get(key) || [];
  empty.hidden = files.length + dues.length > 0;
  // The month grid can be tall; make sure the day's file list is visible.
  requestAnimationFrame(() =>
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
  );
  // Kanban cards due this day first, then files modified this day.
  for (const entry of dues) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'calendar-file calendar-due';
    const icon = document.createElement('i');
    icon.className = 'bi bi-kanban';
    const name = document.createElement('span');
    const label = entry.title || t('kanban_card_title_ph');
    name.textContent = t('calendar_due_card', {
      card: label,
      board: basename(entry.boardPath).replace(/\.kanban$/i, ''),
    });
    btn.append(icon, name);
    btn.title = entry.column;
    btn.addEventListener('click', () => openFile(entry.boardPath));
    list.appendChild(btn);
  }
  for (const path of files) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'calendar-file';
    const icon = document.createElement('i');
    icon.className = 'bi bi-file-earmark-text';
    const name = document.createElement('span');
    name.textContent = path;
    btn.append(icon, name);
    btn.addEventListener('click', () => openFile(path));
    list.appendChild(btn);
  }
}

(function setupCalendar() {
  const btn = $('#calendar-btn');
  if (btn)
    btn.addEventListener('click', () =>
      openSpecialTab('calendar', { refresh: true }),
    );
  const prev = $('#calendar-prev');
  const next = $('#calendar-next');
  const today = $('#calendar-today');
  const shift = (delta) => {
    let m = calendarState.month + delta;
    let y = calendarState.year;
    if (m < 0) {
      m = 11;
      y--;
    } else if (m > 11) {
      m = 0;
      y++;
    }
    calendarState.month = m;
    calendarState.year = y;
    calendarState.selected = null;
    renderCalendar();
  };
  if (prev) prev.addEventListener('click', () => shift(-1));
  if (next) next.addEventListener('click', () => shift(1));
  if (today)
    today.addEventListener('click', () => {
      const now = new Date();
      calendarState.year = now.getFullYear();
      calendarState.month = now.getMonth();
      calendarState.selected = WOUtil.formatDailyDate(now);
      renderCalendar();
    });
})();

/* ---------- flash ---------- */

let flashTimer;
function flash(msg) {
  let el = $('#flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    el.className = 'flash';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

/* ---------- loading overlay ---------- */

// Reference-counted so overlapping async operations don't hide the spinner
// prematurely. S3-backed storage adds noticeable latency, so we surface a
// spinner for file opens, uploads and imports to avoid confusing the user.
let loadingCount = 0;
function showLoading(msg) {
  loadingCount += 1;
  let el = $('#loading-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading-overlay';
    el.className = 'loading-overlay';
    el.innerHTML =
      '<div class="loading-box"><div class="spinner"></div><div class="loading-text"></div></div>';
    document.body.appendChild(el);
  }
  el.querySelector('.loading-text').textContent = msg || t('loading');
  el.hidden = false;
}
function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount > 0) return;
  const el = $('#loading-overlay');
  if (el) el.hidden = true;
}

/* ---------- determinate progress (export / large delete) ---------- */

// A separate overlay from the spinner so long operations (exporting or deleting
// a large folder) show a real bar with counts instead of a spinner the user
// stares at for minutes. Call showProgress(label), then updateProgress(done,
// total, sub) as work proceeds, then hideProgress() when finished.
function showProgress(label) {
  let el = $('#progress-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'progress-overlay';
    el.className = 'loading-overlay';
    el.innerHTML =
      '<div class="loading-box progress-box">' +
      '<div class="loading-text"></div>' +
      '<div class="progress-track indeterminate"><i></i></div>' +
      '<div class="progress-sub"></div></div>';
    document.body.appendChild(el);
  }
  el.querySelector('.loading-text').textContent = label || t('loading');
  el.querySelector('.progress-sub').textContent = '';
  const track = el.querySelector('.progress-track');
  track.classList.add('indeterminate');
  track.querySelector('i').style.width = '';
  el.hidden = false;
}

function updateProgress(done, total, sub) {
  const el = $('#progress-overlay');
  if (!el) return;
  const track = el.querySelector('.progress-track');
  const bar = track.querySelector('i');
  if (total && total > 0) {
    track.classList.remove('indeterminate');
    const pct = Math.min(100, Math.round((done / total) * 100));
    bar.style.width = pct + '%';
  } else {
    track.classList.add('indeterminate');
  }
  el.querySelector('.progress-sub').textContent = sub || '';
}

function hideProgress() {
  const el = $('#progress-overlay');
  if (el) el.hidden = true;
}

/* ---------- init ---------- */

setSelectedDir('');
// Ensure the vault key is available before anything tries to read encrypted
// files. On a fresh tab this re-derives it from the password; if the user
// dismisses the prompt they are redirected to login.
ensureVaultKey()
  .then(() => loadTree())
  // Reconcile UI prefs + load reading positions from the vault before restoring
  // tabs, so a reopened epub/pdf can jump to where it was left off.
  .then(() => syncSettingsFromVault())
  .then(() => initChat())
  .then(() => restoreTabs())
  .then(() => {
    // Warm the content index in the background once the UI is up, so the first
    // search returns content matches immediately instead of waiting on a cold,
    // full-vault index build. Best effort — failures are handled at search time.
    const warm = () => buildSearchIndex().catch(() => {});
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(warm, { timeout: 3000 });
    } else {
      setTimeout(warm, 1200);
    }
  })
  .catch((e) => console.error(e));
handleCheckoutReturn().catch((e) => console.error(e));

/**
 * After returning from Stripe Checkout the URL carries ?checkout=success&
 * session_id=... We sync the account from that session (no webhooks), clean the
 * URL, then open the dashboard so the user sees their new plan.
 */
async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get('checkout');
  if (!checkout) return;
  const sessionId = params.get('session_id');

  // Strip the billing params from the URL without reloading.
  params.delete('checkout');
  params.delete('session_id');
  const clean =
    window.location.pathname +
    (params.toString() ? '?' + params.toString() : '');
  window.history.replaceState({}, '', clean);

  if (checkout === 'success' && sessionId) {
    try {
      await api('POST', '/api/billing/sync', { sessionId });
    } catch (e) {
      /* best-effort; dashboard will still reflect server state */
    }
    flash(t('checkout_success'));
  } else if (checkout === 'cancel') {
    flash(t('checkout_canceled'));
  }
  openDashboard();
}

/* ---------- chat (end-to-end encrypted) ---------- */

// Build the dependency bundle handed to the chat modules so they never reach
// into app.js globals directly.
function chatDeps() {
  return {
    api,
    t,
    username: (document.body.dataset.username || '').toLowerCase(),
    getVaultKey: ensureVaultKey,
    saveAttachment: saveChatAttachment,
    attachmentUrl: (p) => attachmentBlobUrl(p),
    getNotifPref: chatNotifPref,
    setNotifPref: setChatNotifPref,
    getSoundPref: chatSoundPref,
    setSoundPref: setChatSoundPref,
    activePartner: currentChatPartner,
    openChat,
    openFile: (p) => openFile(p),
    pickVaultFile,
    pickVaultFolder,
    importVaultFile: importChatFile,
    importVaultFolder: importChatFolder,
    onNewConversation,
    pickWeblinksCsv: pickWeblinksCsvAttachment,
    importWeblinks: (text) =>
      importWeblinksFromText(text, { ensureLoaded: true }),
    removeVaultPath: (p) =>
      api('DELETE', '/api/entry?path=' + encodeURIComponent(p)),
    refreshTree: () => loadTree().catch(() => {}),
    confirm: (message) =>
      uiConfirm(t('chat_confirm_title'), {
        message,
        okText: t('delete'),
        cancelText: t('cancel'),
        danger: true,
      }),
    flash,
  };
}

let chatInitPromise = null;
// Bootstrap the chat identity + socket exactly once; callers await readiness.
async function ensureChatReady() {
  if (!CHAT_ENABLED) throw new Error(t('chat_disabled'));
  if (window.WOChat.isReady()) return;
  if (!chatInitPromise) chatInitPromise = window.WOChat.init(chatDeps());
  await chatInitPromise;
}

// Called during app boot: connect in the background so incoming messages +
// notifications work even before the user opens a conversation. Best-effort.
async function initChat() {
  if (!CHAT_ENABLED) return;
  try {
    await ensureChatReady();
  } catch (e) {
    console.warn('chat init failed', e);
  }
  const toggle = document.getElementById('chat-notifications');
  if (toggle) toggle.checked = window.WOChat.getNotificationsEnabled();
  const sound = document.getElementById('chat-sound');
  if (sound) sound.checked = window.WOChat.getSoundEnabled();
}

/** Read/write the (cross-device) "browser notifications" preference. */
function chatNotifPref() {
  return !!getPref('chatNotifications');
}
function setChatNotifPref(v) {
  persistPref('chatNotifications', !!v);
}

/** Read/write the (cross-device) "message sound" preference. Defaults on, so an
 *  unset pref reads as enabled; only an explicit `false` turns it off. */
function chatSoundPref() {
  return getPref('chatSound') !== false;
}
function setChatSoundPref(v) {
  persistPref('chatSound', !!v);
}

// Open the chat launcher: existing conversations to reopen with one click, plus
// a field to start a new chat by username. Mirrors how the Web links button
// opens its manager directly instead of forcing the user to hunt in the tree.
async function createChatWith() {
  if (!CHAT_ENABLED) return;
  let partners = [];
  try {
    partners = await listChatPartners();
  } catch {
    partners = [];
  }
  openLauncher({
    title: t('chat_launcher_title'),
    newGroup: t('chat_launcher_new_group'),
    newPlaceholder: t('chat_launcher_search'),
    startLabel: t('chat_launcher_start'),
    onStart: (value) => startChatWith(value),
    existingGroup: t('chat_launcher_existing_group'),
    emptyText: t('chat_launcher_empty'),
    items: partners.map((p) => ({ label: '@' + p, value: p })),
    onOpen: (p) => openChat(p),
  });
}

// The usernames the current user already has a conversation file for. Derived
// from the vault (chats/<partner>/<partner>.chat); there is no server-side
// contact list, so existing chats are the only privacy-safe suggestions.
async function listChatPartners() {
  const list = (await api('GET', '/api/files')) || [];
  return WOUtil.chatPartnersFromPaths(list.map((e) => e && e.path));
}

// Start (or focus) a conversation with a specific user: validate the username,
// confirm they exist + have chat set up, create the folder + file, then open it.
// Returns true when the chat was opened, false otherwise.
async function startChatWith(raw) {
  if (!CHAT_ENABLED) return false;
  const partner = WOUtil.sanitizeChatUsername(raw);
  if (!partner) {
    await uiAlert(t('chat_new_title'), { message: t('chat_err_bad_username') });
    return false;
  }
  if (partner === (document.body.dataset.username || '').toLowerCase()) {
    await uiAlert(t('chat_new_title'), { message: t('chat_err_self') });
    return false;
  }
  showLoading(t('chat_starting'));
  try {
    await ensureChatReady();
    await window.WOChat.verifyPartner(partner);
    await api('POST', '/api/folder', {
      path: WOUtil.chatDir(partner),
    }).catch(() => {});
    const chatPath = WOUtil.chatFilePath(partner);
    await ensureChatFile(chatPath);
    hideLoading();
    await loadTree().catch(() => {});
    await openFile(chatPath);
    return true;
  } catch (e) {
    hideLoading();
    await uiAlert(t('chat_new_title'), {
      message: e.message || t('chat_err_no_user'),
    });
    return false;
  }
}

// Ensure the conversation file exists (create an empty encrypted one if not).
async function ensureChatFile(path) {
  try {
    await api('GET', '/api/file?path=' + encodeURIComponent(path));
    return;
  } catch {
    /* not created yet */
  }
  const content = await encryptContent('');
  await api('PUT', '/api/file', { path, content });
}

// Open (or focus) the conversation tab for a partner.
async function openChat(partner) {
  const p = WOUtil.sanitizeChatUsername(partner);
  if (!p) return;
  await openFile(WOUtil.chatFilePath(p));
}

// Encrypt + store attachment bytes into the user's own vault (chat-images).
async function saveChatAttachment(path, bytes, mime) {
  const folder = dirname(path);
  const name = basename(path);
  const file = new File([bytes], name, {
    type: mime || 'application/octet-stream',
  });
  const fd = new FormData();
  fd.append('file', await encryptFileBlob(file), name);
  fd.append('folder', folder);
  await api('POST', '/api/upload', fd, true);
}

// Let the user pick an existing vault file to send. Returns { name, mime, bytes }
// (decrypted) or null if cancelled.
async function pickVaultFile() {
  const list = (await api('GET', '/api/files')) || [];
  const files = list
    .map((e) => e.path)
    .filter((p) => p && !p.startsWith(RESERVED_DIR + '/'))
    .sort();
  if (!files.length) {
    await uiAlert(t('chat_attach_vault'), { message: t('chat_no_vault_files') });
    return null;
  }
  const path = await pickFromList(t('chat_pick_vault'), files);
  if (!path) return null;
  const key = await ensureVaultKey();
  const res = await fetch(attachmentUrl(path), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(t('chat_err_attachment'));
  const cipher = new Uint8Array(await res.arrayBuffer());
  const bytes = await window.WOCrypto.decryptBytesMaybe(key, cipher);
  return { name: basename(path), mime: mimeForPath(path), bytes };
}

// Let the user pick a vault folder to send. Every file under it is fetched,
// decrypted, and packed into a single plaintext .zip (client-side, since the
// server only holds ciphertext). Returns { name, mime, bytes } or null.
async function pickVaultFolder() {
  const list = (await api('GET', '/api/files')) || [];
  // Derive the set of folders from file paths (there is no folder-listing API).
  // Reserved internal folders are hidden — you cannot send those.
  const options = WOUtil.foldersFromPaths(
    list.map((e) => e && e.path),
    RESERVED_DIR,
  );
  if (!options.length) {
    await uiAlert(t('chat_attach_folder'), {
      message: t('chat_no_vault_folders'),
    });
    return null;
  }
  const folder = await pickFromList(t('chat_pick_folder'), options);
  if (!folder) return null;

  const key = await ensureVaultKey();
  const prefix = folder + '/';
  const entries = list.filter(
    (e) => e.path === folder || e.path.startsWith(prefix),
  );
  // Keep the folder itself as the archive root (strip its parent path).
  const parent = dirname(folder);
  const strip = parent ? parent + '/' : '';
  const files = {};
  showProgress(t('chat_zipping_folder'));
  try {
    const total = entries.length;
    let done = 0;
    updateProgress(0, total, t('progress_files', { done: 0, total }));
    for (const entry of entries) {
      const res = await fetch(attachmentUrl(entry.path), {
        credentials: 'same-origin',
      });
      if (res.ok) {
        const cipher = new Uint8Array(await res.arrayBuffer());
        try {
          const rel = entry.path.startsWith(strip)
            ? entry.path.slice(strip.length)
            : entry.path;
          files[rel] = await window.WOCrypto.decryptBytesMaybe(key, cipher);
        } catch {
          /* skip files that fail to decrypt */
        }
      }
      done += 1;
      updateProgress(done, total, t('progress_files', { done, total }));
    }
    const bytes = window.WOZip.zip(files);
    return { name: basename(folder) + '.zip', mime: 'application/zip', bytes };
  } finally {
    hideProgress();
  }
}

// Called by the chat layer when a first-ever message from a partner arrives:
// refresh the file tree so the new conversation shows up immediately (no page
// reload) and flash a lightweight heads-up.
function onNewConversation(partner) {
  loadTree().catch(() => {});
  flash(t('chat_new_message', { user: partner }));
}

// Import a single file received via chat into the recipient's own vault: confirm,
// decrypt the stored attachment, then re-upload it to the vault root under its
// original name (encrypted client-side, same as any upload). `imgPath` is the
// attachment's path in the user's own vault (chat-images).
async function importChatFile(imgPath, name) {
  const fname = name || basename(imgPath) || 'file';
  const ok = await uiConfirm(t('chat_import_file_title'), {
    message: t('chat_import_file_confirm', { name: fname }),
    okText: t('chat_import_file'),
    cancelText: t('cancel'),
  });
  if (!ok) return;
  try {
    const url = await attachmentBlobUrl(imgPath);
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    if (bytes.length > MAX_UPLOAD_FILE_BYTES) {
      await uiAlert(t('import_failed_title'), {
        message: t('file_too_large', { name: fname }),
      });
      return;
    }
    const file = new File([bytes], fname);
    const fd = new FormData();
    fd.append('file', await encryptFileBlob(file), fname);
    fd.append('folder', '');
    await api('POST', '/api/upload', fd, true);
    await loadTree();
    flash(t('chat_file_imported', { name: fname }));
  } catch (e) {
    await uiAlert(t('chat_import_file_title'), {
      message: e.message || t('chat_err_attachment'),
    });
  }
}

// Import a folder received via chat (a .zip attachment) into the recipient's own
// vault: confirm, decrypt + unzip the archive in the browser, then upload every
// file through the same chunked/encrypted uploader as a normal folder import so
// the folder structure (each entry's path inside the zip) is reconstructed in
// connected storage. `imgPath` is the attachment's path in the user's vault.
async function importChatFolder(imgPath, name) {
  const ok = await uiConfirm(t('chat_import_folder_title'), {
    message: t('chat_import_folder_confirm', { name: name || 'folder' }),
    okText: t('chat_import_folder'),
    cancelText: t('cancel'),
  });
  if (!ok) return;
  let files;
  try {
    const url = await attachmentBlobUrl(imgPath);
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    files = window.WOZip.unzip(buf);
  } catch (e) {
    await uiAlert(t('chat_import_folder_title'), {
      message: e.message || t('chat_err_attachment'),
    });
    return;
  }
  if (!files.length) {
    await uiAlert(t('chat_import_folder_title'), {
      message: t('chat_folder_empty'),
    });
    return;
  }
  // Reject any single file over the per-file cap up front (the server rejects it
  // anyway) so the import does not fail partway through.
  const big = files.find((f) => f.bytes.length > MAX_UPLOAD_FILE_BYTES);
  if (big) {
    await uiAlert(t('import_failed_title'), {
      message: t('file_too_large', { name: big.path.split('/').pop() }),
    });
    return;
  }
  // Each zip entry's path becomes its relativePath, so the uploader rebuilds the
  // folder tree at the vault root (the archive's top folder is preserved).
  const entries = files.map((f) => ({
    file: new File([f.bytes], f.path.split('/').pop() || 'file'),
    relativePath: f.path,
  }));
  try {
    await window.WOUpload.start({
      entries,
      baseDir: '',
      getKey: ensureVaultKey,
      t,
      onFileComplete: refreshTreeSoon,
      onComplete: () => {
        loadTree();
        flash(t('chat_folder_imported', { n: files.length }));
      },
    });
  } catch (e) {
    await uiAlert(t('import_failed_title'), {
      message: e.message || t('import_failed_msg'),
    });
  }
}

// Generic "open existing or create new" launcher overlay. One field doubles as
// a filter over existing items and as the value for the create action, so the
// user can click a suggestion or type a new name and hit Start. Used by the
// chat and Kanban toolbar buttons so they open a chooser directly (like Web
// links) instead of forcing folder navigation.
//   opts = { title, newGroup?, newPlaceholder, startLabel, onStart(value)->bool,
//            existingGroup, emptyText, items:[{label,value}], onOpen(value) }
function openLauncher(opts) {
  const ov = document.createElement('div');
  ov.className = 'wo-picker-overlay';
  const box = document.createElement('div');
  box.className = 'wo-picker';

  const h = document.createElement('div');
  h.className = 'wo-picker-title';
  h.textContent = opts.title;
  box.appendChild(h);

  if (opts.newGroup) {
    const g = document.createElement('div');
    g.className = 'wo-picker-group';
    g.textContent = opts.newGroup;
    box.appendChild(g);
  }

  const row = document.createElement('div');
  row.className = 'wo-launcher-row';
  const input = document.createElement('input');
  input.className = 'wo-picker-search wo-launcher-input';
  input.type = 'text';
  input.placeholder = opts.newPlaceholder || '';
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'btn-primary wo-launcher-start';
  startBtn.textContent = opts.startLabel;
  row.appendChild(input);
  row.appendChild(startBtn);
  box.appendChild(row);

  const groupLabel = document.createElement('div');
  groupLabel.className = 'wo-picker-group';
  groupLabel.textContent = opts.existingGroup || '';
  box.appendChild(groupLabel);

  const listEl = document.createElement('div');
  listEl.className = 'wo-picker-list';
  box.appendChild(listEl);

  const empty = document.createElement('div');
  empty.className = 'wo-picker-empty';
  empty.textContent = opts.emptyText || '';
  box.appendChild(empty);

  const all = opts.items || [];

  function render(filter) {
    listEl.innerHTML = '';
    const f = (filter || '').toLowerCase();
    const items = all.filter((it) => it.label.toLowerCase().includes(f));
    groupLabel.hidden = all.length === 0;
    empty.hidden = items.length > 0;
    items.slice(0, 300).forEach((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wo-picker-item';
      b.textContent = it.label;
      b.addEventListener('click', () => {
        close();
        Promise.resolve(opts.onOpen(it.value)).catch(() => {});
      });
      listEl.appendChild(b);
    });
  }

  async function start() {
    const val = input.value.trim();
    startBtn.disabled = true;
    let ok = false;
    try {
      ok = await opts.onStart(val);
    } finally {
      startBtn.disabled = false;
    }
    if (ok) close();
  }

  function close() {
    if (ov.parentNode) document.body.removeChild(ov);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  startBtn.addEventListener('click', start);
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      start();
    }
  });
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close();
  });
  document.addEventListener('keydown', onKey);

  ov.appendChild(box);
  document.body.appendChild(ov);
  render('');
  setTimeout(() => input.focus(), 0);
}

// Minimal searchable list picker (used to choose a vault file). Resolves to the
// chosen string or null. Rendered above every other overlay (see style.css).
function pickFromList(title, items) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'wo-picker-overlay';
    const box = document.createElement('div');
    box.className = 'wo-picker';
    const h = document.createElement('div');
    h.className = 'wo-picker-title';
    h.textContent = title;
    const search = document.createElement('input');
    search.className = 'wo-picker-search';
    search.type = 'search';
    search.placeholder = t('chat_pick_search');
    const listEl = document.createElement('div');
    listEl.className = 'wo-picker-list';

    function render(filter) {
      listEl.innerHTML = '';
      const f = (filter || '').toLowerCase();
      items
        .filter((x) => x.toLowerCase().includes(f))
        .slice(0, 300)
        .forEach((x) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'wo-picker-item';
          b.textContent = x;
          b.addEventListener('click', () => done(x));
          listEl.appendChild(b);
        });
    }
    function done(val) {
      if (ov.parentNode) document.body.removeChild(ov);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    }
    function onKey(e) {
      if (e.key === 'Escape') done(null);
    }
    search.addEventListener('input', () => render(search.value));
    ov.addEventListener('click', (e) => {
      if (e.target === ov) done(null);
    });
    document.addEventListener('keydown', onKey);
    box.appendChild(h);
    box.appendChild(search);
    box.appendChild(listEl);
    ov.appendChild(box);
    document.body.appendChild(ov);
    render('');
    setTimeout(() => search.focus(), 0);
  });
}

// --- chat block list (settings > Chat) ------------------------------------

// Load + render the current user's blocklist into the Chat settings pane.
async function loadChatBlocks() {
  const list = document.getElementById('chat-block-list');
  if (!list) return;
  try {
    await ensureChatReady();
    renderChatBlocks(await window.WOChat.listBlocks());
  } catch {
    renderChatBlocks([]);
  }
}

function renderChatBlocks(users) {
  const list = document.getElementById('chat-block-list');
  const empty = document.getElementById('chat-block-empty');
  if (!list) return;
  list.innerHTML = '';
  if (empty) empty.hidden = users.length > 0;
  for (const name of users) {
    const li = document.createElement('li');
    li.className = 'chat-block-item';
    const label = document.createElement('span');
    label.textContent = '@' + name;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost';
    btn.textContent = t('chat_unblock');
    btn.addEventListener('click', () => unblockChatUser(name));
    li.appendChild(label);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function blockChatUser() {
  const input = document.getElementById('chat-block-input');
  if (!input) return;
  const name = WOUtil.sanitizeChatUsername(input.value);
  if (!name) {
    await uiAlert(t('chat_block_group'), { message: t('chat_err_bad_username') });
    return;
  }
  try {
    await ensureChatReady();
    await window.WOChat.blockUser(name);
    input.value = '';
    renderChatBlocks(await window.WOChat.listBlocks());
  } catch (e) {
    await uiAlert(t('chat_block_group'), {
      message: e.message || t('chat_err_send'),
    });
  }
}

async function unblockChatUser(name) {
  try {
    await ensureChatReady();
    await window.WOChat.unblockUser(name);
    renderChatBlocks(await window.WOChat.listBlocks());
  } catch (e) {
    await uiAlert(t('chat_block_group'), {
      message: e.message || t('chat_err_send'),
    });
  }
}

// Wire the Chat create button + the notifications toggle (both present only
// when chat is enabled server-side).
(function wireChat() {
  const btn = document.getElementById('new-chat');
  if (btn) btn.addEventListener('click', createChatWith);
  const blockAdd = document.getElementById('chat-block-add');
  if (blockAdd) blockAdd.addEventListener('click', blockChatUser);
  const blockInput = document.getElementById('chat-block-input');
  if (blockInput) {
    blockInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        blockChatUser();
      }
    });
  }
  const toggle = document.getElementById('chat-notifications');
  if (toggle) {
    toggle.addEventListener('change', async () => {
      const want = toggle.checked;
      try {
        await ensureChatReady();
      } catch {
        /* still record the preference below */
      }
      const on = await window.WOChat.setNotificationsEnabled(want);
      toggle.checked = !!on;
      if (want && !on) {
        // The browser blocked notifications (permission denied at the OS/site
        // level). Use a modal, not a toast — the user needs time to read it and
        // it explains how to fix it in browser settings.
        await uiAlert(t('chat_notif_group'), {
          message: t('chat_notif_blocked_help'),
        });
      }
    });
  }
  const sound = document.getElementById('chat-sound');
  if (sound) {
    sound.addEventListener('change', async () => {
      try {
        await ensureChatReady();
      } catch {
        /* still record the preference below */
      }
      window.WOChat.setSoundEnabled(sound.checked);
    });
  }
})();
