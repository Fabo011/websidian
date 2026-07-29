'use strict';

/*
 * End-to-end encrypted chat — client core.
 *
 * Zero-knowledge, like the rest of websidian. Each user owns an ECDH P-256
 * identity keypair (crypto.js): the public key is published to the server, the
 * private key is wrapped with the vault key and never leaves the browser in the
 * clear. A per-conversation AES-GCM key is derived from ECDH(myPrivate,
 * partnerPublic); both sides derive the identical key, so messages encrypt and
 * decrypt symmetrically once the key exists.
 *
 * Two layers of encryption, and the server can read neither:
 *   - in transit / in the offline queue: the ECDH-derived conversation key;
 *   - at rest: each side re-encrypts every message with its own vault key and
 *     appends it to its own conversation file in its own vault storage.
 *
 * This file owns identity, key derivation, the WebSocket relay, and vault
 * persistence. All DOM lives in chat-ui.js; everything pure lives in
 * wo-util.js. App wiring is injected via init(deps) so this module never
 * reaches into app.js globals.
 */
(function () {
  const WOCrypto = window.WOCrypto;
  const WOUtil = window.WOUtil;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let deps = null;
  let me = '';
  let identity = null; // { publicKey: b64, privateKey: CryptoKey }
  let ready = false;
  let notifEnabled = false;
  let soundEnabled = true;
  let audioCtx = null;

  // Per-partner derived conversation keys + published public keys (cached).
  const partnerKeys = new Map();
  const partnerPub = new Map();

  // Per-partner append-only log cache: { text, version } + a write mutex so
  // concurrent appends (an incoming message while sending) never clobber each
  // other on the file version.
  const logs = new Map();
  const logLocks = new Map();

  // WebSocket state.
  let ws = null;
  let wsReady = false;
  let reconnectTimer = null;
  let backoff = 1000;
  let closedByUs = false;
  const outbox = []; // messages queued while the socket was down
  const pendingAcks = new Map(); // clientMsgId -> resolve

  const messageListeners = new Set(); // (partner, record, meta)
  const statusListeners = new Set(); // ('online'|'offline')
  const typingListeners = new Set(); // (partner)

  // --- lifecycle ------------------------------------------------------------

  async function init(d) {
    deps = d;
    me = WOUtil.sanitizeChatUsername(d.username) || d.username;
    // The "notifications" preference is stored in the vault and therefore syncs
    // across devices, but browser notification permission is per-browser. A pref
    // of `true` synced from another browser does NOT mean THIS browser granted
    // permission — so gate on the real permission here. Otherwise the toggle
    // shows "on" in a browser that was never granted, the user never re-triggers
    // the permission prompt, and notifications silently never fire.
    notifEnabled =
      !!(d.getNotifPref && d.getNotifPref()) &&
      notificationsSupported() &&
      window.Notification.permission === 'granted';
    // Sound is independent of OS notification permission (it never leaves the
    // page) and defaults on. The pref syncs across devices via the vault.
    soundEnabled = d.getSoundPref ? !!d.getSoundPref() : true;
    await ensureIdentity();
    connect();
  }

  /** Load or lazily create this user's chat identity keypair. */
  async function ensureIdentity() {
    const vk = await deps.getVaultKey();
    const keys = await deps.api('GET', '/api/account/keys');
    if (keys && keys.chatPublicKey && keys.wrappedChatPrivateKey) {
      const priv = await WOCrypto.unwrapPrivateKey(
        vk,
        keys.wrappedChatPrivateKey,
      );
      identity = { publicKey: keys.chatPublicKey, privateKey: priv };
    } else {
      const kp = await WOCrypto.generateIdentityKeyPair();
      const publicKey = await WOCrypto.exportPublicKeySpkiB64(kp);
      const wrapped = await WOCrypto.wrapPrivateKey(vk, kp);
      await deps.api('POST', '/api/account/chat-keys', {
        chatPublicKey: publicKey,
        wrappedChatPrivateKey: wrapped,
      });
      const priv = await WOCrypto.unwrapPrivateKey(vk, wrapped);
      identity = { publicKey, privateKey: priv };
    }
    ready = true;
  }

  function isReady() {
    return ready;
  }

  // --- partner keys ---------------------------------------------------------

  /** Verify a partner exists + has chat set up; returns their public key info.
   *  Throws (with a translated message) when the lookup fails. */
  async function verifyPartner(partner) {
    const p = WOUtil.sanitizeChatUsername(partner);
    if (!p) throw new Error(deps.t('chat_err_bad_username'));
    try {
      const info = await deps.api(
        'GET',
        '/api/chat/pubkey/' + encodeURIComponent(p),
      );
      partnerPub.set(p, info.publicKey);
      return info;
    } catch (e) {
      // The server distinguishes "no such account" from "account exists but has
      // not published a chat key yet" (see chat.controller). Surface the second
      // case with a message that makes clear the partner does NOT need to be
      // online — they only need to open the app once.
      const code = e && e.data && e.data.error;
      throw new Error(
        deps.t(code === 'chat_not_setup' ? 'chat_err_not_setup' : 'chat_err_no_user'),
      );
    }
  }

  /** Derive (and cache) the shared conversation key for a partner. */
  async function keyForPartner(partner) {
    if (partnerKeys.has(partner)) return partnerKeys.get(partner);
    let pub = partnerPub.get(partner);
    if (!pub) pub = (await verifyPartner(partner)).publicKey;
    const key = await WOCrypto.deriveChatKey(identity.privateKey, pub);
    partnerKeys.set(partner, key);
    return key;
  }

  // --- WebSocket ------------------------------------------------------------

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws/chat';
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    closedByUs = false;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onmessage = (ev) => handleFrame(ev.data);
    ws.onclose = () => {
      wsReady = false;
      emitStatus('offline');
      if (!closedByUs) scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  function wsSend(event, data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ event, data }));
      return true;
    }
    return false;
  }

  function handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const { event, data } = frame || {};
    if (event === 'ready') {
      wsReady = true;
      backoff = 1000;
      emitStatus('online');
      flushOutbox();
    } else if (event === 'message') {
      onIncoming(data).catch((e) => console.warn('chat: incoming failed', e));
    } else if (event === 'sent') {
      const id = data && data.clientMsgId;
      if (id && pendingAcks.has(id)) {
        pendingAcks.get(id)(data);
        pendingAcks.delete(id);
      }
    } else if (event === 'typing') {
      const p = WOUtil.sanitizeChatUsername(data && data.from);
      if (p) typingListeners.forEach((cb) => cb(p));
    }
  }

  function flushOutbox() {
    if (!outbox.length) return;
    const items = outbox.splice(0, outbox.length);
    for (const it of items) {
      if (!wsSend('send', it)) outbox.push(it);
    }
  }

  // --- sending --------------------------------------------------------------

  function rid() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return WOCrypto.bytesToB64(window.crypto.getRandomValues(new Uint8Array(16)))
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 22);
  }

  /** Encrypt + relay a wire record, and persist a (possibly lighter) store
   *  record to our own vault log. Resolves with the delivery ack. */
  async function sendWire(partner, wireRecord, storeRecord) {
    const key = await keyForPartner(partner);
    const envelope = await WOCrypto.encryptBytesToB64(
      key,
      enc.encode(JSON.stringify(wireRecord)),
    );
    const clientMsgId = wireRecord.id;
    const ackPromise = new Promise((resolve) => {
      pendingAcks.set(clientMsgId, resolve);
      setTimeout(() => {
        if (pendingAcks.has(clientMsgId)) {
          pendingAcks.delete(clientMsgId);
          resolve({ ok: false, error: 'timeout' });
        }
      }, 15000);
    });
    const payload = { to: partner, envelope, clientMsgId };
    if (!wsSend('send', payload)) outbox.push(payload);
    await appendToLog(partner, storeRecord);
    return ackPromise;
  }

  /** Send a text message. Returns the stored record. */
  async function sendText(partner, text) {
    const clean = WOUtil.chatTextValid(text);
    if (!clean) throw new Error(deps.t('chat_err_empty'));
    const record = {
      id: rid(),
      from: me,
      to: partner,
      ts: Date.now(),
      type: 'text',
      text: clean,
    };
    const store = { ...record, dir: 'out' };
    const ack = await sendWire(partner, record, store);
    return { ...store, delivered: !!(ack && ack.delivered) };
  }

  /**
   * Send an attachment (image or arbitrary vault/file bytes). The bytes are
   * stored in our own vault (encrypted with the VK) and referenced by path in
   * our log; the wire copy carries the bytes so the recipient can reconstruct
   * their own encrypted copy.
   */
  async function sendAttachment(partner, att) {
    const id = rid();
    const ext = safeExt(att.name, att.mime);
    const path = WOUtil.chatImagesDir(partner) + '/' + id + '.' + ext;
    await deps.saveAttachment(path, att.bytes, att.mime);
    const base = {
      id,
      from: me,
      to: partner,
      ts: Date.now(),
      type: att.kind === 'image' ? 'image' : 'file',
      name: att.name,
      mime: att.mime,
      size: att.bytes.length,
    };
    const wire = { ...base, data: WOCrypto.bytesToB64(att.bytes) };
    const store = { ...base, imgPath: path, dir: 'out' };
    const ack = await sendWire(partner, wire, store);
    return { ...store, delivered: !!(ack && ack.delivered) };
  }

  function sendTyping(partner) {
    wsSend('typing', { to: partner });
  }

  // --- block list -----------------------------------------------------------

  /** Usernames the current user has blocked. */
  async function listBlocks() {
    const res = await deps.api('GET', '/api/chat/blocks');
    return (res && res.blocked) || [];
  }

  /** Block a username so they can no longer reach this user. */
  async function blockUser(username) {
    const u = WOUtil.sanitizeChatUsername(username);
    if (!u) throw new Error(deps.t('chat_err_bad_username'));
    await deps.api('POST', '/api/chat/blocks', { username: u });
    return u;
  }

  /** Unblock a previously blocked username. */
  async function unblockUser(username) {
    const u = WOUtil.sanitizeChatUsername(username);
    if (!u) return;
    await deps.api(
      'DELETE',
      '/api/chat/blocks/' + encodeURIComponent(u),
    );
  }

  // --- receiving ------------------------------------------------------------

  async function onIncoming(data) {
    const partner = WOUtil.sanitizeChatUsername(data && data.from);
    if (!partner || !data.envelope) return;
    // A partner we have no cached log for is a brand-new conversation: its vault
    // folder is about to be created by appendToLog, but the file tree the user
    // sees will not reflect it until something refreshes. Remember this so we can
    // tell the app to surface the new conversation (previously the user had to
    // reload the page before a first message showed up).
    const isNewConversation = !logs.has(partner) && !partnerKeys.has(partner);
    const key = await keyForPartner(partner);
    let record;
    try {
      const bytes = await WOCrypto.decryptB64ToBytes(key, data.envelope);
      record = JSON.parse(dec.decode(bytes));
    } catch (e) {
      console.warn('chat: undecryptable message from', partner);
      return;
    }
    if (!record || typeof record !== 'object') return;
    record.from = partner;
    record.to = me;
    record.ts = Number(record.ts) || Number(data.ts) || Date.now();
    record.dir = 'in';

    // Persist any attachment into our own vault, then keep only a path in the log.
    if ((record.type === 'image' || record.type === 'file') && record.data) {
      try {
        const bytes = WOCrypto.b64ToBytes(record.data);
        const ext = safeExt(record.name, record.mime);
        const path = WOUtil.chatImagesDir(partner) + '/' + record.id + '.' + ext;
        await deps.saveAttachment(path, bytes, record.mime);
        record.imgPath = path;
      } catch (e) {
        console.warn('chat: failed to store attachment', e);
      }
    }
    delete record.data;

    await appendToLog(partner, record);
    messageListeners.forEach((cb) =>
      cb(partner, record, { queued: !!data.queued }),
    );
    maybeNotify(partner, record);
    maybeSound(partner);
    // Reveal a first-ever conversation in real time: let the app refresh its
    // file tree / launcher so the new chat appears without a page reload.
    if (isNewConversation && deps.onNewConversation) {
      try {
        deps.onNewConversation(partner, record);
      } catch {
        /* best effort — never let UI wiring break message receipt */
      }
    }
  }

  // --- vault persistence ----------------------------------------------------

  /** Serialize appends per partner so version-based writes never race. */
  function withLogLock(partner, fn) {
    const prev = logLocks.get(partner) || Promise.resolve();
    const next = prev.then(fn, fn);
    logLocks.set(
      partner,
      next.catch(() => {}),
    );
    return next;
  }

  async function loadLog(partner) {
    if (logs.has(partner)) return logs.get(partner);
    let text = '';
    let version = null;
    try {
      const data = await deps.api(
        'GET',
        '/api/file?path=' + encodeURIComponent(WOUtil.chatFilePath(partner)),
      );
      const vk = await deps.getVaultKey();
      text = data.content
        ? await WOCrypto.decryptB64ToTextMaybe(vk, data.content)
        : '';
      version = data.version;
    } catch {
      text = '';
      version = null;
    }
    const st = { text, version };
    logs.set(partner, st);
    return st;
  }

  function appendToLog(partner, record) {
    return withLogLock(partner, async () => {
      const st = await loadLog(partner);
      st.text = WOUtil.chatAppendLine(st.text, record);
      const vk = await deps.getVaultKey();
      const content = await WOCrypto.encryptTextToB64(vk, st.text);
      await deps.api('POST', '/api/folder', {
        path: WOUtil.chatDir(partner),
      }).catch(() => {});
      const res = await deps.api('PUT', '/api/file', {
        path: WOUtil.chatFilePath(partner),
        content,
        baseVersion: st.version || undefined,
      });
      st.version = res.version;
    });
  }

  /**
   * Rewrite a partner's log by running `mutator(records) -> newRecords` under
   * the write lock, then persisting the full result. Returns the new records.
   */
  function mutateLog(partner, mutator) {
    return withLogLock(partner, async () => {
      const st = await loadLog(partner);
      const records = WOUtil.chatParseLog(st.text);
      const next = mutator(records);
      st.text = next.length
        ? next.map((r) => WOUtil.chatSerializeLine(r)).join('\n') + '\n'
        : '';
      const vk = await deps.getVaultKey();
      const content = await WOCrypto.encryptTextToB64(vk, st.text);
      const res = await deps.api('PUT', '/api/file', {
        path: WOUtil.chatFilePath(partner),
        content,
        baseVersion: st.version || undefined,
      });
      st.version = res.version;
      return next;
    });
  }

  /** Delete a single message from the vault log; also removes its stored
   *  attachment file (best effort). Returns the removed record or null. */
  async function deleteMessage(partner, id) {
    let removed = null;
    await mutateLog(partner, (records) => {
      removed = records.find((r) => r.id === id) || null;
      return records.filter((r) => r.id !== id);
    });
    if (removed && removed.imgPath && deps.removeVaultPath) {
      deps.removeVaultPath(removed.imgPath).catch(() => {});
    }
    return removed;
  }

  /** Delete the whole conversation: its folder (chat file + attachments) in the
   *  user's own storage, plus cached keys/log. */
  async function clearChat(partner) {
    if (deps.removeVaultPath) {
      await deps.removeVaultPath(WOUtil.chatDir(partner));
    }
    logs.delete(partner);
    logLocks.delete(partner);
    partnerKeys.delete(partner);
  }

  /** Read the full history for a partner as records (used when a tab opens). */
  async function history(partner) {
    const st = await loadLog(partner);
    return WOUtil.chatParseLog(st.text).map((r) => ({
      ...r,
      dir: r.dir || (r.from === me ? 'out' : 'in'),
    }));
  }

  // --- notifications --------------------------------------------------------

  function notificationsSupported() {
    return typeof window.Notification !== 'undefined';
  }

  async function setNotificationsEnabled(on) {
    if (on && notificationsSupported() && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
    notifEnabled =
      !!on &&
      notificationsSupported() &&
      Notification.permission === 'granted';
    if (deps && deps.setNotifPref) deps.setNotifPref(!!on);
    return notifEnabled;
  }

  function getNotificationsEnabled() {
    return notifEnabled;
  }

  /** True when the user is focused on the window AND has this exact
   *  conversation open — the one case where an alert (notification or sound)
   *  is redundant because the message is already on screen. */
  function focusedOnPartner(partner) {
    return (
      document.hasFocus() &&
      !!(deps.activePartner && deps.activePartner() === partner)
    );
  }

  // --- sound ----------------------------------------------------------------

  function setSoundEnabled(on) {
    soundEnabled = !!on;
    if (deps && deps.setSoundPref) deps.setSoundPref(soundEnabled);
    return soundEnabled;
  }

  function getSoundEnabled() {
    return soundEnabled;
  }

  /** Short two-tone chime synthesised with the Web Audio API — no asset file, so
   *  it works offline and never hits the CSP. Best-effort: a suspended context
   *  (no user gesture yet) or an unsupported engine simply produces no sound. */
  function playSound() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const t0 = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t0);
      osc.frequency.setValueAtTime(1174.66, t0 + 0.11);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.14, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
      osc.start(t0);
      osc.stop(t0 + 0.34);
    } catch {
      /* audio can throw on locked/unsupported engines; ignore */
    }
  }

  function maybeSound(partner) {
    if (!soundEnabled) return;
    // Same redundancy rule as notifications: no beep for a chat you're watching.
    if (focusedOnPartner(partner)) return;
    playSound();
  }

  function maybeNotify(partner, record) {
    if (!notificationsSupported()) return;
    if (!notifEnabled || Notification.permission !== 'granted') {
      // Common silent case: enabled via a synced pref but this browser was never
      // granted permission. Say so instead of failing quietly.
      console.debug(
        'chat: notification skipped — not enabled or permission not granted' +
          ' (permission=' +
          (notificationsSupported() ? Notification.permission : 'unsupported') +
          ')',
      );
      return;
    }
    // Suppress only when the user is actively looking at THIS conversation with
    // the window focused. If the browser window is not focused (another app or
    // window on top) or they are on a different view, notify — `document.hidden`
    // alone is not enough because a merely-unfocused tab is still "visible".
    if (focusedOnPartner(partner)) {
      console.debug(
        'chat: notification skipped — you are focused on this conversation',
      );
      return;
    }
    const body =
      record.type === 'text'
        ? record.text
        : deps.t(record.type === 'image' ? 'chat_sent_image' : 'chat_sent_file');
    try {
      const n = new Notification(deps.t('chat_notif_title', { user: partner }), {
        body: (body || '').slice(0, 120),
        tag: 'wo-chat-' + partner,
      });
      n.onclick = () => {
        window.focus();
        if (deps.openChat) deps.openChat(partner);
        n.close();
      };
    } catch {
      /* notification construction can throw on some engines; ignore */
    }
  }

  // --- helpers + listeners --------------------------------------------------

  const MIME_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
  };

  function safeExt(name, mime) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
    if (m) return m[1].toLowerCase();
    if (mime && MIME_EXT[mime]) return MIME_EXT[mime];
    return 'bin';
  }

  function emitStatus(s) {
    statusListeners.forEach((cb) => cb(s));
  }

  function onMessage(cb) {
    messageListeners.add(cb);
    return () => messageListeners.delete(cb);
  }
  function onStatus(cb) {
    statusListeners.add(cb);
    return () => statusListeners.delete(cb);
  }
  function onTyping(cb) {
    typingListeners.add(cb);
    return () => typingListeners.delete(cb);
  }
  function status() {
    return wsReady ? 'online' : 'offline';
  }

  function disconnect() {
    closedByUs = true;
    clearTimeout(reconnectTimer);
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  window.WOChat = {
    init,
    isReady,
    verifyPartner,
    sendText,
    sendAttachment,
    sendTyping,
    deleteMessage,
    clearChat,
    listBlocks,
    blockUser,
    unblockUser,
    history,
    onMessage,
    onStatus,
    onTyping,
    status,
    setNotificationsEnabled,
    getNotificationsEnabled,
    notificationsSupported,
    setSoundEnabled,
    getSoundEnabled,
    disconnect,
    myUsername: () => me,
  };
})();
