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

async function api(method, url, body, isForm) {
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
  const timer = setTimeout(
    () => ctrl.abort(),
    isForm ? UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS,
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
  // rebuilds it from the current files.
  invalidateSearchIndex();
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
    await api('POST', '/api/rename', { from: fromPath, to });
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
  const limitErr = uploadLimitError(
    entries.map((en) => ({ path: en.path, size: en.file.size })),
  );
  if (limitErr) {
    await uiAlert(t('upload_failed_title'), { message: limitErr });
    return;
  }
  const hasFolders = entries.some((en) => en.path.includes('/'));
  showLoading(t('uploading'));
  try {
    // Encrypt every file's bytes in the browser before upload so the server
    // only ever stores ciphertext. Names/paths stay plaintext.
    if (hasFolders) {
      // Preserve the folder structure via the import endpoint.
      const fd = new FormData();
      const paths = [];
      for (const en of entries) {
        paths.push(en.path);
        const blob = await encryptFileBlob(en.file);
        fd.append('files', blob, en.path.split('/').pop());
      }
      fd.append('paths', JSON.stringify(paths));
      fd.append('base', targetDir);
      const res = await api('POST', '/api/import', fd, true);
      flash(t('imported_n', { n: (res && res.written) || 0 }));
    } else {
      for (const en of entries) {
        const fd = new FormData();
        const blob = await encryptFileBlob(en.file);
        fd.append('file', blob, en.file.name);
        fd.append('folder', targetDir);
        await api('POST', '/api/upload', fd, true);
      }
      flash(t('uploaded_n', { n: entries.length }));
    }
    expandAncestors(targetDir);
    await loadTree();
  } catch (err) {
    await uiAlert(t('upload_failed_title'), {
      message: err.message || t('upload_failed_msg'),
    });
  } finally {
    hideLoading();
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
    await api('POST', '/api/rename', { from: node.path, to });
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
  } else if (action === 'delete') {
    const ok = await uiConfirm(t('delete'), {
      message: t('confirm_delete_msg', { name: node.name }),
      okText: t('delete'),
      danger: true,
    });
    if (!ok) return;
    // Deleting a folder can remove many files (slow on S3), so show the spinner
    // and surface any failure instead of silently leaving a stale tree.
    showLoading(t('deleting'));
    try {
      await api('DELETE', '/api/entry?path=' + encodeURIComponent(node.path));
      if (state.current && state.current.path.startsWith(node.path)) {
        showWelcome();
      }
      await loadTree();
      hideLoading();
    } catch (err) {
      hideLoading();
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
  } else if (action === 'image') {
    wrapSelection('![[', ']]', 'image.png');
  } else if (action === 'wikilink') {
    wrapSelection('[[', ']]', 'The System');
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
  showLoading(t('importing'));
  try {
    // Build a flat list of {path, bytes}. Any .zip is expanded in the browser
    // (the server can't read encrypted contents), and every entry is encrypted
    // before upload.
    const items = [];
    for (const file of files) {
      const rel = file.webkitRelativePath || file.name;
      if (rel.toLowerCase().endsWith('.zip')) {
        const buf = new Uint8Array(await file.arrayBuffer());
        for (const entry of window.WOZip.unzip(buf)) {
          items.push({ path: entry.path, bytes: entry.bytes });
        }
      } else {
        items.push({ path: rel, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
    }

    // Reject an over-limit selection before doing the expensive encryption and
    // upload, so the user finds out immediately instead of after a long wait.
    const limitErr = uploadLimitError(
      items.map((it) => ({ path: it.path, size: it.bytes.length })),
    );
    if (limitErr) {
      hideLoading();
      await uiAlert(t('import_failed_title'), { message: limitErr });
      return;
    }

    const key = await ensureVaultKey();
    const fd = new FormData();
    const paths = [];
    for (const item of items) {
      paths.push(item.path);
      const ct = await window.WOCrypto.encryptBytes(key, item.bytes);
      fd.append(
        'files',
        new Blob([ct], { type: 'application/octet-stream' }),
        item.path.split('/').pop(),
      );
    }
    fd.append('paths', JSON.stringify(paths));
    fd.append('base', state.selectedDir);
    const res = await api('POST', '/api/import', fd, true);
    await loadTree();
    flash(t('imported_n', { n: res.written || 0 }));
    hideLoading();
  } catch (err) {
    // Clear the spinner BEFORE the alert. The loading overlay stacks on top of
    // the modal, so leaving it up blocks the OK button and the alert promise
    // never resolves, hanging the spinner forever.
    hideLoading();
    await uiAlert(t('import_failed_title'), {
      message: err.message || t('import_failed_msg'),
    });
  }
}

(function setupImport() {
  const folderInput = $('#import-input');
  const zipInput = $('#import-zip-input');
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
  zipInput.addEventListener('change', onChange);

  $('#import-btn').addEventListener('click', openImportModal);
  $('#import-modal-close').addEventListener('click', closeImportModal);
  $('#import-overlay').addEventListener('click', (e) => {
    if (e.target === $('#import-overlay')) closeImportModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#import-overlay').hidden) closeImportModal();
  });
  $('#import-zip-choice').addEventListener('click', () => {
    closeImportModal();
    zipInput.click();
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
  flash(t('preparing_download'));
  try {
    // Build the export archive in the browser: the server only holds
    // ciphertext, so we fetch every file, decrypt it with the vault key, and
    // zip the plaintext locally.
    const key = await ensureVaultKey();
    const list = await api('GET', '/api/files');
    const files = {};
    for (const entry of list || []) {
      const res = await fetch(attachmentUrl(entry.path), {
        credentials: 'same-origin',
      });
      if (!res.ok) continue;
      const cipher = new Uint8Array(await res.arrayBuffer());
      try {
        files[entry.path] = await window.WOCrypto.decryptBytesMaybe(key, cipher);
      } catch (e) {
        /* skip files that fail to decrypt */
      }
    }
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
    btn.disabled = false;
    if (icon) icon.className = originalIconClass;
  }
});

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
    // straight into the in-memory index (no network).
    const docs = [];
    const fresh = new Set();
    for (const rec of cached) {
      if (rec.version == null || rec.version !== wantedVersions.get(rec.path)) {
        continue; // changed, deleted, or no longer a text file
      }
      try {
        const bytes = await window.WOCrypto.decryptBytes(key, rec.cipher);
        const text = new TextDecoder().decode(bytes);
        docs.push({ path: rec.path, name: basename(rec.path), text });
        fresh.add(rec.path);
      } catch (e) {
        /* unreadable cache entry: treat as a miss and refetch below */
      }
    }

    // Download + decrypt only the notes that are new or changed since last sync.
    const puts = [];
    for (const entry of wanted) {
      if (fresh.has(entry.path)) continue;
      try {
        const res = await fetch(attachmentUrl(entry.path), {
          credentials: 'same-origin',
        });
        if (!res.ok) continue;
        const cipher = new Uint8Array(await res.arrayBuffer());
        const bytes = await window.WOCrypto.decryptBytesMaybe(key, cipher);
        const text = new TextDecoder().decode(bytes);
        docs.push({ path: entry.path, name: basename(entry.path), text });
        // Re-seal under the vault key so nothing readable sits in IndexedDB.
        const sealed = await window.WOCrypto.encryptBytes(key, bytes);
        puts.push({ path: entry.path, version: entry.version, cipher: sealed });
      } catch (e) {
        /* skip unreadable files */
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

const runSearch = debounce(async (q) => {
  const box = $('#search-results');
  if (!q.trim()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  // Name matches come from the server; content matches are computed locally
  // over the decrypted index. Merge them, de-duplicating by path.
  let hits = [];
  try {
    const nameHits = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    hits = Array.isArray(nameHits) ? nameHits.slice() : [];
  } catch (e) {
    hits = [];
  }
  try {
    await buildSearchIndex();
    const byPath = new Set(hits.map((h) => h.path));
    for (const ch of searchContent(q)) {
      if (byPath.has(ch.path)) {
        // Enrich the existing name hit with a content snippet.
        const existing = hits.find((h) => h.path === ch.path);
        if (existing && !existing.snippet) existing.snippet = ch.snippet;
      } else {
        hits.push(ch);
        byPath.add(ch.path);
      }
    }
  } catch (e) {
    /* content search unavailable; fall back to name hits only */
  }
  box.innerHTML = '';
  if (!hits.length) {
    box.innerHTML = '<div class="search-empty">' + t('no_matches') + '</div>';
  } else {
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
  }
  box.hidden = false;
}, 250);

$('#search-input').addEventListener('input', (e) => runSearch(e.target.value));
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

  // Privileged accounts: complimentary top tier, no billing UI.
  if (info.privileged) {
    privilegedHint.hidden = false;
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

/* ---------- init ---------- */

setSelectedDir('');
// Ensure the vault key is available before anything tries to read encrypted
// files. On a fresh tab this re-derives it from the password; if the user
// dismisses the prompt they are redirected to login.
ensureVaultKey()
  .then(() => loadTree())
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
