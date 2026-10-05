import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, type DataSourceOptions } from 'typeorm';

/**
 * TypeORM 数据源（应用与 CLI 共用的**唯一**数据库配置事实来源）
 * ===========================================================================
 * 为什么需要这个文件：
 * 过去 `app.module.ts` 里写死了 `synchronize: true`——开发期方便，但意味着
 * **删掉一个实体就会自动 DROP 对应表**。任何删实体/删表的重构都必须先把
 * 表结构变更收敛到**显式 migration**，否则删代码等于静默删数据。
 *
 * 约定：
 *  - 应用（AppModule）与 CLI（migration:generate / run / revert）都从这里取配置，
 *    避免两处配置漂移（历史上 host/port/database 默认值就散落在两处）。
 *  - `synchronize: false` 永久关闭：任何表结构变更都必须是一条 migration。
 *  - `migrationsRun: true`：应用启动时自动执行未落库的 migration（部署友好）。
 *  - 实体/迁移用 `__dirname` 相对 glob，`src`（ts-node）与 `dist`（编译产物）都适用。
 */

/**
 * 轻量 .env 读取：只做「KEY=VALUE 覆盖 process.env」这一件事。
 * 不引第三方依赖（backend 未显式声明 dotenv，不能凭空多一个依赖导致 npm ci 失败）。
 * process.env 优先级更高（便于 CLI 临时覆盖 DB_DATABASE 指向影子库）。
 */
function loadDotEnv(): void {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  let text = '';
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const str = (key: string, fallback: string): string => process.env[key] ?? fallback;

/** 与旧 `app.module.ts` 完全一致的默认值（host/port/user/password/database） */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: str('DB_HOST', 'localhost'),
  port: Number(str('DB_PORT', '5432')),
  username: str('DB_USERNAME', 'postgres'),
  password: str('DB_PASSWORD', 'postgres'),
  database: str('DB_DATABASE', 'desktop_pet_platform'),
  entities: [path.join(__dirname, '**', '*.entity{.ts,.js}')],
  migrations: [path.join(__dirname, 'migrations', '*{.ts,.js}')],
  migrationsTableName: 'migrations',
  // 永久关闭自动同步：表结构变更只能通过 migrations 落地
  synchronize: false,
  // 启动时自动执行未落库的 migration
  migrationsRun: true,
};

export default new DataSource(dataSourceOptions);
