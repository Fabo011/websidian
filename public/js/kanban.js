'use strict';

/*
 * Kanban board renderer. Framework-free DOM view over the pure board model in
 * wo-util.js (WOUtil.kanban*). Mirrors the ExcalidrawEditor contract so app.js
 * can treat a `.kanban` file like any other custom-editor tab:
 *
 *   const inst = WOKanban.mount(paneEl, board, { onChange, t, confirm });
 *   inst.getBoard();   // -> current board object (live, ready to serialize)
 *   inst.destroy();    // -> tear down listeners / DOM
 *
 * All persistence (encrypt + PUT /api/file) stays in app.js; this module only
 * owns the in-memory board and its DOM. `onChange` fires after every edit so
 * the host can flag the tab dirty. Columns are the user-defined, fully
 * customizable fields (Backlog / In Progress / Done / …).
 */
(function (root) {
  const U = root.WOUtil || (typeof require !== 'undefined' ? require('./wo-util') : null);

  // Identity translator fallback so the board still renders (in English) if the
  // host does not pass one in.
  const EN = {
    kanban_add_column: 'Add column',
    kanban_add_card: 'Add card',
    kanban_column_title_ph: 'Column title',
    kanban_card_title_ph: 'Card title',
    kanban_card_desc_ph: 'Description (optional)',
    kanban_delete_column: 'Delete column',
    kanban_delete_card: 'Delete card',
    kanban_save_card: 'Save',
    kanban_cancel: 'Cancel',
    kanban_confirm_delete_column: 'Delete this column and all its cards?',
    kanban_empty: 'No cards yet',
    kanban_link_note: 'Linked note',
    kanban_link_none: '(none)',
    kanban_url: 'Link (URL)',
    kanban_url_ph: 'https://…',
    kanban_due: 'Due date',
    kanban_open_note: 'Open linked note',
    kanban_open_url: 'Open link',
    kanban_new_note: 'Create & link a new note',
    kanban_drag_column: 'Drag to reorder column',
  };

  function mount(pane, initialBoard, opts) {
    opts = opts || {};
    const t = opts.t || ((k) => EN[k] || k);
    const onChange = opts.onChange || function () {};
    // Confirm hook: host passes uiConfirm; fall back to window.confirm.
    const confirm =
      opts.confirm ||
      ((msg) => Promise.resolve(root.confirm ? root.confirm(msg) : true));
    // Vault notes available to link, opener for a linked note, and a URL
    // sanitizer — all injected by the host so this module stays app-agnostic.
    const notes = Array.isArray(opts.notes) ? opts.notes : [];
    const onOpenNote = opts.onOpenNote || function () {};
    // Fired after any persist-worthy board change (card move, card save/delete,
    // column reorder) so the host can auto-save the board without an extra
    // manual Save click.
    const onMove = opts.onMove || function () {};
    // Host creates a new markdown note and resolves { path, name } (or null if
    // cancelled). Lets the editor create-and-link a note in one step.
    const onCreateNote = opts.onCreateNote || (() => Promise.resolve(null));
    const sanitizeUrl =
      opts.sanitizeUrl ||
      ((u) => (/^https?:\/\//i.test(u || '') ? u : ''));
    const baseName = (p) => String(p).split('/').pop().replace(/\.[^.]+$/, '');

    // The column object currently holding a given card id (null if not found).
    function columnOfCard(cardId) {
      return (
        board.columns.find((c) => c.cards.some((k) => k.id === cardId)) || null
      );
    }

    let board = U.kanbanNormalize(initialBoard);

    const el = document.createElement('div');
    el.className = 'kanban-board';
    pane.appendChild(el);

    // Drag state for the active card. Native HTML5 DnD; dataTransfer carries the
    // id but we keep a local ref too (dataTransfer.getData is empty in dragover).
    let dragCardId = null;
    // Separate drag state for reordering whole columns (via the header grip).
    let dragColId = null;

    function changed() {
      onChange();
    }

    function render() {
      el.innerHTML = '';
      for (const col of board.columns) el.appendChild(renderColumn(col));
      el.appendChild(renderAddColumn());
    }

    function renderColumn(col) {
      const wrap = document.createElement('div');
      wrap.className = 'kanban-col';
      wrap.dataset.colId = col.id;

      // Column reorder: dropping a dragged column onto this one inserts it
      // before/after depending on which half the pointer is over. Guarded by
      // dragColId so card drags (bubbling up from .kanban-cards) are ignored.
      wrap.addEventListener('dragover', (e) => {
        if (!dragColId || dragColId === col.id) return;
        e.preventDefault();
        const r = wrap.getBoundingClientRect();
        wrap.classList.toggle('col-drop-before', e.clientX < r.left + r.width / 2);
        wrap.classList.toggle('col-drop-after', e.clientX >= r.left + r.width / 2);
      });
      wrap.addEventListener('dragleave', () => {
        wrap.classList.remove('col-drop-before', 'col-drop-after');
      });
      wrap.addEventListener('drop', (e) => {
        if (!dragColId || dragColId === col.id) return;
        e.preventDefault();
        wrap.classList.remove('col-drop-before', 'col-drop-after');
        const r = wrap.getBoundingClientRect();
        const after = e.clientX >= r.left + r.width / 2;
        const ids = board.columns.map((c) => c.id);
        const fromIdx = ids.indexOf(dragColId);
        let toIndex = ids.indexOf(col.id) + (after ? 1 : 0);
        if (fromIdx < toIndex) toIndex -= 1; // account for removal of the dragged col
        U.kanbanMoveColumn(board, dragColId, toIndex);
        dragColId = null;
        changed();
        render();
        onMove(); // structural change — auto-save like a card move
      });

      const head = document.createElement('div');
      head.className = 'kanban-col-head';

      // Drag handle (grip). Only the grip is draggable so the title stays
      // clickable/editable and card drags aren't hijacked.
      const grip = document.createElement('span');
      grip.className = 'kanban-col-grip';
      grip.draggable = true;
      grip.title = t('kanban_drag_column');
      grip.setAttribute('aria-label', t('kanban_drag_column'));
      grip.innerHTML = '<i class="bi bi-grip-vertical"></i>';
      grip.addEventListener('dragstart', (e) => {
        dragColId = col.id;
        wrap.classList.add('col-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', col.id);
        } catch {
          /* local ref covers restricted setData */
        }
      });
      grip.addEventListener('dragend', () => {
        dragColId = null;
        wrap.classList.remove('col-dragging');
        el.querySelectorAll('.kanban-col').forEach((c) =>
          c.classList.remove('col-drop-before', 'col-drop-after'),
        );
      });
      head.appendChild(grip);

      const titleInput = document.createElement('input');
      titleInput.className = 'kanban-col-title';
      titleInput.type = 'text';
      titleInput.value = col.title;
      titleInput.placeholder = t('kanban_column_title_ph');
      titleInput.setAttribute('aria-label', t('kanban_column_title_ph'));
      titleInput.addEventListener('change', () => {
        U.kanbanRenameColumn(board, col.id, titleInput.value);
        changed();
      });
      head.appendChild(titleInput);

      const count = document.createElement('span');
      count.className = 'kanban-col-count';
      count.textContent = String(col.cards.length);
      head.appendChild(count);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'kanban-col-del icon-btn';
      del.title = t('kanban_delete_column');
      del.setAttribute('aria-label', t('kanban_delete_column'));
      del.innerHTML = '<i class="bi bi-trash"></i>';
      del.addEventListener('click', async () => {
        const ok = await confirm(t('kanban_confirm_delete_column'));
        if (!ok) return;
        U.kanbanRemoveColumn(board, col.id);
        changed();
        render();
      });
      head.appendChild(del);
      wrap.appendChild(head);

      const list = document.createElement('div');
      list.className = 'kanban-cards';
      list.dataset.colId = col.id;
      // Drop target: allow dropping onto empty space / end of the column.
      // Ignore column drags (dragColId) — the wrapper handles those.
      list.addEventListener('dragover', (e) => {
        if (dragColId) return;
        e.preventDefault();
        list.classList.add('drag-over');
      });
      list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
      list.addEventListener('drop', (e) => {
        e.preventDefault();
        list.classList.remove('drag-over');
        if (!dragCardId) return;
        const after = cardIndexAt(list, e.clientY);
        // Did the card actually change column? (drives auto-save on move)
        const fromCol = columnOfCard(dragCardId);
        const crossedColumn = fromCol && fromCol.id !== col.id;
        U.kanbanMoveCard(board, dragCardId, col.id, after);
        dragCardId = null;
        changed();
        render();
        if (crossedColumn) onMove();
      });

      if (!col.cards.length) {
        const empty = document.createElement('div');
        empty.className = 'kanban-empty muted';
        empty.textContent = t('kanban_empty');
        list.appendChild(empty);
      }
      for (const card of col.cards) list.appendChild(renderCard(col, card));
      wrap.appendChild(list);

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'kanban-add-card';
      add.innerHTML = '<i class="bi bi-plus-lg"></i> ' + escapeHtml(t('kanban_add_card'));
      add.addEventListener('click', () => {
        U.kanbanAddCard(board, col.id, { title: '' });
        changed();
        render();
        // Open the freshly added (last) card straight into edit mode.
        const fresh = list.querySelector('.kanban-card:last-of-type');
        if (fresh) openCardEditor(fresh, col, col.cards[col.cards.length - 1], true);
      });
      wrap.appendChild(add);

      return wrap;
    }

    // Index within the column's card list where a drop at pointer-Y should land.
    function cardIndexAt(list, y) {
      const cards = [...list.querySelectorAll('.kanban-card')];
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return cards.length;
    }

    function renderCard(col, card) {
      const el2 = document.createElement('div');
      el2.className = 'kanban-card';
      el2.dataset.cardId = card.id;
      el2.draggable = true;

      const title = document.createElement('div');
      title.className = 'kanban-card-title';
      title.textContent = card.title || t('kanban_card_title_ph');
      if (!card.title) title.classList.add('muted');
      el2.appendChild(title);

      if (card.description) {
        const desc = document.createElement('div');
        desc.className = 'kanban-card-desc';
        desc.textContent = card.description;
        el2.appendChild(desc);
      }

      // Meta row: due-date chip + clickable note link + clickable URL. Clicks on
      // the links must NOT open the card editor, so they stopPropagation.
      const safeUrl = sanitizeUrl(card.url);
      if (card.due || card.link || safeUrl) {
        const meta = document.createElement('div');
        meta.className = 'kanban-card-meta';

        if (card.due) {
          const chip = document.createElement('span');
          chip.className = 'kanban-due';
          if (isPast(card.due)) chip.classList.add('is-overdue');
          chip.innerHTML =
            '<i class="bi bi-calendar-event"></i> ' + escapeHtml(card.due);
          meta.appendChild(chip);
        }

        if (card.link) {
          const a = document.createElement('a');
          a.className = 'kanban-cardlink';
          a.href = '#';
          a.title = card.link;
          a.setAttribute('aria-label', t('kanban_open_note'));
          a.innerHTML =
            '<i class="bi bi-file-earmark-text"></i> ' +
            escapeHtml(baseName(card.link));
          a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenNote(card.link);
          });
          meta.appendChild(a);
        }

        if (safeUrl) {
          const a = document.createElement('a');
          a.className = 'kanban-cardlink';
          a.href = safeUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.title = safeUrl;
          a.setAttribute('aria-label', t('kanban_open_url'));
          a.innerHTML = '<i class="bi bi-box-arrow-up-right"></i> ' + t('kanban_open_url');
          a.addEventListener('click', (e) => e.stopPropagation());
          meta.appendChild(a);
        }
        el2.appendChild(meta);
      }

      el2.addEventListener('dragstart', (e) => {
        dragCardId = card.id;
        el2.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', card.id);
        } catch {
          /* some browsers restrict setData; local ref covers it */
        }
      });
      el2.addEventListener('dragend', () => {
        dragCardId = null;
        el2.classList.remove('dragging');
      });
      el2.addEventListener('click', () => openCardEditor(el2, col, card, false));

      return el2;
    }

    // Replace a card node with an inline edit form (title + description).
    function openCardEditor(cardEl, col, card, isNew) {
      const form = document.createElement('div');
      form.className = 'kanban-card kanban-card-edit';

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'kanban-edit-title';
      titleInput.value = card.title;
      titleInput.placeholder = t('kanban_card_title_ph');

      const descInput = document.createElement('textarea');
      descInput.className = 'kanban-edit-desc';
      descInput.value = card.description;
      descInput.placeholder = t('kanban_card_desc_ph');
      descInput.rows = 3;

      // Linked note: a dropdown of every markdown note in the vault.
      const linkLabel = document.createElement('label');
      linkLabel.className = 'kanban-edit-field';
      linkLabel.textContent = t('kanban_link_note');
      const linkSelect = document.createElement('select');
      linkSelect.className = 'kanban-edit-link';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = t('kanban_link_none');
      linkSelect.appendChild(none);
      // Keep a stale link selectable even if the note is gone/filtered out.
      const noteList = notes.slice();
      if (card.link && !noteList.some((n) => n.path === card.link)) {
        noteList.unshift({ path: card.link, name: baseName(card.link) });
      }
      for (const n of noteList) {
        const opt = document.createElement('option');
        opt.value = n.path;
        opt.textContent = n.name;
        linkSelect.appendChild(opt);
      }
      linkSelect.value = card.link || '';

      // Row: dropdown + a button that creates a new note and links it here.
      const linkRow = document.createElement('div');
      linkRow.className = 'kanban-edit-linkrow';
      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.className = 'btn-ghost kanban-edit-newnote';
      newBtn.title = t('kanban_new_note');
      newBtn.setAttribute('aria-label', t('kanban_new_note'));
      newBtn.innerHTML = '<i class="bi bi-file-earmark-plus"></i>';
      newBtn.addEventListener('click', async () => {
        newBtn.disabled = true;
        try {
          const created = await onCreateNote(titleInput.value.trim());
          if (created && created.path) {
            // Reflect the new note in the dropdown and select it.
            if (!Array.from(linkSelect.options).some((o) => o.value === created.path)) {
              const opt = document.createElement('option');
              opt.value = created.path;
              opt.textContent = created.name || baseName(created.path);
              linkSelect.appendChild(opt);
            }
            linkSelect.value = created.path;
          }
        } finally {
          newBtn.disabled = false;
        }
      });
      linkRow.append(linkSelect, newBtn);
      linkLabel.appendChild(linkRow);

      // External URL.
      const urlLabel = document.createElement('label');
      urlLabel.className = 'kanban-edit-field';
      urlLabel.textContent = t('kanban_url');
      const urlInput = document.createElement('input');
      urlInput.type = 'url';
      urlInput.className = 'kanban-edit-url';
      urlInput.value = card.url;
      urlInput.placeholder = t('kanban_url_ph');
      urlLabel.appendChild(urlInput);

      // Due date (feeds the calendar).
      const dueLabel = document.createElement('label');
      dueLabel.className = 'kanban-edit-field';
      dueLabel.textContent = t('kanban_due');
      const dueInput = document.createElement('input');
      dueInput.type = 'date';
      dueInput.className = 'kanban-edit-due';
      dueInput.value = card.due;
      dueLabel.appendChild(dueInput);

      const actions = document.createElement('div');
      actions.className = 'kanban-edit-actions';

      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn-primary';
      save.textContent = t('kanban_save_card');

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-ghost kanban-edit-del';
      del.title = t('kanban_delete_card');
      del.innerHTML = '<i class="bi bi-trash"></i>';

      const commit = () => {
        U.kanbanUpdateCard(board, card.id, {
          title: titleInput.value,
          description: descInput.value,
          link: linkSelect.value,
          url: urlInput.value,
          due: dueInput.value,
        });
        changed();
        render();
        onMove(); // persist the card edit immediately, like a card move
      };
      save.addEventListener('click', commit);
      del.addEventListener('click', () => {
        U.kanbanRemoveCard(board, card.id);
        changed();
        render();
        onMove(); // deletion is persist-worthy — auto-save too
      });
      // Enter in the title commits; Escape cancels (re-render drops the form).
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          if (isNew && !titleInput.value && !descInput.value) {
            U.kanbanRemoveCard(board, card.id);
            changed();
          }
          render();
        }
      });

      actions.append(save, del);
      form.append(
        titleInput,
        descInput,
        linkLabel,
        urlLabel,
        dueLabel,
        actions,
      );
      cardEl.replaceWith(form);
      titleInput.focus();
    }

    function renderAddColumn() {
      const wrap = document.createElement('div');
      wrap.className = 'kanban-col kanban-col-add';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kanban-add-col';
      btn.innerHTML = '<i class="bi bi-plus-lg"></i> ' + escapeHtml(t('kanban_add_column'));
      btn.addEventListener('click', () => {
        U.kanbanAddColumn(board, '');
        changed();
        render();
        // Focus the new column's title input for immediate naming.
        const cols = el.querySelectorAll('.kanban-col-title');
        const last = cols[cols.length - 1];
        if (last) last.focus();
      });
      wrap.appendChild(btn);
      return wrap;
    }

    // True when a YYYY-MM-DD due date is before today (local). Used to flag
    // overdue cards. Malformed dates are treated as not overdue.
    function isPast(due) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
      const today = new Date();
      const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const [y, m, d] = due.split('-').map(Number);
      return new Date(y, m - 1, d) < t0;
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => {
        return {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[c];
      });
    }

    render();

    return {
      getBoard() {
        return U.kanbanNormalize(board);
      },
      destroy() {
        el.remove();
      },
    };
  }

  const api = { mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WOKanban = api;
})(typeof self !== 'undefined' ? self : this);
