import { Controller, Get, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { AppConfig } from '../config/configuration';
import { UsersService } from '../users/users.service';

@Controller()
export class PagesController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {}

  private get app(): AppConfig {
    return this.config.get<AppConfig>('app');
  }

  private currentUsername(req: Request): string | null {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const token = cookies?.[AUTH_COOKIE];
    if (!token) {
      return null;
    }
    try {
      const payload = this.auth.verifyToken(token);
      return payload.purpose === 'auth' ? payload.username : null;
    } catch {
      return null;
    }
  }

  /**
   * Returns the number of registration spots still available, or null when
   * there is no cap (MAX_REGISTRATIONS is unset / 0).
   */
  private async registrationsLeft(): Promise<number | null> {
    const max = this.app.maxRegistrations;
    if (!max || max <= 0) return null;
    const count = await this.users.count();
    return Math.max(0, max - count);
  }

  @Get('/')
  async index(@Req() req: Request, @Res() res: Response) {
    const username = this.currentUsername(req);
    if (!username) {
      const left = await this.registrationsLeft();
      const canRegister = this.app.allowRegistration && (left === null || left > 0);
      return res.render('landing', {
        allowRegistration: canRegister,
        registrationsLeft: left,
        pricing: this.app.pricing,
      });
    }
    return res.render('app', { username });
  }

  @Get('/docs')
  docs(@Req() req: Request, @Res() res: Response) {
    return res.render('docs', {
      loggedIn: Boolean(this.currentUsername(req)),
    });
  }

  @Get('/imprint')
  imprint(@Res() res: Response) {
    return res.render('imprint', {});
  }

  @Get('/privacy')
  privacy(@Res() res: Response) {
    return res.render('privacy', {});
  }

  @Get('/login')
  login(@Req() req: Request, @Res() res: Response) {
    if (this.currentUsername(req)) {
      return res.redirect('/');
    }
    return res.render('login', {
      allowRegistration: this.app.allowRegistration,
    });
  }

  @Get('/register')
  async register(@Req() req: Request, @Res() res: Response) {
    if (this.currentUsername(req)) {
      return res.redirect('/');
    }
    if (!this.app.allowRegistration) {
      return res.render('login', {
        allowRegistration: false,
        notice: 'Registration is currently disabled.',
      });
    }
    const left = await this.registrationsLeft();
    if (left !== null && left === 0) {
      return res.render('login', {
        allowRegistration: false,
        notice: 'Registration is currently full. No spots are available right now.',
      });
    }
    return res.render('register', { registrationsLeft: left });
  }
}
