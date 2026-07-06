import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { AUTH_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { JwtPayload } from './auth.types';
import { JwtAuthGuard, PendingAuthGuard } from './guards';

describe('auth guards', () => {
  let auth: { verifyToken: jest.Mock };
  let users: { findById: jest.Mock };
  let req: { cookies?: Record<string, string>; user?: unknown };

  const context = (): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  const payload = (purpose: 'auth' | 'pending'): JwtPayload => ({
    sub: 1,
    username: 'alice',
    storageId: 'sid-1',
    purpose,
  });

  beforeEach(() => {
    auth = { verifyToken: jest.fn() };
    users = { findById: jest.fn() };
    req = { cookies: { [AUTH_COOKIE]: 'token-123' } };
  });

  const makeJwtGuard = () =>
    new JwtAuthGuard(
      auth as unknown as AuthService,
      users as unknown as UsersService,
    );
  const makePendingGuard = () =>
    new PendingAuthGuard(
      auth as unknown as AuthService,
      users as unknown as UsersService,
    );

  describe('JwtAuthGuard', () => {
    it('rejects when no cookie is present', async () => {
      req = {};
      await expect(makeJwtGuard().canActivate(context())).rejects.toThrow(
        'Not authenticated.',
      );
    });

    it('rejects invalid/expired tokens', async () => {
      auth.verifyToken.mockImplementation(() => {
        throw new Error('jwt expired');
      });
      await expect(makeJwtGuard().canActivate(context())).rejects.toThrow(
        'Session expired or invalid.',
      );
    });

    it('rejects a pending token (wrong stage)', async () => {
      auth.verifyToken.mockReturnValue(payload('pending'));
      await expect(makeJwtGuard().canActivate(context())).rejects.toThrow(
        'Wrong authentication stage.',
      );
    });

    it('rejects when the user row no longer exists', async () => {
      auth.verifyToken.mockReturnValue(payload('auth'));
      users.findById.mockResolvedValue(null);
      await expect(makeJwtGuard().canActivate(context())).rejects.toThrow(
        'Account no longer exists.',
      );
      expect(users.findById).toHaveBeenCalledWith(1);
    });

    it('attaches the user to the request on success', async () => {
      auth.verifyToken.mockReturnValue(payload('auth'));
      users.findById.mockResolvedValue({ id: 1 });

      await expect(makeJwtGuard().canActivate(context())).resolves.toBe(true);
      expect(auth.verifyToken).toHaveBeenCalledWith('token-123');
      expect(req.user).toEqual({
        id: 1,
        username: 'alice',
        storageId: 'sid-1',
      });
    });
  });

  describe('PendingAuthGuard', () => {
    it('accepts a pending token without checking the user row', async () => {
      auth.verifyToken.mockReturnValue(payload('pending'));

      await expect(makePendingGuard().canActivate(context())).resolves.toBe(
        true,
      );
      expect(users.findById).not.toHaveBeenCalled();
      expect(req.user).toEqual({
        id: 1,
        username: 'alice',
        storageId: 'sid-1',
      });
    });

    it('rejects a full auth token (wrong stage)', async () => {
      auth.verifyToken.mockReturnValue(payload('auth'));
      await expect(makePendingGuard().canActivate(context())).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
