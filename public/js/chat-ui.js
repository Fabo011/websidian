'use strict';

/*
 * End-to-end encrypted chat — view layer.
 *
 * Renders a single conversation into a pane and wires the composer. All state,
 * crypto, networking and persistence live in chat.js (window.WOChat); this file
 * only builds DOM and reacts to WOChat events. App-specific helpers (translator,
 * attachment blob URLs, the vault file picker) are injected via `deps`.
 *
 * mountTab(container, { partner, deps }) -> { activate(), destroy() }
 */
(function () {
  const WOChat = window.WOChat;
  const WOUtil = window.WOUtil;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function mountTab(container, opts) {
    const partner = opts.partner;
    const deps = opts.deps;
    const t = deps.t;

    const pane = el('div', 'chat-pane');

    const header = el('div', 'chat-header');
    const title = el('span', 'chat-title', '@' + partner);
    const statusDot = el('span', 'chat-status');
    const spacer = el('span', 'chat-header-spacer');
    const clearBtn = el('button', 'chat-icon-btn chat-clear');
    clearBtn.type = 'button';
    clearBtn.title = t('chat_clear');
    clearBtn.setAttribute('aria-label', t('chat_clear'));
    clearBtn.innerHTML = '<i class="bi bi-trash"></i>';
    header.appendChild(title);
    header.appendChild(statusDot);
    header.appendChild(spacer);
    header.appendChild(clearBtn);
    pane.appendChild(header);

    // Privacy reassurance: the conversation is E2E encrypted and lives only in
    // the user's own storage — never on the server / in a database.
    const note = el('div', 'chat-note');
    note.innerHTML = '<i class="bi bi-shield-lock"></i> ';
    note.appendChild(document.createTextNode(t('chat_e2e_note')));
    pane.appendChild(note);

    const log = el('div', 'chat-log');
    pane.appendChild(log);

    const typing = el('div', 'chat-typing', t('chat_typing', { user: partner }));
    typing.hidden = true;
    pane.appendChild(typing);

    const errBar = el('div', 'chat-error');
    errBar.hidden = true;
    pane.appendChild(errBar);

    const composer = el('div', 'chat-composer');
    const attachImg = el('button', 'chat-icon-btn');
    attachImg.type = 'button';
    attachImg.title = t('chat_attach_image');
    attachImg.setAttribute('aria-label', t('chat_attach_image'));
    attachImg.innerHTML = '<i class="bi bi-image"></i>';
    const attachFile = el('button', 'chat-icon-btn');
    attachFile.type = 'button';
    attachFile.title = t('chat_attach_vault');
    attachFile.setAttribute('aria-label', t('chat_attach_vault'));
    attachFile.innerHTML = '<i class="bi bi-paperclip"></i>';
    const attachFolder = el('button', 'chat-icon-btn');
    attachFolder.type = 'button';
    attachFolder.title = t('chat_attach_folder');
    attachFolder.setAttribute('aria-label', t('chat_attach_folder'));
    attachFolder.innerHTML = '<i class="bi bi-folder"></i>';
    const attachLinks = el('button', 'chat-icon-btn');
    attachLinks.type = 'button';
    attachLinks.title = t('chat_send_weblinks');
    attachLinks.setAttribute('aria-label', t('chat_send_weblinks'));
    attachLinks.innerHTML = '<i class="bi bi-link-45deg"></i>';
    const input = el('textarea', 'chat-input');
    input.rows = 1;
    input.placeholder = t('chat_placeholder');
    const send = el('button', 'chat-send');
    send.type = 'button';
    send.title = t('chat_send');
    send.setAttribute('aria-label', t('chat_send'));
    send.innerHTML = '<i class="bi bi-send"></i>';
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    composer.appendChild(attachImg);
    composer.appendChild(attachFile);
    if (deps.pickVaultFolder) composer.appendChild(attachFolder);
    if (deps.pickWeblinksCsv) composer.appendChild(attachLinks);
    composer.appendChild(input);
    composer.appendChild(send);
    composer.appendChild(fileInput);
    pane.appendChild(composer);
    pane.appendChild(fileInput);

    container.appendChild(pane);

    // --- rendering ----------------------------------------------------------

    function scrollDown() {
      log.scrollTop = log.scrollHeight;
    }

    function showError(msg) {
      errBar.textContent = msg;
      errBar.hidden = false;
      setTimeout(() => {
        errBar.hidden = true;
      }, 5000);
    }

    function timeLabel(ts) {
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return '';
      }
    }

    function downloadAttachment(rec) {
      return async () => {
        try {
          const url = await deps.attachmentUrl(rec.imgPath);
          const a = document.createElement('a');
          a.href = url;
          a.download = rec.name || 'file';
          a.click();
        } catch {
          showError(t('chat_err_attachment'));
        }
      };
    }

    function renderRecord(rec) {
      const row = el('div', 'chat-msg ' + (rec.dir === 'out' ? 'out' : 'in'));
      if (rec.id) row.dataset.mid = rec.id;
      const bubble = el('div', 'chat-bubble');
      if (rec.type === 'image' && rec.imgPath) {
        const img = el('img', 'chat-img');
        img.alt = rec.name || 'image';
        bubble.appendChild(img);
        deps
          .attachmentUrl(rec.imgPath)
          .then((url) => {
            img.src = url;
          })
          .catch(() => {
            bubble.appendChild(el('div', 'chat-file-fallback', rec.name || ''));
          });
        // One-click actions for the image: open in-app + download.
        const actions = el('div', 'chat-img-actions');
        if (deps.openFile) {
          const open = el('button', 'chat-file-btn');
          open.type = 'button';
          open.textContent = t('chat_open');
          open.addEventListener('click', () => deps.openFile(rec.imgPath));
          actions.appendChild(open);
        }
        const dl = el('button', 'chat-file-btn');
        dl.type = 'button';
        dl.textContent = t('chat_download');
        dl.addEventListener('click', downloadAttachment(rec));
        actions.appendChild(dl);
        bubble.appendChild(actions);
      } else if (rec.type === 'file' && rec.imgPath) {
        const fileRow = el('div', 'chat-file');
        fileRow.innerHTML =
          '<i class="bi bi-file-earmark"></i> ' +
          escapeHtml(rec.name || 'file') +
          (rec.size
            ? ' <span class="chat-file-size">' +
              WOUtil.fmtSize(rec.size) +
              '</span>'
            : '');
        const actions = el('div', 'chat-file-actions');
        // The received file already lives in the user's vault (chat-images), so
        // "Open" opens it in-app; "Download" saves a copy locally.
        if (deps.openFile) {
          const open = el('button', 'chat-file-btn');
          open.type = 'button';
          open.textContent = t('chat_open');
          open.addEventListener('click', () => deps.openFile(rec.imgPath));
          actions.appendChild(open);
        }
        const dl = el('button', 'chat-file-btn');
        dl.type = 'button';
        dl.textContent = t('chat_download');
        dl.addEventListener('click', downloadAttachment(rec));
        actions.appendChild(dl);
        // A received weblinks*.csv can be merged straight into the recipient's
        // own Web links with one click.
        if (deps.importWeblinks && WOUtil.isWeblinksCsvName(rec.name)) {
          const imp = el('button', 'chat-file-btn');
          imp.type = 'button';
          imp.textContent = t('chat_import_weblinks');
          imp.addEventListener('click', () => onImportWeblinks(rec));
          actions.appendChild(imp);
        }
        // A received folder arrives as a .zip; offer to unpack it straight into
        // the recipient's own vault (structure preserved), not just download.
        if (deps.importVaultFolder && WOUtil.isZipName(rec.name)) {
          const imp = el('button', 'chat-file-btn');
          imp.type = 'button';
          imp.textContent = t('chat_import_folder');
          imp.addEventListener('click', () => onImportFolder(rec));
          actions.appendChild(imp);
        } else if (deps.importVaultFile) {
          // Any other received file can be onboarded into the vault as-is (not
          // just downloaded to the device).
          const imp = el('button', 'chat-file-btn');
          imp.type = 'button';
          imp.textContent = t('chat_import_file');
          imp.addEventListener('click', () => onImportFile(rec));
          actions.appendChild(imp);
        }
        bubble.appendChild(fileRow);
        bubble.appendChild(actions);
      } else {
        bubble.appendChild(el('div', 'chat-text', rec.text || ''));
      }
      const meta = el('div', 'chat-meta', timeLabel(rec.ts));
      bubble.appendChild(meta);

      // Per-message delete (appears on hover). Removes the message from the
      // vault log and any attachment file.
      if (rec.id) {
        const del = el('button', 'chat-msg-del');
        del.type = 'button';
        del.title = t('chat_delete_msg');
        del.setAttribute('aria-label', t('chat_delete_msg'));
        del.innerHTML = '<i class="bi bi-trash"></i>';
        del.addEventListener('click', () => onDeleteMessage(rec, row));
        row.appendChild(del);
      }

      row.appendChild(bubble);
      log.appendChild(row);
    }

    async function onImportWeblinks(rec) {
      try {
        const url = await deps.attachmentUrl(rec.imgPath);
        const text = await (await fetch(url)).text();
        await deps.importWeblinks(text);
      } catch {
        showError(t('chat_err_attachment'));
      }
    }

    // Unpack a received folder (.zip) into the recipient's vault. The heavy
    // lifting (confirm, decrypt, unzip, chunked upload) lives in the app layer.
    async function onImportFolder(rec) {
      try {
        await deps.importVaultFolder(rec.imgPath, rec.name);
      } catch (e) {
        showError(e.message || t('chat_err_attachment'));
      }
    }

    // Onboard a single received file into the recipient's vault (confirm + upload
    // handled in the app layer).
    async function onImportFile(rec) {
      try {
        await deps.importVaultFile(rec.imgPath, rec.name);
      } catch (e) {
        showError(e.message || t('chat_err_attachment'));
      }
    }

    async function onDeleteMessage(rec, row) {
      const ok = deps.confirm
        ? await deps.confirm(t('chat_delete_confirm'))
        : true;
      if (!ok) return;
      try {
        await WOChat.deleteMessage(partner, rec.id);
        if (row.parentNode) row.parentNode.removeChild(row);
      } catch (e) {
        showError(e.message || t('chat_err_delete'));
      }
    }

    async function onClearChat() {
      const ok = deps.confirm
        ? await deps.confirm(t('chat_clear_confirm'))
        : true;
      if (!ok) return;
      try {
        await WOChat.clearChat(partner);
        log.innerHTML = '';
        if (deps.refreshTree) deps.refreshTree();
        if (deps.flash) deps.flash(t('chat_cleared'));
      } catch (e) {
        showError(e.message || t('chat_err_delete'));
      }
    }

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = String(s == null ? '' : s);
      return d.innerHTML;
    }

    // --- sending ------------------------------------------------------------

    async function doSendText() {
      const text = input.value;
      if (!WOUtil.chatTextValid(text)) {
        if (text.trim()) showError(t('chat_err_too_long'));
        return;
      }
      input.value = '';
      autoGrow();
      try {
        const rec = await WOChat.sendText(partner, text);
        renderRecord(rec);
        scrollDown();
      } catch (e) {
        showError(e.message || t('chat_err_send'));
      }
    }

    async function doSendImage(file) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const rec = await WOChat.sendAttachment(partner, {
          kind: 'image',
          name: file.name,
          mime: file.type || 'application/octet-stream',
          bytes,
        });
        renderRecord(rec);
        scrollDown();
      } catch (e) {
        showError(e.message || t('chat_err_send'));
      }
    }

    async function doSendVaultFile() {
      if (!deps.pickVaultFile) return;
      let picked;
      try {
        picked = await deps.pickVaultFile();
      } catch {
        return;
      }
      if (!picked) return;
      try {
        const rec = await WOChat.sendAttachment(partner, {
          kind: 'file',
          name: picked.name,
          mime: picked.mime || 'application/octet-stream',
          bytes: picked.bytes,
        });
        renderRecord(rec);
        scrollDown();
      } catch (e) {
        showError(e.message || t('chat_err_send'));
      }
    }

    async function doSendFolder() {
      if (!deps.pickVaultFolder) return;
      let att;
      try {
        att = await deps.pickVaultFolder();
      } catch (e) {
        if (e && e.message) showError(e.message);
        return;
      }
      if (!att) return;
      try {
        const rec = await WOChat.sendAttachment(partner, {
          kind: 'file',
          name: att.name,
          mime: att.mime || 'application/zip',
          bytes: att.bytes,
        });
        renderRecord(rec);
        scrollDown();
      } catch (e) {
        showError(e.message || t('chat_err_send'));
      }
    }

    async function doSendWeblinks() {
      if (!deps.pickWeblinksCsv) return;
      let att;
      try {
        att = await deps.pickWeblinksCsv();
      } catch {
        return;
      }
      if (!att) return;
      try {
        const rec = await WOChat.sendAttachment(partner, {
          kind: 'file',
          name: att.name,
          mime: att.mime || 'text/csv',
          bytes: att.bytes,
        });
        renderRecord(rec);
        scrollDown();
      } catch (e) {
        showError(e.message || t('chat_err_send'));
      }
    }

    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }

    let typingSent = 0;
    function onInput() {
      autoGrow();
      const now = Date.now();
      if (now - typingSent > 2000) {
        typingSent = now;
        WOChat.sendTyping(partner);
      }
    }

    // --- events -------------------------------------------------------------

    send.addEventListener('click', doSendText);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSendText();
      }
    });
    input.addEventListener('input', onInput);
    attachImg.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) doSendImage(f);
    });
    attachFile.addEventListener('click', doSendVaultFile);
    attachFolder.addEventListener('click', doSendFolder);
    attachLinks.addEventListener('click', doSendWeblinks);
    clearBtn.addEventListener('click', onClearChat);

    // --- live updates -------------------------------------------------------

    const offMsg = WOChat.onMessage((p, rec) => {
      if (p !== partner) return;
      renderRecord(rec);
      scrollDown();
    });
    const offStatus = WOChat.onStatus(() => renderStatus());
    let typingTimer = null;
    const offTyping = WOChat.onTyping((p) => {
      if (p !== partner) return;
      typing.hidden = false;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        typing.hidden = true;
      }, 3000);
    });

    function renderStatus() {
      const online = WOChat.status() === 'online';
      statusDot.className = 'chat-status ' + (online ? 'online' : 'offline');
      statusDot.title = online ? t('chat_connected') : t('chat_reconnecting');
    }

    // --- boot ---------------------------------------------------------------

    let destroyed = false;
    async function load() {
      try {
        const records = await WOChat.history(partner);
        for (const r of records) renderRecord(r);
        scrollDown();
      } catch (e) {
        showError(t('chat_err_history'));
      }
      renderStatus();
    }
    load();

    return {
      pane,
      activate() {
        renderStatus();
        requestAnimationFrame(() => {
          scrollDown();
          input.focus();
        });
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        offMsg();
        offStatus();
        offTyping();
        clearTimeout(typingTimer);
      },
    };
  }

  window.WOChatUI = { mountTab };
})();
