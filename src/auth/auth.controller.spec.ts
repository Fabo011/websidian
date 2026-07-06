import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { User } from '../users/user.entity';
import { AUTH_COOKIE } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

function makeController(
  options: {
    allowRegistration?: boolean;
    cookieSecure?: boolean;
    jwtExpiresIn?: string;
  } = {},
): {
  controller: AuthController;
  auth: {
    register: jest.Mock;
    validateCredentials: jest.Mock;
    confirmTotp: jest.Mock;
    signToken: jest.Mock;
  };
} {
  const auth = {
    register: jest.fn(),
    validateCredentials: jest.fn(),
    confirmTotp: jest.fn(),
    signToken: jest.fn().mockReturnValue('signed-token'),
  };
  const config = {
    get: jest.fn().mockReturnValue({
      allowRegistration: options.allowRegistration ?? true,
      cookieSecure: options.cookieSecure ?? false,
      jwtExpiresIn: options.jwtExpiresIn ?? '7d',
    }),
  } as unknown as ConfigService;
  return {
    controller: new AuthController(auth as unknown as AuthService, config),
    auth,
  };
}

function makeRes(): Response & {
  cookies: Array<{ name: string; value: string; options: object }>;
  cleared: string[];
} {
  const res = {
    cookies: [] as Array<{ name: string; value: string; options: object }>,
    cleared: [] as string[],
    cookie(name: string, value: string, options: object) {
      this.cookies.push({ name, value, options });
    },
    clearCookie(name: string) {
      this.cleared.push(name);
    },
  };
  return res as unknown as ReturnType<typeof makeRes>;
}

const REGISTER_DTO = {
  username: 'Alice',
  password: 'pw',
  kdfSalt: 'kdf',
  recoverySalt: 'rec',
  wrappedVaultKey: 'wvk',
  recoveryWrappedVaultKey: 'rwvk',
};

describe('AuthController', () => {
  describe('register', () => {
    it('rejects when registration is disabled', async () => {
      const { controller } = makeController({ allowRegistration: false });
      await expect(
        controller.register(REGISTER_DTO, makeRes()),
      ).rejects.toThrow(ForbiddenException);
    });

    it('registers, sets a short-lived pending cookie, returns enrolment data', async () => {
      const { controller, auth } = makeController();
      const user = Object.assign(new User(), { id: 1 });
      auth.register.mockResolvedValue({
        user,
        secret: 's3cret',
        otpauthUrl: 'otpauth://x',
        qrDataUrl: 'data:image/png;base64,x',
      });
      const res = makeRes();

      const result = await controller.register(REGISTER_DTO, res);

      expect(auth.register).toHaveBeenCalledWith('Alice', 'pw', {
        kdfSalt: 'kdf',
        recoverySalt: 'rec',
        wrappedVaultKey: 'wvk',
        recoveryWrappedVaultKey: 'rwvk',
      });
      expect(auth.signToken).toHaveBeenCalledWith(user, 'pending');
      expect(result).toEqual({
        secret: 's3cret',
        otpauthUrl: 'otpauth://x',
        qrDataUrl: 'data:image/png;base64,x',
      });
      expect(res.cookies).toEqual([
        {
          name: AUTH_COOKIE,
          value: 'signed-token',
          options: expect.objectContaining({
            httpOnly: true,
            sameSite: 'lax',
            secure: false,
            maxAge: 10 * 60 * 1000,
          }),
        },
      ]);
    });
  });

  describe('login', () => {
    it('validates credentials and issues a pending cookie', async () => {
      const { controller, auth } = makeController({ cookieSecure: true });
      const user = Object.assign(new User(), { id: 1 });
      auth.validateCredentials.mockResolvedValue(user);
      const res = makeRes();

      await expect(
        controller.login({ username: 'alice', password: 'pw' }, res),
      ).resolves.toEqual({ needTotp: true });

      expect(auth.signToken).toHaveBeenCalledWith(user, 'pending');
      expect(res.cookies[0].options).toMatchObject({
        secure: true,
        maxAge: 10 * 60 * 1000,
      });
    });

    it('propagates invalid credentials', async () => {
      const { controller, auth } = makeController();
      auth.validateCredentials.mockRejectedValue(new Error('bad'));
      await expect(
        controller.login({ username: 'a', password: 'b' }, makeRes()),
      ).rejects.toThrow('bad');
    });
  });

  describe('verify2fa', () => {
    const current = { id: 1, username: 'alice', storageId: 'sid' };

    it('confirms the code, upgrades the cookie, returns the wrapped key', async () => {
      const { controller, auth } = makeController({ jwtExpiresIn: '7d' });
      const user = Object.assign(new User(), {
        id: 1,
        kdfSalt: 'kdf',
        wrappedVaultKey: 'wvk',
      });
      auth.confirmTotp.mockResolvedValue(user);
      const res = makeRes();

      await expect(
        controller.verify2fa({ code: '123456' }, current, res),
      ).resolves.toEqual({ ok: true, kdfSalt: 'kdf', wrappedVaultKey: 'wvk' });

      expect(auth.confirmTotp).toHaveBeenCalledWith(1, '123456');
      expect(auth.signToken).toHaveBeenCalledWith(user, 'auth');
      // 7d = 604800000 ms.
      expect(res.cookies[0].options).toMatchObject({
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
    });

    it.each([
      ['30s', 30 * 1000],
      ['15m', 15 * 60 * 1000],
      ['12h', 12 * 60 * 60 * 1000],
      ['2d', 2 * 24 * 60 * 60 * 1000],
      ['nonsense', 7 * 24 * 60 * 60 * 1000], // fallback: 7 days
    ])('maps jwtExpiresIn %s to a %d ms cookie', async (expiresIn, ms) => {
      const { controller, auth } = makeController({ jwtExpiresIn: expiresIn });
      auth.confirmTotp.mockResolvedValue(new User());
      const res = makeRes();
      await controller.verify2fa({ code: '1' }, current, res);
      expect(res.cookies[0].options).toMatchObject({ maxAge: ms });
    });
  });

  it('logout clears the auth cookie', () => {
    const { controller } = makeController();
    const res = makeRes();
    expect(controller.logout({} as Request, res)).toEqual({ ok: true });
    expect(res.cleared).toEqual([AUTH_COOKIE]);
  });
});
