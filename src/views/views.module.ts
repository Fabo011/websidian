import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PagesController } from './pages.controller';

@Module({
  imports: [AuthModule],
  controllers: [PagesController],
})
export class ViewsModule {}
