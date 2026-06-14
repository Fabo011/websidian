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
  const isDir = node.type === 'dir';
  menu.querySelectorAll('[data-folder-only]').forEach((el) => {
    el.hidden = !isDir;
  });
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
  } else if (action === 'delete') {
    const ok = await uiConfirm(t('delete'), {
      message: t('confirm_delete_msg', { name: node.name }),
      okText: t('delete'),
      danger: true,
    });
    if (!ok) return;
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
  hideAllViews();
  state.current = { path, ext, version: data.version };
  state.dirty = false;
  $('#editor-view').hidden = false;
  renderBreadcrumb($('#current-path'), path);
  const editor = $('#editor');
  editor.value = data.content;
  const isMarkdown = ext === 'md' || ext === 'markdown';
  $('#toggle-preview').style.display = isMarkdown ? '' : 'none';
  // Markdown files open in reading (view) mode by default; other text files
  // (txt, json, csv, …) open in edit mode since they have no preview.
  if (isMarkdown) {
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
    content: $('#editor').value,
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
  await api('PUT', '/api/file', { path, content: '' });
  expandAncestors(targetDir);
  await loadTree();
  openFile(path);
}

async function createFileIn(targetDir) {
  const name = await uiPrompt(t('prompt_new_file_title'), 'Untitled.excalidraw', {
    title: t('prompt_new_file_title'),
    message: t('prompt_new_file_msg'),
    placeholder: t('prompt_new_file_ph'),
  });
  if (!name) return;
  if (!/\.[a-z0-9]+$/i.test(name)) {
    flash(t('need_extension'));
    return;
  }
  const path = targetDir ? targetDir + '/' + name : name;
  try {
    await api('PUT', '/api/file', { path, content: '' });
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
  showLoading(t('uploading'));
  try {
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file, file.name);
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
    await loadTree();
    flash(t('imported_n', { n: res.written || 0 }));
  } catch (err) {
    await uiAlert(t('import_failed_title'), {
      message: err.message || t('import_failed_msg'),
    });
  } finally {
    hideLoading();
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

$('#export-btn').addEventListener('click', () => {
  // Stream the zip via a direct navigation so the browser handles the download.
  flash(t('preparing_download'));
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
  } catch (e) {
    text.textContent = t('usage_error');
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

$('#account-btn').addEventListener('click', openDashboard);
$('#dashboard-close').addEventListener('click', closeDashboard);
$('#dashboard-overlay').addEventListener('click', (e) => {
  if (e.target === $('#dashboard-overlay')) closeDashboard();
});
$('#delete-account-btn').addEventListener('click', deleteAccount);
document.addEventListener('keydown', (e) => {
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
loadTree().catch((e) => console.error(e));
