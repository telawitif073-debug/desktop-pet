import { Module } from '@nestjs/common';
import { AppUpdateController } from './app-update.controller';

@Module({
  controllers: [AppUpdateController],
})
export class AppUpdateModule {}
