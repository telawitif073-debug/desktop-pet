import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 删除旧宠物功能域的表结构（宠物功能域重建 Phase 4.1，**不可逆**）
 * ===========================================================================
 * 删除对象：
 *  1. `action_assets`（宠物动作，FK → pet_assets，必须先删）
 *  2. `pet_assets`（旧宠物资源商店的资产表）
 *  3. `ai_image_providers` / `ai_style_presets`——**历史孤儿表**：来自已被删除的
 *     「AI 生成宠物」功能（commit 7aa21190），既无实体也无任何代码引用，
 *     因为 synchronize 只增不删而被留了下来。
 *  4. 两张表 `asset_type` 枚举里的 `'pet'` 取值（Postgres 不能直接删枚举值，
 *     故用「建新类型 → 改列 → 删旧类型 → 改名」的方式重建）。
 *     执行前提：`reviews` / `download_records` 中 `asset_type='pet'` 的行数为 0
 *     （up() 里会先校验，非 0 则中止，绝不静默丢数据）。
 *
 * 回滚：本迁移**故意不可逆**（down 抛错）。需要恢复请用备份，步骤见
 * `Environment/build/backups/RESTORE.md`。
 */
export class DropLegacyPetTables1791036000000 implements MigrationInterface {
  name = 'DropLegacyPetTables1791036000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 0) 安全闸：只有显式声明「已导出、确认清库」才允许继续 ────────────────
    //   `pg_stat_user_tables.n_live_tup` 是统计收集器的**估算值**，在未 ANALYZE 时会谎报 0；
    //   这里一律用真实 count(*)。实测本库并非空库（16 只宠物 / 9 条评价 / 65 条下载记录），
    //   所以必须先把待删行导出到 Environment/build/backups/ 再带开关执行。
    const petRows = await this.countPetRows(queryRunner);
    const petAssets = await this.countRows(queryRunner, 'pet_assets');
    const actionAssets = await this.countRows(queryRunner, 'action_assets');
    if ((petRows > 0 || petAssets > 0 || actionAssets > 0) && process.env.ALLOW_PET_DATA_PURGE !== '1') {
      throw new Error(
        `中止：本次将永久删除 pet_assets=${petAssets} 行、action_assets=${actionAssets} 行、` +
          `asset_type='pet' 的 reviews/download_records 共 ${petRows} 行。\n` +
          `请先导出（见 Environment/build/backups/RESTORE.md），再带 ALLOW_PET_DATA_PURGE=1 重跑本迁移。`,
      );
    }

    // ── 0b) 清除悬空的 'pet' 业务行（其指向的 pet_assets 即将被删，二者同生命周期） ──
    await queryRunner.query(`DELETE FROM "reviews"          WHERE "asset_type" = 'pet'`);
    await queryRunner.query(`DELETE FROM "download_records" WHERE "asset_type" = 'pet'`);

    // ── 1) 动作表（FK 指向 pet_assets，先删） ────────────────────────────────
    await queryRunner.query(`DROP TABLE IF EXISTS "action_assets"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."action_assets_kind_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."action_assets_interaction_enum"`);

    // ── 2) 宠物资源表 ────────────────────────────────────────────────────────
    await queryRunner.query(`DROP TABLE IF EXISTS "pet_assets"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."pet_assets_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."pet_assets_format_enum"`);

    // ── 3) 历史孤儿表 ────────────────────────────────────────────────────────
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_image_providers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_style_presets"`);

    // ── 4) 从 asset_type 枚举中剔除 'pet'（重建类型，保持名字不变以免 TypeORM 漂移） ──
    await this.rebuildAssetTypeEnum(queryRunner, 'reviews', 'reviews_asset_type_enum');
    await this.rebuildAssetTypeEnum(queryRunner, 'download_records', 'download_records_asset_type_enum');
  }

  /** 真实行数（不用 n_live_tup 估算值） */
  private async countRows(queryRunner: QueryRunner, table: string): Promise<number> {
    const rows = (await queryRunner.query(`SELECT count(*)::int AS n FROM "${table}"`)) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  /** reviews + download_records 中 asset_type='pet' 的真实行数合计 */
  private async countPetRows(queryRunner: QueryRunner): Promise<number> {
    const rows = (await queryRunner.query(
      `SELECT (
         (SELECT count(*) FROM "reviews"          WHERE "asset_type" = 'pet') +
         (SELECT count(*) FROM "download_records" WHERE "asset_type" = 'pet')
       )::int AS n`,
    )) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  /** 重建某个表的 asset_type 枚举为 ('agent','action','voice')，类型名保持不变 */
  private async rebuildAssetTypeEnum(queryRunner: QueryRunner, table: string, typeName: string): Promise<void> {
    const tmp = `${typeName}_new`;
    await queryRunner.query(`CREATE TYPE "public"."${tmp}" AS ENUM('agent', 'action', 'voice')`);
    await queryRunner.query(
      `ALTER TABLE "${table}" ALTER COLUMN "asset_type" TYPE "public"."${tmp}" ` +
        `USING ("asset_type"::text::"public"."${tmp}")`,
    );
    await queryRunner.query(`DROP TYPE "public"."${typeName}"`);
    await queryRunner.query(`ALTER TYPE "public"."${tmp}" RENAME TO "${typeName}"`);
  }

  public async down(): Promise<void> {
    throw new Error(
      'DropLegacyPetTables 是刻意不可逆的删除（宠物功能域重建 Phase 4.1）。' +
        '如需恢复请用 Environment/build/backups/ 下的备份，步骤见同目录 RESTORE.md。',
    );
  }
}
