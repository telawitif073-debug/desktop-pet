import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dataSourceOptions } from './data-source';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { PetsModule } from './pets/pets.module';
import { AgentsModule } from './agents/agents.module';
import { UploadsModule } from './uploads/uploads.module';
import { ReviewsModule } from './reviews/reviews.module';
import { AdminModule } from './admin/admin.module';
import { ActionsModule } from './actions/actions.module';
import { SyncModule } from './sync/sync.module';
import { AppUpdateModule } from './app-update/app-update.module';
import { MultiChatModule } from './multi-chat/multi-chat.module';
import { CrashReportModule } from './crash/crash-report.module';
import { ToolsModule } from './tools/tools.module';
import { VoicesModule } from './voices/voices.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 数据库配置的**唯一事实来源**：src/data-source.ts（应用与 TypeORM CLI 共用同一份，
    // 避免 host/port/database 默认值在应用与迁移两处漂移）。
    //   · synchronize 已永久关闭 —— 删实体不再等于 DROP TABLE；
    //     任何表结构变更都必须写成 src/migrations/ 下的显式 migration。
    //   · migrationsRun: true —— 启动时自动执行未落库的 migration。
    // 迁移命令见 package.json 的 migration:* 脚本；宠物功能域重建（Phase 4）删表前
    // 必须先 pg_dump 备份，详见 .trae/documents/pet-domain-rebuild.md。
    TypeOrmModule.forRoot({ ...dataSourceOptions }),
    UsersModule,
    AuthModule,
    PetsModule,
    AgentsModule,
    UploadsModule,
    ReviewsModule,
    AdminModule,
    ActionsModule,
    SyncModule,
    AppUpdateModule,
    MultiChatModule,
    CrashReportModule,
    ToolsModule,
    VoicesModule,
  ],
})
export class AppModule {}
