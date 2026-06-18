import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    const expressApp = app as NestExpressApplication;
    expressApp.setBaseViewsDir(join(process.cwd(), 'views'));
    expressApp.setViewEngine('ejs');
    await app.init();
  });

  it('/ (GET) serves the landing page to unauthenticated users', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect(/web-obsidian/);
  });

  it('/imprint (GET) serves the imprint page', () => {
    return request(app.getHttpServer())
      .get('/imprint')
      .expect(200)
      .expect(/Imprint/);
  });

  it('/privacy (GET) serves the privacy policy page', () => {
    return request(app.getHttpServer())
      .get('/privacy')
      .expect(200)
      .expect(/Privacy/);
  });
});
