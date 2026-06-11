import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { UsersService } from '../users/users.service';
import { AUTH_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { TokenPurpose } from './auth.types';

function extractToken(req: Request): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[AUTH_COOKIE];
}

/**
 * Guard requiring a valid cookie of the given purpose.
 * When `verifyUserExists` is set, the user row must still exist in the database
 * (so a deleted account's token is rejected immediately rather than at expiry).
 */
function makeGuard(required: TokenPurpose, verifyUserExists: boolean) {
  @Injectable()
  class CookieGuard implements CanActivate {
    constructor(
      public readonly auth: AuthService,
      public readonly users: UsersService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const req = context.switchToHttp().getRequest<Request>();
      const token = extractToken(req);
      if (!token) {
        throw new UnauthorizedException('Not authenticated.');
      }
      let payload;
      try {
        payload = this.auth.verifyToken(token);
      } catch {
        throw new UnauthorizedException('Session expired or invalid.');
      }
      if (payload.purpose !== required) {
        throw new UnauthorizedException('Wrong authentication stage.');
      }
      if (verifyUserExists) {
        const user = await this.users.findById(payload.sub);
        if (!user) {
          throw new UnauthorizedException('Account no longer exists.');
        }
      }
      (req as Request & { user?: unknown }).user = {
        id: payload.sub,
        username: payload.username,
      };
      return true;
    }
  }
  return CookieGuard;
}

@Injectable()
export class JwtAuthGuard extends makeGuard('auth', true) {}

@Injectable()
export class PendingAuthGuard extends makeGuard('pending', false) {}
