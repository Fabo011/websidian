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

// Human-readable byte size, e.g. 360 MB / 1.4 GB.
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 10 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

// Validate a selection of { path, size } items against the upload limits.
// Returns a ready-to-show error message, or '' when the selection is fine. The
// {maxImportTotal}/{maxUploadSize}/{maxImportFiles} placeholders are filled by
// i18n automatically.
function uploadLimitError(items) {
  const totalBytes = items.reduce((n, it) => n + it.size, 0);
  if (totalBytes > MAX_IMPORT_TOTAL_BYTES) {
    return t('import_total_too_large', { total: fmtSize(totalBytes) });
  }
  if (items.length > MAX_IMPORT_FILES) {
    return t('too_many_files', { count: items.length.toLocaleString() });
  }
  const big = items.find((it) => it.size > MAX_UPLOAD_FILE_BYTES);
  if (big) {
    return t('file_too_large', { name: big.path.split('/').pop() });
  }
  return '';
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
  const container = $('#tree');
  container.innerHTML = '';
  container.appendChild(buildList(tree));
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
  // Keep an open file in sync if it (or its folder) was moved.
  if (state.current && state.current.path) {
    if (state.current.path === fromPath) {
      state.current.path = to;
    } else if (state.current.path.startsWith(fromPath + '/')) {
      state.current.path = to + state.current.path.slice(fromPath.length);
    }
  }
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
  if (ext === 'md' || ext === 'markdown') return 'bi-file-earmark-text';
  if (ext === 'txt') return 'bi-file-earmark';
  if (ext === 'docx') return 'bi-file-earmark-word';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods')
    return 'bi-file-earmark-spreadsheet';
  if (ext === 'odt') return 'bi-file-earmark-richtext';
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
    if (state.current && state.current.path === node.path) {
      state.current.path = to;
      $('#current-path').textContent = to;
    }
    await loadTree();
  } else if (action === 'new-note') {
    await createNoteIn(node.path);
  } else if (action === 'new-file') {
    await createFileIn(node.path);
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
      if (state.current && state.current.path.startsWith(node.path)) {
        showWelcome();
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
  hideAllViews();
  state.current = null;
  $('#welcome').hidden = false;
}

async function openFile(path) {
  const ext = extOf(path);
  showLoading(t('opening_file'));
  try {
    if (ext === 'excalidraw') {
      return await openExcalidraw(path);
    }
    if (TEXT_EXTS.includes(ext)) {
      return await openEditor(path, ext);
    }
    return openViewer(path, ext);
  } catch (err) {
    await uiAlert(t('open_failed_title'), {
      message: err.message || t('open_failed_msg'),
    });
  } finally {
    hideLoading();
  }
}

/* ---------- text editor + preview ---------- */

async function openEditor(path, ext) {
  const data = await api('GET', '/api/file?path=' + encodeURIComponent(path));
  const content = await decryptContent(data.content);
  hideAllViews();
  state.current = { path, ext, version: data.version };
  state.dirty = false;
  $('#editor-view').hidden = false;
  renderBreadcrumb($('#current-path'), path);
  const editor = $('#editor');
  editor.value = content;
  const isMarkdown = ext === 'md' || ext === 'markdown';
  const isCode = CODE_EXTS.includes(ext);
  // Markdown and code/config files offer a reading view (rendered preview or
  // syntax-highlighted code); plain .txt has no preview.
  $('#toggle-preview').style.display = isMarkdown || isCode ? '' : 'none';
  // Every file that has a reading view (markdown or code/config) opens in view
  // mode by default — the user browses the vault read-only and clicks "Edit" to
  // make changes. Plain text without a preview opens straight in edit mode.
  if (isMarkdown || isCode) {
    setViewMode(true);
  } else {
    setViewMode(false);
    editor.focus();
  }
}

$('#editor').addEventListener('input', () => {
  state.dirty = true;
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

async function saveCurrent() {
  if (!state.current) return;
  const payload = {
    path: state.current.path,
    content: await encryptContent($('#editor').value),
    baseVersion: state.current.version,
  };
  let result;
  try {
    result = await api('PUT', '/api/file', payload);
  } catch (e) {
    if (e.status === 409) {
      const overwrite = await uiConfirm(t('conflict_file_title'), {
        message: t('conflict_file_msg'),
        okText: t('overwrite'),
        cancelText: t('reload_latest'),
      });
      if (overwrite) {
        delete payload.baseVersion;
        result = await api('PUT', '/api/file', payload);
      } else {
        await openFile(state.current.path);
        flash(t('reloaded_latest'));
        return;
      }
    } else {
      throw e;
    }
  }
  if (result && result.version) state.current.version = result.version;
  state.dirty = false;
  invalidateSearchIndex();
  invalidateGraphCache(); // note content (and thus its links) changed
  flash(t('saved'));
}
$('#save-btn').addEventListener('click', saveCurrent);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (state.current && state.current.ext !== 'excalidraw') saveCurrent();
    else if (state.excalidraw) saveExcalidraw();
  }
});

/* ---------- attachment viewer ---------- */

function openViewer(path, ext) {
  hideAllViews();
  state.current = { path, ext };
  $('#viewer-view').hidden = false;
  renderBreadcrumb($('#viewer-path'), path);
  const body = $('#viewer-body');
  body.innerHTML = '';
  const downloadLink = $('#viewer-download');
  downloadLink.removeAttribute('href');

  if (IMAGE_EXTS.includes(ext)) {
    const img = document.createElement('img');
    img.alt = basename(path);
    body.appendChild(img);
    setViewerSources(path, [img], downloadLink);
  } else if (ext === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'pdf-frame';
    body.appendChild(frame);
    setViewerSources(path, [frame], downloadLink);
  } else if (OFFICE_EXTS.includes(ext)) {
    renderOffice(path, ext, body);
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('no_preview');
    body.appendChild(p);
  }
}

/**
 * Decrypt an attachment once and point the given preview elements (and the
 * download link) at the resulting blob: URL.
 */
async function setViewerSources(path, elements, downloadLink) {
  try {
    const url = await attachmentBlobUrl(path);
    if (!state.current || state.current.path !== path) return;
    for (const el of elements) el.src = url;
    if (downloadLink) {
      downloadLink.href = url;
      downloadLink.setAttribute('download', basename(path));
    }
  } catch (e) {
    /* leave the viewer empty if decryption fails */
  }
}

/* ---------- office document viewer (Word / Excel / OpenDocument) ---------- */

let officeLoading = null;
function ensureOffice() {
  if (window.OfficeViewer) return Promise.resolve();
  if (officeLoading) return officeLoading;
  officeLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/public/js/office-bundle.js';
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
    // Guard against the user navigating away while loading.
    if (!state.current || state.current.path !== path) return;
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

/* ---------- excalidraw ---------- */

let excalidrawLoading = null;
function ensureExcalidraw() {
  if (window.ExcalidrawEditor) return Promise.resolve();
  if (excalidrawLoading) return excalidrawLoading;
  excalidrawLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/public/js/excalidraw-bundle.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Excalidraw editor.'));
    document.body.appendChild(s);
  });
  return excalidrawLoading;
}

async function openExcalidraw(path) {
  hideAllViews();
  $('#excalidraw-view').hidden = false;
  renderBreadcrumb($('#excalidraw-path'), path);
  state.current = { path, ext: 'excalidraw', version: null };
  const root = $('#excalidraw-root');
  root.innerHTML = t('loading_editor');
  let initial = null;
  try {
    const data = await api('GET', '/api/file?path=' + encodeURIComponent(path));
    state.current.version = data.version;
    const content = await decryptContent(data.content);
    initial = content ? JSON.parse(content) : null;
  } catch (e) {
    initial = null;
  }
  try {
    await ensureExcalidraw();
    root.innerHTML = '';
    state.excalidraw = window.ExcalidrawEditor.mount(root, initial);
  } catch (e) {
    root.textContent = e.message;
  }
}

async function saveExcalidraw() {
  if (!state.excalidraw || !state.current) return;
  const json = window.ExcalidrawEditor.serialize(state.excalidraw);
  const payload = {
    path: state.current.path,
    content: await encryptContent(json),
    baseVersion: state.current.version,
  };
  let result;
  try {
    result = await api('PUT', '/api/file', payload);
  } catch (e) {
    if (e.status === 409) {
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
  if (result && result.version) state.current.version = result.version;
  flash(t('saved'));
}
$('#excalidraw-save').addEventListener('click', saveExcalidraw);

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

async function createFolderIn(targetDir) {
  const name = await uiPrompt(t('prompt_new_folder_title'), '', {
    title: t('prompt_new_folder_title'),
    placeholder: t('prompt_new_folder_ph'),
  });
  if (!name) return;
  const path = targetDir ? targetDir + '/' + name : name;
  await api('POST', '/api/folder', { path });
  expandAncestors(path);
  await loadTree();
}

$('#new-note').addEventListener('click', () => createNoteIn(state.selectedDir));
$('#new-file').addEventListener('click', () => createFileIn(state.selectedDir));
$('#new-folder').addEventListener('click', () => createFolderIn(state.selectedDir));

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
    const list = await api('GET', '/api/files');
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
    const ok = await uiConfirm(t('trash_empty'), {
      message: t('trash_empty_confirm'),
      okText: t('trash_empty'),
      danger: true,
    });
    if (!ok) return;
    closeTrashModal();
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

async function runSearch(q) {
  const box = $('#search-results');
  if (!q.trim()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  if (searching) return;
  searching = true;
  const btn = $('#search-btn');
  if (btn) btn.disabled = true;
  // Show a spinner immediately: the server name search plus building/syncing the
  // local content index can take a moment on a large vault.
  box.innerHTML =
    '<div class="search-loading"><span class="search-spinner"></span>' +
    t('searching') +
    '</div>';
  box.hidden = false;
  try {
    await runSearchInner(q, box);
  } finally {
    searching = false;
    if (btn) btn.disabled = false;
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

/** Render the results dropdown. `indexing` appends a "searching contents" note. */
function renderResults(box, hits, indexing) {
  box.innerHTML = '';
  if (!hits.length && !indexing) {
    box.innerHTML = '<div class="search-empty">' + t('no_matches') + '</div>';
    box.hidden = false;
    return;
  }
  for (const hit of hits) {
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
      box.hidden = true;
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
  box.hidden = false;
}

async function runSearchInner(q, box) {
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
    mergeContentHits(hits, q);
  } catch (e) {
    /* content search unavailable; keep name hits only */
  }
  renderResults(box, hits, false);
}

$('#search-btn').addEventListener('click', () =>
  runSearch($('#search-input').value),
);
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runSearch(e.target.value);
  }
});
// Clearing the field (native "x" or empty) hides the results without searching.
$('#search-input').addEventListener('input', (e) => {
  if (!e.target.value.trim()) {
    const box = $('#search-results');
    box.hidden = true;
    box.innerHTML = '';
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) $('#search-results').hidden = true;
});

/* ---------- chrome: theme, sidebar, logout ---------- */

$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('wo-theme', next);
  } catch (e) {
    /* ignore */
  }
});

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
  loadAccount();
}

function closeDashboard() {
  $('#dashboard-overlay').hidden = true;
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
  } catch (e) {
    text.textContent = t('usage_error');
  }
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
      };
    } catch {
      _billingConfig = { enabled: false, ready: false, planGb: 3, planPrice: '' };
    }
  }
  return _billingConfig;
}

async function billingEnabled() {
  return (await billingConfig()).enabled;
}

async function renderPlan(info) {
  const section = $('#plan-section');
  const warning = $('#plan-warning');
  const planValue = $('#plan-value');
  const validRow = $('#plan-valid-row');
  const validVal = $('#plan-valid');
  const privilegedHint = $('#plan-privileged-hint');
  const upgrade = $('#plan-upgrade');
  const manageBtn = $('#manage-billing-btn');
  const unavailable = $('#billing-unavailable');

  // When billing is switched off (self-hosting) there are no plans to manage:
  // hide the whole section and just show storage usage elsewhere.
  const cfg = await billingConfig();
  if (section) section.hidden = !cfg.enabled;
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

  planValue.textContent = planLabel(info.effectiveTier || 'free');

  // Privileged accounts: complimentary storage, no billing whatsoever. Hide the
  // entire plan/billing section (no plan, no upgrade, no manage-subscription).
  if (info.privileged) {
    if (section) section.hidden = true;
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
const _openFile = openFile;
openFile = async function (path) {
  await _openFile(path);
  maybeCloseSidebar();
};

/* ---------- web link manager ---------- */

const WEBLINKS_DIR = 'weblinks';
const WEBLINKS_CSV = 'weblinks/weblinks.csv';
// Native CSV header. It is a column-name prefix of Linky's export format
// (linkname,linkdescription,link,category,…), so files written here can be
// imported by Linky and Linky exports can be imported here.
const WEBLINKS_HEADER = ['linkname', 'linkdescription', 'link', 'category'];

const weblinksState = {
  links: [], // { name, description, url, category }
  version: null, // last loaded file version, for concurrent-edit detection
  editIndex: null, // index being edited, or null when adding
  filter: '',
};

/** Parse RFC 4180-style CSV text into an array of string-cell rows. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  // Flush the trailing cell/row unless the file ended on a clean newline.
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Quote a single CSV cell when it contains a comma, quote or newline. */
function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Serialize the current links into Linky-compatible CSV text. */
function serializeWeblinks(links) {
  const lines = [WEBLINKS_HEADER.join(',')];
  for (const l of links) {
    lines.push(
      [l.name, l.description, l.url, l.category].map(csvCell).join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Turn CSV text into link records. Maps by header name so both the native
 * format and a full Linky export (extra columns) are understood. Rows without
 * a usable http(s) URL are skipped.
 */
function csvToLinks(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const iName = idx('linkname');
  const iDesc = idx('linkdescription');
  const iUrl = idx('link');
  const iCat = idx('category');
  // If the first row is not a recognizable header, treat every row as data
  // with a simple name,url[,description[,category]] layout.
  const hasHeader = iUrl !== -1 || iName !== -1;
  const out = [];
  const start = hasHeader ? 1 : 0;
  for (let r = start; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.length || cells.every((c) => c.trim() === '')) continue;
    const get = (i, fallback) =>
      (i !== -1 && i < cells.length ? cells[i] : cells[fallback] || '').trim();
    const url = sanitizeLinkUrl(get(iUrl, 1));
    if (!url) continue;
    out.push({
      name: get(iName, 0) || url,
      description: get(iDesc, 2),
      url,
      category: get(iCat, 3),
    });
  }
  return out;
}

/** Accept only http(s) URLs; reject javascript:, data:, etc. */
function sanitizeLinkUrl(value) {
  const s = (value || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.href;
    }
  } catch {
    // Allow a bare host like "example.com" by retrying with https://.
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) {
      return sanitizeLinkUrl('https://' + s);
    }
  }
  return '';
}

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
 * Open the web link manager. On first use this creates the `weblinks` folder
 * and an empty `weblinks.csv` inside it, then loads and renders the links.
 */
async function openWebLinks() {
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
    hideAllViews();
    state.current = null;
    $('#weblinks-view').hidden = false;
    maybeCloseSidebar();
    renderWeblinks();
  } catch (err) {
    await uiAlert(t('open_failed_title'), {
      message: err.message || t('weblinks_load_failed'),
    });
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
      return [link.name, link.url, link.description, link.category]
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
  card.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'weblink-actions';

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

function openWeblinkModal(index) {
  weblinksState.editIndex = typeof index === 'number' ? index : null;
  const editing = weblinksState.editIndex !== null;
  const link = editing ? weblinksState.links[weblinksState.editIndex] : null;
  $('#weblink-modal-title').querySelector('span').textContent = editing
    ? t('weblinks_edit')
    : t('weblinks_add');
  $('#weblink-url').value = link ? link.url : '';
  $('#weblink-name').value = link ? link.name : '';
  $('#weblink-category').value = link ? link.category : '';
  $('#weblink-description').value = link ? link.description : '';
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
  } catch (err) {
    await uiAlert(t('open_failed_title'), {
      message: err.message || t('weblinks_load_failed'),
    });
  } finally {
    hideLoading();
  }
}

async function importWeblinksCsv(file) {
  showLoading(t('importing'));
  try {
    const text = await file.text();
    const incoming = csvToLinks(text);
    if (!incoming.length) {
      await uiAlert(t('import_failed_title'), {
        message: t('weblinks_import_failed'),
      });
      return;
    }
    // Merge, de-duplicating by URL (existing entries win).
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
  } catch (err) {
    await uiAlert(t('import_failed_title'), {
      message: err.message || t('weblinks_import_failed'),
    });
  } finally {
    hideLoading();
  }
}

(function setupWeblinks() {
  $('#weblinks-btn').addEventListener('click', openWebLinks);
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

/** Reveal the graph view and (re)draw the current `graphState` layout. */
function showGraphView(resim) {
  const n = graphState.nodes.length;
  graphState.active = null;
  hideAllViews();
  state.current = null;
  $('#graph-view').hidden = false;
  $('#graph-empty').hidden = n > 0;
  $('#graph-hint').hidden = n === 0;
  $('#graph-tooltip').hidden = true;
  maybeCloseSidebar();
  // Defer sizing until the view is laid out so clientWidth/Height are correct.
  requestAnimationFrame(() => {
    resizeGraphCanvas();
    if (resim) startGraphSim(1);
    else requestGraphDraw();
  });
}

async function openGraph(force) {
  const ttl = graphCacheTtl();
  const fresh =
    !force && graphBuiltAt && graphState.nodes.length &&
    Date.now() - graphBuiltAt < ttl;
  if (fresh) {
    // Reuse the cached layout (keeps the user's pan/zoom too).
    showGraphView(false);
    return;
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
    showGraphView(true);
  } catch (err) {
    await uiAlert(t('open_failed_title'), { message: err.message || t('graph_failed') });
  } finally {
    hideLoading();
  }
}

(function setupGraph() {
  const btn = $('#graph-btn');
  if (btn) btn.addEventListener('click', () => openGraph());
  const canvas = $('#graph-canvas');
  if (!canvas) return;

  $('#graph-zoom-in').addEventListener('click', () => {
    graphZoomAround(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.25);
  });
  $('#graph-zoom-out').addEventListener('click', () => {
    graphZoomAround(canvas.clientWidth / 2, canvas.clientHeight / 2, 0.8);
  });
  $('#graph-refresh').addEventListener('click', () => openGraph(true));

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
