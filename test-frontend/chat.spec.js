'use strict';

// Ensure a Web Crypto implementation with subtle is present before crypto.js
// loads (jsdom does not always expose one). Node's webcrypto has everything we
// need for the ECDH round-trip below.
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

const { webcrypto } = require('crypto');
if (typeof window !== 'undefined' && (!window.crypto || !window.crypto.subtle)) {
  try {
    Object.defineProperty(window, 'crypto', {
      value: webcrypto,
      configurable: true,
    });
  } catch {
    /* ignore — the guard below skips crypto tests if it stayed unavailable */
  }
}

const WOUtil = require('../public/js/wo-util');
require('../public/js/crypto.js'); // attaches window.WOCrypto
const WOCrypto = window.WOCrypto;
const hasSubtle = !!(window.crypto && window.crypto.subtle);
const cryptoIt = hasSubtle ? it : it.skip;

describe('chat path helpers', () => {
  it('builds the conversation folder + file + images dir', () => {
    expect(WOUtil.chatDir('bob')).toBe('chats/bob');
    expect(WOUtil.chatFilePath('bob')).toBe('chats/bob/bob.chat');
    expect(WOUtil.chatImagesDir('bob')).toBe('chats/bob/chat-images');
  });

  it('recognises + extracts the partner from a chat path', () => {
    expect(WOUtil.partnerFromChatPath('chats/bob/bob.chat')).toBe('bob');
    expect(WOUtil.isChatPath('chats/bob/bob.chat')).toBe(true);
  });

  it('rejects non-chat or malformed paths', () => {
    expect(WOUtil.partnerFromChatPath('chats/bob/other.chat')).toBe('');
    expect(WOUtil.partnerFromChatPath('chats/bob')).toBe('');
    expect(WOUtil.partnerFromChatPath('notes/bob/bob.chat')).toBe('');
    expect(WOUtil.isChatPath('notes/x.md')).toBe(false);
  });
});

describe('sanitizeChatUsername', () => {
  it('lowercases + accepts valid handles', () => {
    expect(WOUtil.sanitizeChatUsername('Bob_99')).toBe('bob_99');
    expect(WOUtil.sanitizeChatUsername('  Alice-1 ')).toBe('alice-1');
  });
  it('rejects too short / illegal characters', () => {
    expect(WOUtil.sanitizeChatUsername('ab')).toBe('');
    expect(WOUtil.sanitizeChatUsername('has space')).toBe('');
    expect(WOUtil.sanitizeChatUsername('bad!')).toBe('');
    expect(WOUtil.sanitizeChatUsername('')).toBe('');
  });
});

describe('chat text validation', () => {
  it('trims and returns valid text', () => {
    expect(WOUtil.chatTextValid('  hi  ')).toBe('hi');
  });
  it('rejects empty and over-long text', () => {
    expect(WOUtil.chatTextValid('   ')).toBe('');
    expect(WOUtil.chatTextValid('x'.repeat(8001))).toBe('');
  });
});

describe('append-only log', () => {
  it('appends and round-trips records as JSON-lines', () => {
    let text = '';
    text = WOUtil.chatAppendLine(text, { id: '1', type: 'text', text: 'a' });
    text = WOUtil.chatAppendLine(text, { id: '2', type: 'text', text: 'b' });
    const recs = WOUtil.chatParseLog(text);
    expect(recs.map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('skips blank and corrupt lines without throwing', () => {
    const text = '{"id":"1"}\n\nnot json\n{"id":"2"}\n';
    const recs = WOUtil.chatParseLog(text);
    expect(recs.map((r) => r.id)).toEqual(['1', '2']);
  });

  it('never produces a double newline between records', () => {
    let text = WOUtil.chatAppendLine('', { id: '1' });
    text = WOUtil.chatAppendLine(text, { id: '2' });
    expect(text.includes('\n\n')).toBe(false);
  });
});

describe('ECDH conversation key (crypto.js)', () => {
  cryptoIt('two users derive the same key; A encrypts, B decrypts', async () => {
    const a = await WOCrypto.generateIdentityKeyPair();
    const b = await WOCrypto.generateIdentityKeyPair();
    const aPub = await WOCrypto.exportPublicKeySpkiB64(a);
    const bPub = await WOCrypto.exportPublicKeySpkiB64(b);

    const keyA = await WOCrypto.deriveChatKey(a.privateKey, bPub);
    const keyB = await WOCrypto.deriveChatKey(b.privateKey, aPub);

    const bytes = new TextEncoder().encode('secret message');
    const envelope = await WOCrypto.encryptBytesToB64(keyA, bytes);
    const out = await WOCrypto.decryptB64ToBytes(keyB, envelope);
    expect(new TextDecoder().decode(out)).toBe('secret message');
  });

  cryptoIt('private key wraps with the VK and still derives correctly', async () => {
    const vk = await WOCrypto.importVaultKey(new Uint8Array(32));
    const a = await WOCrypto.generateIdentityKeyPair();
    const b = await WOCrypto.generateIdentityKeyPair();
    const wrapped = await WOCrypto.wrapPrivateKey(vk, a);
    const aPriv = await WOCrypto.unwrapPrivateKey(vk, wrapped);

    const bPub = await WOCrypto.exportPublicKeySpkiB64(b);
    const aPub = await WOCrypto.exportPublicKeySpkiB64(a);
    const keyA = await WOCrypto.deriveChatKey(aPriv, bPub);
    const keyB = await WOCrypto.deriveChatKey(b.privateKey, aPub);

    const envelope = await WOCrypto.encryptBytesToB64(
      keyB,
      new TextEncoder().encode('hi'),
    );
    const out = await WOCrypto.decryptB64ToBytes(keyA, envelope);
    expect(new TextDecoder().decode(out)).toBe('hi');
  });
});
