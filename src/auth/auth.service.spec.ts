import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService, VaultKeyMaterial } from './auth.service';

const KEYS: VaultKeyMaterial = {
  kdfSalt: 'kdf-salt',
  recoverySalt: 'recovery-salt',
  wrappedVaultKey: 'wrapped-key',
  recoveryWrappedVaultKey: 'recovery-wrapped-key',
};

describe('AuthService', () => {
  let users: jest.Mocked<
    Pick<
      UsersService,
      'count' | 'findByUsername' | 'findById' | 'create' | 'save'
    >
  >;
  let appConfig: {
    allowRegistration: boolean;
    maxRegistrations: number;
    jwtSecret: string;
    jwtExpiresIn: string;
  };
  let service: AuthService;

  const makeUser = async (overrides: Partial<User> = {}): Promise<User> => {
    const user = new User();
    user.id = 1;
    user.username = 'alice';
    user.storageId = 'storage-1';
    user.passwordHash = await bcrypt.hash('correct horse', 4);
    user.totpSecret = authenticator.generateSecret();
    user.totpEnabled = true;
    user.pendingTotpSecret = null;
    return Object.assign(user, overrides);
  };

  beforeEach(() => {
    users = {
      count: jest.fn(),
      findByUsername: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };
    appConfig = {
      allowRegistration: true,
      maxRegistrations: 0,
      jwtSecret: 'test-secret',
      jwtExpiresIn: '7d',
    };
    const config = {
      get: jest.fn().mockImplementation(() => appConfig),
    } as unknown as ConfigService;
    service = new AuthService(
      users as unknown as UsersService,
      new JwtService(),
      config,
    );
  });

  describe('register', () => {
    beforeEach(() => {
      users.findByUsername.mockResolvedValue(null);
      users.create.mockImplementation(async (data) =>
        Object.assign(new User(), { id: 1 }, data),
      );
    });

    it('rejects when registration is disabled', async () => {
      appConfig.allowRegistration = false;
      await expect(service.register('alice', 'pw', KEYS)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects when the registration cap is reached', async () => {
      appConfig.maxRegistrations = 2;
      users.count.mockResolvedValue(2);
      await expect(service.register('alice', 'pw', KEYS)).rejects.toThrow(
        'Registration is currently full.',
      );
    });

    it('allows registration below the cap', async () => {
      appConfig.maxRegistrations = 2;
      users.count.mockResolvedValue(1);
      await expect(
        service.register('alice', 'pw', KEYS),
      ).resolves.toBeDefined();
    });

    it('rejects duplicate usernames', async () => {
      users.findByUsername.mockResolvedValue(await makeUser());
      await expect(service.register('Alice', 'pw', KEYS)).rejects.toThrow(
        ConflictException,
      );
      expect(users.findByUsername).toHaveBeenCalledWith('alice');
    });

    it('creates the user with a hashed password and stored key material', async () => {
      const result = await service.register('Alice', 'my-password', KEYS);

      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'alice',
          kdfSalt: KEYS.kdfSalt,
          recoverySalt: KEYS.recoverySalt,
          wrappedVaultKey: KEYS.wrappedVaultKey,
          recoveryWrappedVaultKey: KEYS.recoveryWrappedVaultKey,
        }),
      );
      const created = users.create.mock.calls[0][0] as {
        passwordHash: string;
        totpSecret: string;
      };
      expect(created.passwordHash).not.toBe('my-password');
      expect(await bcrypt.compare('my-password', created.passwordHash)).toBe(
        true,
      );
      expect(result.secret).toBe(created.totpSecret);
      expect(result.otpauthUrl).toContain('otpauth://totp/');
      expect(result.otpauthUrl).toContain('web-obsidian');
      expect(result.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe('validateCredentials', () => {
    it('rejects unknown usernames', async () => {
      users.findByUsername.mockResolvedValue(null);
      await expect(service.validateCredentials('ghost', 'pw')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a wrong password', async () => {
      users.findByUsername.mockResolvedValue(await makeUser());
      await expect(
        service.validateCredentials('alice', 'wrong'),
      ).rejects.toThrow('Invalid username or password.');
    });

    it('returns the user on success and lowercases the lookup', async () => {
      const user = await makeUser();
      users.findByUsername.mockResolvedValue(user);
      await expect(
        service.validateCredentials('ALICE', 'correct horse'),
      ).resolves.toBe(user);
      expect(users.findByUsername).toHaveBeenCalledWith('alice');
    });
  });

  describe('verifyTotp', () => {
    it('accepts a currently valid code and rejects garbage', async () => {
      const user = await makeUser();
      const code = authenticator.generate(user.totpSecret);
      expect(service.verifyTotp(user, code)).toBe(true);
      // Any 6-digit code other than the current one is rejected.
      const wrong = code === '000000' ? '111111' : '000000';
      expect(service.verifyTotp(user, wrong)).toBe(false);
      expect(service.verifyTotp(user, 'not-a-code')).toBe(false);
    });
  });

  describe('changePassword', () => {
    const rewrap = { kdfSalt: 'new-salt', wrappedVaultKey: 'new-wrapped' };

    it('rejects when the account no longer exists', async () => {
      users.findById.mockResolvedValue(null);
      await expect(
        service.changePassword(1, 'a', 'b', '000000', rewrap),
      ).rejects.toThrow('Account no longer exists.');
    });

    it('rejects a wrong current password', async () => {
      users.findById.mockResolvedValue(await makeUser());
      await expect(
        service.changePassword(1, 'wrong', 'new-pw', '000000', rewrap),
      ).rejects.toThrow('Current password is incorrect.');
    });

    it('rejects an invalid TOTP code', async () => {
      users.findById.mockResolvedValue(await makeUser());
      await expect(
        service.changePassword(1, 'correct horse', 'new-pw', 'bad', rewrap),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects reusing the current password', async () => {
      const user = await makeUser();
      users.findById.mockResolvedValue(user);
      const code = authenticator.generate(user.totpSecret);
      await expect(
        service.changePassword(
          1,
          'correct horse',
          'correct horse',
          code,
          rewrap,
        ),
      ).rejects.toThrow('The new password must be different');
    });

    it('stores the new hash and re-wrapped key material', async () => {
      const user = await makeUser();
      users.findById.mockResolvedValue(user);
      const code = authenticator.generate(user.totpSecret);

      await service.changePassword(1, 'correct horse', 'new-pw', code, rewrap);

      expect(await bcrypt.compare('new-pw', user.passwordHash)).toBe(true);
      expect(user.kdfSalt).toBe('new-salt');
      expect(user.wrappedVaultKey).toBe('new-wrapped');
      expect(users.save).toHaveBeenCalledWith(user);
    });
  });

  describe('beginTotpReset', () => {
    it('rejects when the account no longer exists', async () => {
      users.findById.mockResolvedValue(null);
      await expect(service.beginTotpReset(1, 'pw', '000000')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a wrong password', async () => {
      users.findById.mockResolvedValue(await makeUser());
      await expect(
        service.beginTotpReset(1, 'wrong', '000000'),
      ).rejects.toThrow('Current password is incorrect.');
    });

    it('rejects an invalid code from the existing authenticator', async () => {
      users.findById.mockResolvedValue(await makeUser());
      await expect(
        service.beginTotpReset(1, 'correct horse', 'bad'),
      ).rejects.toThrow('Incorrect code.');
    });

    it('stores a pending secret and returns enrolment details', async () => {
      const user = await makeUser();
      users.findById.mockResolvedValue(user);
      const code = authenticator.generate(user.totpSecret);

      const result = await service.beginTotpReset(1, 'correct horse', code);

      expect(user.pendingTotpSecret).toBe(result.secret);
      expect(result.secret).not.toBe(user.totpSecret);
      expect(users.save).toHaveBeenCalledWith(user);
      expect(result.otpauthUrl).toContain('otpauth://totp/');
      expect(result.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe('confirmTotpReset', () => {
    it('rejects when the account no longer exists', async () => {
      users.findById.mockResolvedValue(null);
      await expect(service.confirmTotpReset(1, '000000')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects when no reset is in progress', async () => {
      users.findById.mockResolvedValue(await makeUser());
      await expect(service.confirmTotpReset(1, '000000')).rejects.toThrow(
        'No authenticator reset in progress.',
      );
    });

    it('rejects an invalid code against the new secret', async () => {
      const pending = authenticator.generateSecret();
      users.findById.mockResolvedValue(
        await makeUser({ pendingTotpSecret: pending }),
      );
      await expect(service.confirmTotpReset(1, 'bad')).rejects.toThrow(
        'Incorrect code.',
      );
    });

    it('promotes the pending secret and clears it', async () => {
      const pending = authenticator.generateSecret();
      const user = await makeUser({
        pendingTotpSecret: pending,
        totpEnabled: false,
      });
      users.findById.mockResolvedValue(user);

      await service.confirmTotpReset(1, authenticator.generate(pending));

      expect(user.totpSecret).toBe(pending);
      expect(user.pendingTotpSecret).toBeNull();
      expect(user.totpEnabled).toBe(true);
      expect(users.save).toHaveBeenCalledWith(user);
    });
  });

  describe('confirmTotp', () => {
    it('rejects when the account no longer exists', async () => {
      users.findById.mockResolvedValue(null);
      await expect(service.confirmTotp(1, '000000')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an invalid code', async () => {
      users.findById.mockResolvedValue(await makeUser());
      await expect(service.confirmTotp(1, 'bad')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('marks TOTP enabled on first confirmation', async () => {
      const user = await makeUser({ totpEnabled: false });
      users.findById.mockResolvedValue(user);

      const result = await service.confirmTotp(
        1,
        authenticator.generate(user.totpSecret),
      );

      expect(result).toBe(user);
      expect(user.totpEnabled).toBe(true);
      expect(users.save).toHaveBeenCalledWith(user);
    });

    it('is idempotent: no save when already enabled', async () => {
      const user = await makeUser({ totpEnabled: true });
      users.findById.mockResolvedValue(user);

      await service.confirmTotp(1, authenticator.generate(user.totpSecret));

      expect(users.save).not.toHaveBeenCalled();
    });
  });

  describe('tokens', () => {
    const subject = { id: 7, username: 'alice', storageId: 'sid-7' };

    it('signs and verifies an auth token round-trip', () => {
      const token = service.signToken(subject, 'auth');
      const payload = service.verifyToken(token);
      expect(payload).toMatchObject({
        sub: 7,
        username: 'alice',
        storageId: 'sid-7',
        purpose: 'auth',
      });
    });

    it('signs pending tokens with a short expiry', () => {
      const token = service.signToken(subject, 'pending');
      const payload = service.verifyToken(token) as unknown as {
        purpose: string;
        iat: number;
        exp: number;
      };
      expect(payload.purpose).toBe('pending');
      expect(payload.exp - payload.iat).toBe(10 * 60);
    });

    it('rejects tokens signed with a different secret', () => {
      const other = new JwtService();
      const forged = other.sign(
        { sub: 7, username: 'alice', storageId: 'sid-7', purpose: 'auth' },
        { secret: 'wrong-secret' },
      );
      expect(() => service.verifyToken(forged)).toThrow();
    });
  });
});
