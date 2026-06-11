'use strict';

/* ---------- small helpers ---------- */

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
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
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
const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const TEXT_EXTS = ['md', 'markdown', 'txt', 'json', 'csv', 'yml', 'yaml'];

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

/* ---------- state ---------- */

const state = {
  selectedDir: '',
  current: null, // { path, ext }
  dirty: false,
  excalidraw: null,
  contextTarget: null,
  dragPath: null,
  dragType: null,
};

/* ---------- tree ---------- */

async function loadTree() {
  const tree = await api('GET', '/api/tree');
  const container = $('#tree');
  container.innerHTML = '';
  container.appendChild(buildList(tree));
}

// Dropping on empty tree space moves an entry to the vault root.
(function setupRootDrop() {
  const tree = $('#tree');
  if (!tree) return;
  tree.addEventListener('dragover', (e) => {
    if (e.target.closest('.tree-row')) return; // handled by folder rows
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
    const caret = document.createElement('i');
    caret.className = 'bi bi-chevron-right caret';
    label.appendChild(caret);

    const folderIcon = document.createElement('i');
    folderIcon.className = 'bi bi-folder tree-icon tree-icon-dir';
    label.appendChild(folderIcon);

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name;
    label.appendChild(name);
    row.appendChild(label);

    const childWrap = document.createElement('div');
    childWrap.className = 'tree-children';
    childWrap.hidden = true;
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
    if (isInvalidMove(state.dragPath, state.dragType, targetDir)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drop-target');
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
    flash(err.message || 'Could not move item');
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
  await loadTree();
  flash('Moved to ' + (targetDir || 'Vault root'));
}

function fileIcon(ext) {
  if (IMAGE_EXTS.includes(ext)) return 'bi-file-earmark-image';
  if (ext === 'pdf') return 'bi-file-earmark-pdf';
  if (ext === 'excalidraw') return 'bi-pencil-square';
  if (ext === 'md' || ext === 'markdown') return 'bi-file-earmark-text';
  if (ext === 'txt') return 'bi-file-earmark';
  if (ext === 'json' || ext === 'yml' || ext === 'yaml' || ext === 'csv')
    return 'bi-file-earmark-code';
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

/* ---------- context menu ---------- */

function openContextMenu(x, y, node) {
  state.contextTarget = node;
  const menu = $('#context-menu');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.hidden = false;
}
function closeContextMenu() {
  $('#context-menu').hidden = true;
  state.contextTarget = null;
}

document.addEventListener('click', () => closeContextMenu());

$('#context-menu').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  const node = state.contextTarget;
  if (!action || !node) return;
  closeContextMenu();
  if (action === 'rename') {
    const newName = prompt('Rename to:', node.name);
    if (!newName || newName === node.name) return;
    const parent = dirname(node.path);
    const to = parent ? parent + '/' + newName : newName;
    await api('POST', '/api/rename', { from: node.path, to });
    if (state.current && state.current.path === node.path) {
      state.current.path = to;
      $('#current-path').textContent = to;
    }
    await loadTree();
  } else if (action === 'delete') {
    if (!confirm('Delete "' + node.name + '"? This cannot be undone.')) return;
    await api('DELETE', '/api/entry?path=' + encodeURIComponent(node.path));
    if (state.current && state.current.path.startsWith(node.path)) {
      showWelcome();
    }
    await loadTree();
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
  if (ext === 'excalidraw') {
    return openExcalidraw(path);
  }
  if (TEXT_EXTS.includes(ext)) {
    return openEditor(path, ext);
  }
  return openViewer(path, ext);
}

/* ---------- text editor + preview ---------- */

async function openEditor(path, ext) {
  const data = await api('GET', '/api/file?path=' + encodeURIComponent(path));
  hideAllViews();
  state.current = { path, ext, version: data.version };
  state.dirty = false;
  $('#editor-view').hidden = false;
  renderBreadcrumb($('#current-path'), path);
  const editor = $('#editor');
  editor.value = data.content;
  const isMarkdown = ext === 'md' || ext === 'markdown';
  $('#toggle-preview').style.display = isMarkdown ? '' : 'none';
  // Always start in edit mode.
  setViewMode(false);
  editor.focus();
}

$('#editor').addEventListener('input', () => {
  state.dirty = true;
});

/** Switch the editor between edit mode (textarea) and reading mode (preview). */
function setViewMode(viewing) {
  const editor = $('#editor');
  const preview = $('#preview');
  const toggle = $('#toggle-preview');
  state.viewing = viewing;
  if (viewing) {
    editor.hidden = true;
    preview.hidden = false;
    renderPreviewNow();
    toggle.innerHTML = '<i class="bi bi-pencil"></i> <span class="btn-label">Edit</span>';
    toggle.title = 'Switch to editing';
  } else {
    preview.hidden = true;
    editor.hidden = false;
    toggle.innerHTML = '<i class="bi bi-eye"></i> <span class="btn-label">View</span>';
    toggle.title = 'Switch to reading';
  }
}

async function renderPreviewNow() {
  if (!state.current) return;
  try {
    const data = await api('POST', '/api/render', {
      path: state.current.path,
      content: $('#editor').value,
    });
    $('#preview').innerHTML = data.html;
  } catch (e) {
    /* ignore preview errors */
  }
}

$('#toggle-preview').addEventListener('click', () => {
  setViewMode(!state.viewing);
});

$('#preview').addEventListener('click', (e) => {
  const link = e.target.closest('a.wo-wikilink');
  if (link) {
    e.preventDefault();
    const target = link.dataset.target;
    if (target) openFile(target);
  }
});

async function saveCurrent() {
  if (!state.current) return;
  const payload = {
    path: state.current.path,
    content: $('#editor').value,
    baseVersion: state.current.version,
  };
  let result;
  try {
    result = await api('PUT', '/api/file', payload);
  } catch (e) {
    if (e.status === 409) {
      const overwrite = confirm(
        'This file was changed elsewhere since you opened it.\n\n' +
          'OK = overwrite with your version\nCancel = keep the other version (reload)',
      );
      if (overwrite) {
        delete payload.baseVersion;
        result = await api('PUT', '/api/file', payload);
      } else {
        await openFile(state.current.path);
        flash('Reloaded latest version');
        return;
      }
    } else {
      throw e;
    }
  }
  if (result && result.version) state.current.version = result.version;
  state.dirty = false;
  flash('Saved');
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
  $('#viewer-download').href = attachmentUrl(path);
  const body = $('#viewer-body');
  body.innerHTML = '';
  if (IMAGE_EXTS.includes(ext)) {
    const img = document.createElement('img');
    img.src = attachmentUrl(path);
    img.alt = basename(path);
    body.appendChild(img);
  } else if (ext === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = attachmentUrl(path);
    frame.className = 'pdf-frame';
    body.appendChild(frame);
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No preview available for this file type.';
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
  root.innerHTML = 'Loading editor…';
  let initial = null;
  try {
    const data = await api('GET', '/api/file?path=' + encodeURIComponent(path));
    state.current.version = data.version;
    initial = data.content ? JSON.parse(data.content) : null;
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
    content: json,
    baseVersion: state.current.version,
  };
  let result;
  try {
    result = await api('PUT', '/api/file', payload);
  } catch (e) {
    if (e.status === 409) {
      const overwrite = confirm(
        'This drawing was changed elsewhere since you opened it.\n\n' +
          'OK = overwrite with your version\nCancel = abort save',
      );
      if (!overwrite) {
        flash('Save cancelled');
        return;
      }
      delete payload.baseVersion;
      result = await api('PUT', '/api/file', payload);
    } else {
      throw e;
    }
  }
  if (result && result.version) state.current.version = result.version;
  flash('Saved');
}
$('#excalidraw-save').addEventListener('click', saveExcalidraw);

/* ---------- create / upload / import ---------- */

$('#new-note').addEventListener('click', async () => {
  let name = prompt('New note name:', 'Untitled.md');
  if (!name) return;
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
  const path = state.selectedDir ? state.selectedDir + '/' + name : name;
  await api('PUT', '/api/file', { path, content: '' });
  await loadTree();
  openFile(path);
});

$('#new-file').addEventListener('click', async () => {
  const name = prompt(
    'New file name (include the extension, e.g. diagram.excalidraw):',
    'Untitled.excalidraw',
  );
  if (!name) return;
  if (!/\.[a-z0-9]+$/i.test(name)) {
    flash('Please include a file extension (e.g. .excalidraw).');
    return;
  }
  const path = state.selectedDir ? state.selectedDir + '/' + name : name;
  try {
    await api('PUT', '/api/file', { path, content: '' });
  } catch (e) {
    flash(e.message || 'Could not create file');
    return;
  }
  await loadTree();
  openFile(path);
});

$('#new-folder').addEventListener('click', async () => {
  const name = prompt('New folder name:');
  if (!name) return;
  const path = state.selectedDir ? state.selectedDir + '/' + name : name;
  await api('POST', '/api/folder', { path });
  await loadTree();
});

$('#upload-btn').addEventListener('click', () => $('#upload-input').click());
$('#upload-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('folder', state.selectedDir);
    await api('POST', '/api/upload', fd, true);
  }
  e.target.value = '';
  await loadTree();
  flash('Uploaded ' + files.length + ' file(s)');
});

// Enable directory selection where supported (desktop); otherwise fall back to
// multi-file / .zip selection (mobile-friendly).
(function setupImport() {
  const input = $('#import-input');
  const supportsDir = 'webkitdirectory' in document.createElement('input');
  if (supportsDir) {
    input.webkitdirectory = true;
  } else {
    input.setAttribute('accept', '*/*');
  }
  $('#import-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const fd = new FormData();
    const paths = [];
    for (const file of files) {
      const rel = file.webkitRelativePath || file.name;
      paths.push(rel);
      // Send the basename as the multipart filename; the relative path is sent
      // separately in `paths` so the folder structure survives intact.
      fd.append('files', file, rel.split('/').pop());
    }
    fd.append('paths', JSON.stringify(paths));
    fd.append('base', state.selectedDir);
    const res = await api('POST', '/api/import', fd, true);
    e.target.value = '';
    await loadTree();
    flash('Imported ' + (res.written || 0) + ' file(s)');
  });
})();

$('#export-btn').addEventListener('click', () => {
  // Stream the zip via a direct navigation so the browser handles the download.
  flash('Preparing vault download…');
  window.location.href = '/api/export';
});

/* ---------- search ---------- */

const runSearch = debounce(async (q) => {
  const box = $('#search-results');
  if (!q.trim()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const hits = await api('GET', '/api/search?q=' + encodeURIComponent(q));
  box.innerHTML = '';
  if (!hits.length) {
    box.innerHTML = '<div class="search-empty">No matches</div>';
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

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  window.location.href = '/login';
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

/* ---------- init ---------- */

setSelectedDir('');
loadTree().catch((e) => console.error(e));
