'use strict';

/**
 * Zero-knowledge client-side crypto for websidian.
 *
 * Nothing in here ever leaves the browser in plaintext. The vault key (VK) is a
 * random 256-bit AES-GCM key generated once at registration. It is wrapped
 * (encrypted) with a key derived from the user's password (PBKDF2-SHA256) and,
 * separately, with a key derived from a one-time recovery key. The server only
 * ever stores those wrapped copies and can never unwrap them.
 *
 * File contents and attachments are encrypted with VK using AES-256-GCM. The
 * on-the-wire / at-rest blob format matches the server's documented layout:
 *
 *     MAGIC("WOE1") | iv(12 bytes) | ciphertext-with-gcm-tag
 *
 * WebCrypto's AES-GCM appends the 16-byte authentication tag to the ciphertext,
 * so `ciphertext-with-gcm-tag` already contains it.
 *
 * Uses only the native Web Crypto API — no third-party crypto, no bundler.
 */
(function () {
  const MAGIC = new Uint8Array([0x57, 0x4f, 0x45, 0x31]); // "WOE1"
  const IV_LEN = 12;
  const KEY_LEN = 32; // AES-256
  const SALT_LEN = 16;
  // PBKDF2 work factor. High enough to make offline guessing of the wrapped
  // vault key expensive; runs once per login/registration so cost is acceptable.
  const PBKDF2_ITERS = 600000;

  const subtle = window.crypto && window.crypto.subtle;
  if (!subtle) {
    // Surfaced loudly: without WebCrypto the app cannot encrypt anything.
    console.error('Web Crypto API unavailable; secure context (HTTPS) required.');
  }

  // --- encoding helpers -----------------------------------------------------

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function bytesToB64(bytes) {
    let bin = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const chunk = 0x8000;
    for (let i = 0; i < arr.length; i += chunk) {
      bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function concat() {
    let total = 0;
    for (let i = 0; i < arguments.length; i++) total += arguments[i].length;
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < arguments.length; i++) {
      out.set(arguments[i], off);
      off += arguments[i].length;
    }
    return out;
  }

  function randomBytes(n) {
    const a = new Uint8Array(n);
    window.crypto.getRandomValues(a);
    return a;
  }

  // --- key derivation & wrapping --------------------------------------------

  /**
   * Derive a 256-bit AES-GCM wrapping key from a passphrase + salt using
   * PBKDF2-SHA256. Returns a non-extractable CryptoKey usable only to
   * wrap/unwrap the vault key.
   */
  async function deriveWrappingKey(passphrase, saltB64) {
    const salt = b64ToBytes(saltB64);
    const baseKey = await subtle.importKey(
      'raw',
      enc.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /** Generate a fresh random vault key as raw bytes. */
  function generateVaultKey() {
    return randomBytes(KEY_LEN);
  }

  /** Fresh random salt, base64-encoded, for a KDF. */
  function generateSalt() {
    return bytesToB64(randomBytes(SALT_LEN));
  }

  /**
   * Wrap (encrypt) the raw vault-key bytes with a derived wrapping key.
   * Returns a base64 blob `MAGIC | iv | ciphertext+tag`.
   */
  async function wrapVaultKey(vaultKeyBytes, wrappingKey) {
    const iv = randomBytes(IV_LEN);
    const ct = await subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      vaultKeyBytes,
    );
    return bytesToB64(concat(MAGIC, iv, new Uint8Array(ct)));
  }

  /** Unwrap a base64 blob produced by {@link wrapVaultKey}; returns raw bytes. */
  async function unwrapVaultKey(wrappedB64, wrappingKey) {
    const blob = b64ToBytes(wrappedB64);
    assertMagic(blob);
    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const ct = blob.subarray(MAGIC.length + IV_LEN);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ct);
    return new Uint8Array(pt);
  }

  /** Import raw vault-key bytes into a non-extractable AES-GCM CryptoKey. */
  function importVaultKey(vaultKeyBytes) {
    return subtle.importKey(
      'raw',
      vaultKeyBytes,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /**
   * True when `blob` carries the websidian ciphertext header. Used to tell
   * encrypted blobs apart from legacy plaintext written before E2E encryption
   * was enabled, without throwing.
   */
  function hasMagic(blob) {
    const arr = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    return (
      arr.length >= MAGIC.length + IV_LEN &&
      arr[0] === MAGIC[0] &&
      arr[1] === MAGIC[1] &&
      arr[2] === MAGIC[2] &&
      arr[3] === MAGIC[3]
    );
  }

  function assertMagic(blob) {
    if (!hasMagic(blob)) {
      throw new Error('Not a websidian encrypted blob.');
    }
  }

  // --- content encryption (with an imported VK CryptoKey) -------------------

  /** Encrypt raw bytes with a vault CryptoKey. Returns `MAGIC | iv | ct+tag`. */
  async function encryptBytes(vaultCryptoKey, bytes) {
    const iv = randomBytes(IV_LEN);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, vaultCryptoKey, bytes);
    return concat(MAGIC, iv, new Uint8Array(ct));
  }

  /** Decrypt a blob produced by {@link encryptBytes}; returns raw bytes. */
  async function decryptBytes(vaultCryptoKey, blob) {
    const arr = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    assertMagic(arr);
    const iv = arr.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const ct = arr.subarray(MAGIC.length + IV_LEN);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, vaultCryptoKey, ct);
    return new Uint8Array(pt);
  }

  async function encryptTextToB64(vaultCryptoKey, text) {
    return bytesToB64(await encryptBytes(vaultCryptoKey, enc.encode(text)));
  }

  async function decryptB64ToText(vaultCryptoKey, b64) {
    return dec.decode(await decryptBytes(vaultCryptoKey, b64ToBytes(b64)));
  }

  async function encryptBytesToB64(vaultCryptoKey, bytes) {
    return bytesToB64(await encryptBytes(vaultCryptoKey, bytes));
  }

  async function decryptB64ToBytes(vaultCryptoKey, b64) {
    return decryptBytes(vaultCryptoKey, b64ToBytes(b64));
  }

  /**
   * Decrypt bytes that may or may not be encrypted. Files written before E2E
   * encryption was enabled are stored as plaintext (no MAGIC header) and are
   * returned untouched. A few legacy files were accidentally encrypted more
   * than once, so we peel every authenticated WOE1 layer: each `decryptBytes`
   * verifies the AES-GCM tag, so we only recurse when the inner bytes really
   * are another valid ciphertext for this key (a coincidental WOE1 prefix in
   * genuine plaintext fails authentication and stops the loop).
   */
  async function decryptBytesMaybe(vaultCryptoKey, blob) {
    let arr = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    while (hasMagic(arr)) {
      let next;
      try {
        next = await decryptBytes(vaultCryptoKey, arr);
      } catch {
        break; // not actually a layer for this key: keep what we have
      }
      arr = next;
    }
    return arr;
  }

  /** Like {@link decryptB64ToText} but tolerant of legacy plaintext content. */
  async function decryptB64ToTextMaybe(vaultCryptoKey, b64) {
    return dec.decode(await decryptBytesMaybe(vaultCryptoKey, b64ToBytes(b64)));
  }

  // --- recovery key formatting ----------------------------------------------

  /**
   * Generate a human-transcribable recovery key: groups of base32-ish chars.
   * 20 bytes -> 32 chars in 8 groups of 4, e.g. "ABCD-EFGH-...". This is the
   * secret shown once to the user; its bytes feed the recovery KDF.
   */
  function generateRecoveryKey() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
    const raw = randomBytes(20);
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      out += alphabet[raw[i] % alphabet.length];
    }
    return out.match(/.{1,4}/g).join('-');
  }

  /** Normalise a user-entered recovery key (strip spaces/dashes, uppercase). */
  function normalizeRecoveryKey(input) {
    return String(input || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Produce the full client key bundle for a NEW account: a random vault key
   * wrapped under both the password and a freshly generated recovery key.
   * Returns the recovery key (to show once) plus the server-opaque material.
   */
  async function createVaultKeyMaterial(password) {
    const vaultKeyBytes = generateVaultKey();
    const recoveryKey = generateRecoveryKey();

    const kdfSalt = generateSalt();
    const recoverySalt = generateSalt();

    const pwKey = await deriveWrappingKey(password, kdfSalt);
    const recKey = await deriveWrappingKey(
      normalizeRecoveryKey(recoveryKey),
      recoverySalt,
    );

    const wrappedVaultKey = await wrapVaultKey(vaultKeyBytes, pwKey);
    const recoveryWrappedVaultKey = await wrapVaultKey(vaultKeyBytes, recKey);

    // Adopt the freshly minted key into this page session so the user can start
    // creating encrypted notes immediately after registration, then zero our
    // local copy (best-effort hygiene).
    setSession(vaultKeyBytes);
    await adoptVaultKey(vaultKeyBytes);
    vaultKeyBytes.fill(0);

    return {
      recoveryKey,
      material: {
        kdfSalt,
        recoverySalt,
        wrappedVaultKey,
        recoveryWrappedVaultKey,
      },
    };
  }

  /**
   * Unwrap the vault key from the password + stored salt, returning an imported
   * non-extractable CryptoKey ready for content encryption/decryption.
   */
  async function unlockVaultKey(password, kdfSalt, wrappedVaultKey) {
    const pwKey = await deriveWrappingKey(password, kdfSalt);
    const vaultKeyBytes = await unwrapVaultKey(wrappedVaultKey, pwKey);
    setSession(vaultKeyBytes);
    const cryptoKey = await adoptVaultKey(vaultKeyBytes);
    vaultKeyBytes.fill(0);
    return cryptoKey;
  }

  /**
   * Recover the vault key from the one-time recovery key + stored recovery
   * salt. Used when the password is lost. Returns an imported CryptoKey.
   */
  async function recoverVaultKey(recoveryKey, recoverySalt, recoveryWrappedVaultKey) {
    const recKey = await deriveWrappingKey(
      normalizeRecoveryKey(recoveryKey),
      recoverySalt,
    );
    const vaultKeyBytes = await unwrapVaultKey(recoveryWrappedVaultKey, recKey);
    setSession(vaultKeyBytes);
    const cryptoKey = await adoptVaultKey(vaultKeyBytes);
    vaultKeyBytes.fill(0);
    return cryptoKey;
  }

  /**
   * Re-wrap the existing vault key under a NEW password (used on password
   * change). Unwraps with the old password, then wraps with a fresh salt +
   * new-password-derived key. The vault key itself never changes, so the
   * encrypted vault does not need re-encryption.
   */
  async function rewrapForNewPassword(
    oldPassword,
    oldKdfSalt,
    wrappedVaultKey,
    newPassword,
  ) {
    const oldKey = await deriveWrappingKey(oldPassword, oldKdfSalt);
    const vaultKeyBytes = await unwrapVaultKey(wrappedVaultKey, oldKey);

    const newKdfSalt = generateSalt();
    const newKey = await deriveWrappingKey(newPassword, newKdfSalt);
    const newWrappedVaultKey = await wrapVaultKey(vaultKeyBytes, newKey);
    vaultKeyBytes.fill(0);

    return { newKdfSalt, newWrappedVaultKey };
  }

  // --- in-session vault key holder ------------------------------------------
  //
  // The vault key lives only in the browser. To survive a page reload within
  // the same tab (without re-prompting for the password) we cache the raw key
  // bytes in sessionStorage, base64-encoded. sessionStorage is per-tab and is
  // cleared when the tab closes; we also clear it explicitly on logout. This is
  // a deliberate trade-off: the key is briefly at rest in the tab's storage,
  // but never leaves the browser and never reaches the server.

  const SESSION_KEY = 'wo.vk';
  let activeVaultKey = null; // imported CryptoKey for this page's lifetime

  function setSession(vaultKeyBytes) {
    try {
      sessionStorage.setItem(SESSION_KEY, bytesToB64(vaultKeyBytes));
    } catch (e) {
      /* storage may be unavailable (private mode quota); in-memory still works */
    }
  }

  /** Import and cache the active vault key for this page from raw bytes. */
  async function adoptVaultKey(vaultKeyBytes) {
    activeVaultKey = await importVaultKey(vaultKeyBytes);
    return activeVaultKey;
  }

  /**
   * Return the active vault CryptoKey, restoring it from sessionStorage if this
   * is a fresh page load. Returns null if no key is available (must log in).
   */
  async function getVaultKey() {
    if (activeVaultKey) return activeVaultKey;
    let b64;
    try {
      b64 = sessionStorage.getItem(SESSION_KEY);
    } catch (e) {
      b64 = null;
    }
    if (!b64) return null;
    const bytes = b64ToBytes(b64);
    const key = await adoptVaultKey(bytes);
    bytes.fill(0);
    return key;
  }

  function hasVaultKey() {
    if (activeVaultKey) return true;
    try {
      return !!sessionStorage.getItem(SESSION_KEY);
    } catch (e) {
      return false;
    }
  }

  /** Forget the vault key everywhere (logout). */
  function clearVaultKey() {
    activeVaultKey = null;
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  window.WOCrypto = {
    // lifecycle
    createVaultKeyMaterial,
    unlockVaultKey,
    recoverVaultKey,
    rewrapForNewPassword,
    importVaultKey,
    // in-session key holder
    getVaultKey,
    hasVaultKey,
    clearVaultKey,
    // content
    encryptTextToB64,
    decryptB64ToText,
    encryptBytesToB64,
    decryptB64ToBytes,
    encryptBytes,
    decryptBytes,
    decryptBytesMaybe,
    decryptB64ToTextMaybe,
    hasMagic,
    // recovery
    generateRecoveryKey,
    normalizeRecoveryKey,
    // utils
    bytesToB64,
    b64ToBytes,
  };
})();
