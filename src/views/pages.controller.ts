import { Controller, Get, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { AppConfig } from '../config/configuration';

@Controller()
export class PagesController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
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

  @Get('/')
  index(@Req() req: Request, @Res() res: Response) {
    const username = this.currentUsername(req);
    if (!username) {
      return res.redirect('/login');
    }
    return res.render('app', { username });
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
  register(@Req() req: Request, @Res() res: Response) {
    if (this.currentUsername(req)) {
      return res.redirect('/');
    }
    if (!this.app.allowRegistration) {
      return res.render('login', {
        allowRegistration: false,
        notice: 'Registration is currently disabled.',
      });
    }
    return res.render('register', {});
  }
}
