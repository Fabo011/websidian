import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AUTH_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { TokenPurpose } from './auth.types';

function extractToken(req: Request): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[AUTH_COOKIE];
}

/** Guard requiring a valid cookie of the given purpose. */
function makeGuard(required: TokenPurpose) {
  @Injectable()
  class CookieGuard implements CanActivate {
    constructor(public readonly auth: AuthService) {}

    canActivate(context: ExecutionContext): boolean {
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
export class JwtAuthGuard extends makeGuard('auth') {}

@Injectable()
export class PendingAuthGuard extends makeGuard('pending') {}
