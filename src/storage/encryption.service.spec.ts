import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

function makeService(options: {
  enabled: boolean;
  key?: string;
  jwtSecret?: string;
}): EncryptionService {
  const config = {
    get: jest.fn().mockReturnValue({
      jwtSecret: options.jwtSecret ?? 'jwt-secret',
      encryption: { enabled: options.enabled, key: options.key ?? '' },
    }),
  } as unknown as ConfigService;
  return new EncryptionService(config);
}

describe('EncryptionService', () => {
  describe('enabled with a dedicated key', () => {
    const service = makeService({ enabled: true, key: 'my-encryption-key' });

    it('reports enabled', () => {
      expect(service.isEnabled).toBe(true);
    });

    it('round-trips a value', () => {
      const encrypted = service.encryptString('totp-secret-value');
      expect(encrypted).not.toBe('totp-secret-value');
      expect(service.decryptString(encrypted)).toBe('totp-secret-value');
    });

    it('produces a fresh IV per encryption (no deterministic output)', () => {
      const a = service.encryptString('same');
      const b = service.encryptString('same');
      expect(a).not.toBe(b);
      expect(service.decryptString(a)).toBe('same');
      expect(service.decryptString(b)).toBe('same');
    });

    it('handles unicode', () => {
      const value = 'käse 🧀 → ключ';
      expect(service.decryptString(service.encryptString(value))).toBe(value);
    });

    it('passes null and undefined through as null', () => {
      expect(service.encryptString(null)).toBeNull();
      expect(service.encryptString(undefined)).toBeNull();
      expect(service.decryptString(null)).toBeNull();
      expect(service.decryptString(undefined)).toBeNull();
    });

    it('passes empty strings through unchanged', () => {
      expect(service.encryptString('')).toBe('');
      expect(service.decryptString('')).toBe('');
    });

    it('returns legacy plaintext values unchanged on decrypt', () => {
      expect(service.decryptString('plain-old-secret')).toBe(
        'plain-old-secret',
      );
    });

    it('returns short/foreign base64 unchanged (no magic prefix)', () => {
      const foreign = Buffer.from('hello world').toString('base64');
      expect(service.decryptString(foreign)).toBe(foreign);
    });

    it('emits the versioned magic header', () => {
      const encrypted = service.encryptString('x');
      const blob = Buffer.from(encrypted as string, 'base64');
      expect(blob.subarray(0, 4).toString('utf8')).toBe('WOE1');
    });

    it('fails on tampered ciphertext (GCM auth)', () => {
      const encrypted = service.encryptString('secret') as string;
      const blob = Buffer.from(encrypted, 'base64');
      blob[blob.length - 1] ^= 0xff; // flip a ciphertext bit
      expect(() => service.decryptString(blob.toString('base64'))).toThrow();
    });
  });

  describe('key derivation', () => {
    it('derives from JWT_SECRET when no ENCRYPTION_KEY is set', () => {
      const a = makeService({ enabled: true, key: '', jwtSecret: 's1' });
      const encrypted = a.encryptString('value');
      // Same JWT secret -> same derived key -> decryptable.
      const b = makeService({ enabled: true, key: '', jwtSecret: 's1' });
      expect(b.decryptString(encrypted)).toBe('value');
      // Different secret -> different key -> auth failure.
      const c = makeService({ enabled: true, key: '', jwtSecret: 's2' });
      expect(() => c.decryptString(encrypted)).toThrow();
    });

    it('prefers ENCRYPTION_KEY over JWT_SECRET', () => {
      const a = makeService({ enabled: true, key: 'k', jwtSecret: 's1' });
      const encrypted = a.encryptString('value');
      const b = makeService({ enabled: true, key: 'k', jwtSecret: 'other' });
      expect(b.decryptString(encrypted)).toBe('value');
    });
  });

  describe('disabled', () => {
    const service = makeService({ enabled: false });

    it('reports disabled', () => {
      expect(service.isEnabled).toBe(false);
    });

    it('passes values through unchanged in both directions', () => {
      expect(service.encryptString('secret')).toBe('secret');
      expect(service.decryptString('secret')).toBe('secret');
      expect(service.encryptString(null)).toBeNull();
      expect(service.decryptString(undefined)).toBeNull();
    });
  });
});
