import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { AppConfig } from '../config/configuration';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { PagesController } from './pages.controller';

function makeApp(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    allowRegistration: true,
    maxRegistrations: 0,
    userStorageEnabled: false,
    managedStorageAvailable: false,
    imprintEnabled: false,
    privacyEnabled: false,
    agbEnabled: false,
    tiers: { free: 1024, plus: 4096 },
    stripe: { enabled: false },
    pricing: {
      pricePlus: '€10 / year',
      planGb: 3,
      contactEmail: '',
      donationLink: '',
    },
    ...overrides,
  } as AppConfig;
}

function makeController(
  app: AppConfig,
  options: { user?: Partial<User> | null; count?: number } = {},
): {
  controller: PagesController;
  auth: { verifyToken: jest.Mock };
  users: { count: jest.Mock; findByUsername: jest.Mock };
} {
  const auth = { verifyToken: jest.fn() };
  const users = {
    count: jest.fn().mockResolvedValue(options.count ?? 0),
    findByUsername: jest
      .fn()
      .mockResolvedValue(
        options.user === null
          ? null
          : Object.assign(new User(), { username: 'alice' }, options.user),
      ),
  };
  const config = {
    get: jest.fn().mockReturnValue(app),
  } as unknown as ConfigService;
  return {
    controller: new PagesController(
      auth as unknown as AuthService,
      config,
      users as unknown as UsersService,
    ),
    auth,
    users,
  };
}

const anonReq = (): Request => ({ cookies: {} }) as unknown as Request;
const authedReq = (): Request =>
  ({ cookies: { [AUTH_COOKIE]: 'token' } }) as unknown as Request;

function makeRes(): Response & {
  rendered?: { view: string; locals: Record<string, unknown> };
  redirected?: string;
} {
  const res = {
    render(view: string, locals: Record<string, unknown>) {
      this.rendered = { view, locals };
    },
    redirect(url: string) {
      this.redirected = url;
    },
  };
  return res as unknown as ReturnType<typeof makeRes>;
}

const authPayload = { purpose: 'auth', username: 'alice' };

describe('PagesController', () => {
  describe('index', () => {
    it('renders the landing page for anonymous visitors', async () => {
      const { controller } = makeController(makeApp());
      const res = makeRes();
      await controller.index(anonReq(), res);
      expect(res.rendered?.view).toBe('landing');
      expect(res.rendered?.locals).toMatchObject({
        allowRegistration: true,
        registrationsLeft: null,
      });
    });

    it('treats invalid/pending tokens as anonymous', async () => {
      const { controller, auth } = makeController(makeApp());
      auth.verifyToken.mockReturnValue({ purpose: 'pending', username: 'a' });
      const res = makeRes();
      await controller.index(authedReq(), res);
      expect(res.rendered?.view).toBe('landing');

      auth.verifyToken.mockImplementation(() => {
        throw new Error('expired');
      });
      const res2 = makeRes();
      await controller.index(authedReq(), res2);
      expect(res2.rendered?.view).toBe('landing');
    });

    it('shows remaining spots and closes registration when full', async () => {
      const { controller } = makeController(makeApp({ maxRegistrations: 5 }), {
        count: 5,
      });
      const res = makeRes();
      await controller.index(anonReq(), res);
      expect(res.rendered?.locals).toMatchObject({
        allowRegistration: false,
        registrationsLeft: 0,
      });
    });

    it('renders the app for logged-in users', async () => {
      const { controller, auth } = makeController(makeApp());
      auth.verifyToken.mockReturnValue(authPayload);
      const res = makeRes();
      await controller.index(authedReq(), res);
      expect(res.rendered?.view).toBe('app');
      expect(res.rendered?.locals).toMatchObject({
        username: 'alice',
        storageConfigured: true, // hosted mode: always true
      });
    });

    it('flags unconfigured storage in bring-your-own mode', async () => {
      const { controller, auth } = makeController(
        makeApp({ userStorageEnabled: true }),
        { user: { storageConfig: null } },
      );
      auth.verifyToken.mockReturnValue(authPayload);
      const res = makeRes();
      await controller.index(authedReq(), res);
      expect(res.rendered?.locals).toMatchObject({
        userStorageEnabled: true,
        storageConfigured: false,
      });
    });
  });

  it('docs reflects the login state', async () => {
    const { controller, auth } = makeController(makeApp());
    const res = makeRes();
    controller.docs(anonReq(), res);
    expect(res.rendered).toEqual({ view: 'docs', locals: { loggedIn: false } });

    auth.verifyToken.mockReturnValue(authPayload);
    const res2 = makeRes();
    controller.docs(authedReq(), res2);
    expect(res2.rendered?.locals).toEqual({ loggedIn: true });
  });

  describe('legal pages', () => {
    it.each([
      ['imprint', 'imprintEnabled'],
      ['privacy', 'privacyEnabled'],
      ['agb', 'agbEnabled'],
    ] as const)(
      '%s redirects home when disabled, renders when enabled',
      (page, flag) => {
        const disabled = makeController(makeApp());
        const res = makeRes();
        disabled.controller[page](res);
        expect(res.redirected).toBe('/');

        const enabled = makeController(makeApp({ [flag]: true }));
        const res2 = makeRes();
        enabled.controller[page](res2);
        expect(res2.rendered?.view).toBe(page);
      },
    );
  });

  describe('login page', () => {
    it('redirects home when already logged in', () => {
      const { controller, auth } = makeController(makeApp());
      auth.verifyToken.mockReturnValue(authPayload);
      const res = makeRes();
      controller.login(authedReq(), res);
      expect(res.redirected).toBe('/');
    });

    it('renders the login form otherwise', () => {
      const { controller } = makeController(makeApp());
      const res = makeRes();
      controller.login(anonReq(), res);
      expect(res.rendered).toEqual({
        view: 'login',
        locals: { allowRegistration: true },
      });
    });
  });

  describe('register page', () => {
    it('redirects home when already logged in', async () => {
      const { controller, auth } = makeController(makeApp());
      auth.verifyToken.mockReturnValue(authPayload);
      const res = makeRes();
      await controller.register(authedReq(), res);
      expect(res.redirected).toBe('/');
    });

    it('falls back to the login view when registration is disabled', async () => {
      const { controller } = makeController(
        makeApp({ allowRegistration: false }),
      );
      const res = makeRes();
      await controller.register(anonReq(), res);
      expect(res.rendered?.view).toBe('login');
      expect(res.rendered?.locals).toMatchObject({
        allowRegistration: false,
        notice: expect.stringContaining('disabled'),
      });
    });

    it('falls back to the login view when registration is full', async () => {
      const { controller } = makeController(makeApp({ maxRegistrations: 3 }), {
        count: 3,
      });
      const res = makeRes();
      await controller.register(anonReq(), res);
      expect(res.rendered?.view).toBe('login');
      expect(res.rendered?.locals).toMatchObject({
        notice: expect.stringContaining('full'),
      });
    });

    it('renders the form with remaining spots', async () => {
      const { controller } = makeController(makeApp({ maxRegistrations: 5 }), {
        count: 2,
      });
      const res = makeRes();
      await controller.register(anonReq(), res);
      expect(res.rendered?.view).toBe('register');
      expect(res.rendered?.locals).toMatchObject({ registrationsLeft: 3 });
    });
  });
});
