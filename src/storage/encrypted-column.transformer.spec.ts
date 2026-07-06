import { ConfigService } from '@nestjs/config';
import {
  encryptedColumn,
  registerColumnEncryptor,
} from './encrypted-column.transformer';
import { EncryptionService } from './encryption.service';

function makeService(enabled: boolean): EncryptionService {
  const config = {
    get: jest.fn().mockReturnValue({
      jwtSecret: 'jwt-secret',
      encryption: { enabled, key: 'transformer-test-key' },
    }),
  } as unknown as ConfigService;
  return new EncryptionService(config);
}

// The transformer holds the encryptor in module-level state, so the
// "unregistered" behaviour must be asserted before any registration.
describe('encryptedColumn (before registration)', () => {
  it('is a no-op passthrough', () => {
    expect(encryptedColumn.to('value')).toBe('value');
    expect(encryptedColumn.from('value')).toBe('value');
  });

  it('normalises null/undefined to null', () => {
    expect(encryptedColumn.to(null)).toBeNull();
    expect(encryptedColumn.to(undefined)).toBeNull();
    expect(encryptedColumn.from(null)).toBeNull();
    expect(encryptedColumn.from(undefined)).toBeNull();
  });
});

describe('encryptedColumn (registered)', () => {
  beforeAll(() => {
    registerColumnEncryptor(makeService(true));
  });

  it('encrypts on write and decrypts on read', () => {
    const stored = encryptedColumn.to('totp-secret') as string;
    expect(stored).not.toBe('totp-secret');
    expect(encryptedColumn.from(stored)).toBe('totp-secret');
  });

  it('still passes null/undefined through as null', () => {
    expect(encryptedColumn.to(null)).toBeNull();
    expect(encryptedColumn.from(undefined)).toBeNull();
  });

  it('reads legacy plaintext values unchanged', () => {
    expect(encryptedColumn.from('legacy-plaintext')).toBe('legacy-plaintext');
  });

  it('is a passthrough when the registered service is disabled', () => {
    registerColumnEncryptor(makeService(false));
    expect(encryptedColumn.to('value')).toBe('value');
    expect(encryptedColumn.from('value')).toBe('value');
    // Restore an enabled encryptor for any later suites in this file.
    registerColumnEncryptor(makeService(true));
  });
});
