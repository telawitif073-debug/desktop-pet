import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 移除宠物系统在数据库侧的全部残留（宠物系统整体下线）
 * ===========================================================================
 * 背景：平台不再承载宠物业务，`pet_packs` 表、评价/下载域的 `asset_type='pet'`、
 * 云同步里的宠物配置键都不应继续存在。本迁移是 `AddPetPacks1791041000000` 的**整体逆操作**，
 * 并额外清掉更早的历史值 `action`（动作已随宠物包一起下线）。
 *
 * 破坏性操作前的准备（项目硬约束）：执行前已做
 *   · `git tag snapshot-before-pet-removal`（可 `git reset --hard` 整体回退代码）
 *   · 全量 `pg_dump` 到 `Environment/backups/before-pet-removal-*.sql`
 *   · 临时库恢复演练（核对 users/agents/pet_packs/reviews/downloads/sync 行数）
 *
 * up() 做四件事：
 *  1. 删除 `reviews` / `download_records` 中 `asset_type in ('pet','action')` 的行
 *     （必须先删行再重建枚举，否则 ALTER COLUMN 会因目标枚举不含该值而失败）；
 *  2. 重建两张表的 `asset_type` 枚举为 `('agent','voice')`（建新类型 → 改列 → 删旧类型 → 改名）；
 *  3. 删除 `pet_packs` 表（含外键、索引）与其状态枚举；
 *  4. 清理云同步数据：删掉 `kind='pet-state'` 的行、并从 `kind='config'` 的 jsonb 里摘掉宠物键。
 *
 * down()：**刻意抛错**。宠物表与枚举值都已删除，无法在不知道原始素材与授权的前提下重建；
 * 需要回退请用 `Environment/backups/before-pet-removal-*.sql` 做一次完整还原
 * （这也是本项目对不可逆迁移的一贯约定：宁可明确失败，也不要写一个假装能回滚的 down）。
 */
export class RemovePetFeature1791100000000 implements MigrationInterface {
  name = 'RemovePetFeature1791100000000';

  /** 云同步 config 里属于宠物系统的键（摘掉后其余配置原样保留） */
  private static readonly PET_CONFIG_KEYS = [
    'petAssetPath',
    'petAssetName',
    'petAssetId',
    'petAssetFormat',
    'builtinPet',
    'petActions',
    'petActionBindings',
    'petState',
    'petStateReady',
    'petSelfDescription',
    'currentPet',
    'downloadedPets',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1) 先删掉枚举里即将消失的值的业务行（否则下面的 ALTER COLUMN 会失败）──────
    await queryRunner.query(`DELETE FROM "reviews" WHERE "asset_type"::text IN ('pet', 'action')`);
    await queryRunner.query(`DELETE FROM "download_records" WHERE "asset_type"::text IN ('pet', 'action')`);

    // ── 2) reviews.asset_type → ('agent','voice') ────────────────────────────
    await queryRunner.query(`DROP INDEX "public"."IDX_7a44ce3847f2132fd778b79fff"`);
    await queryRunner.query(`ALTER TYPE "public"."reviews_asset_type_enum" RENAME TO "reviews_asset_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."reviews_asset_type_enum" AS ENUM('agent', 'voice')`);
    await queryRunner.query(
      `ALTER TABLE "reviews" ALTER COLUMN "asset_type" TYPE "public"."reviews_asset_type_enum" USING "asset_type"::"text"::"public"."reviews_asset_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."reviews_asset_type_enum_old"`);
    await queryRunner.query(`CREATE INDEX "IDX_7a44ce3847f2132fd778b79fff" ON "reviews" ("asset_type", "asset_id") `);

    // ── 3) download_records.asset_type → ('agent','voice') ───────────────────
    await queryRunner.query(`DROP INDEX "public"."IDX_8d22c86c970ad4f47756bd177f"`);
    await queryRunner.query(
      `ALTER TYPE "public"."download_records_asset_type_enum" RENAME TO "download_records_asset_type_enum_old"`,
    );
    await queryRunner.query(`CREATE TYPE "public"."download_records_asset_type_enum" AS ENUM('agent', 'voice')`);
    await queryRunner.query(
      `ALTER TABLE "download_records" ALTER COLUMN "asset_type" TYPE "public"."download_records_asset_type_enum" USING "asset_type"::"text"::"public"."download_records_asset_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."download_records_asset_type_enum_old"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_8d22c86c970ad4f47756bd177f" ON "download_records" ("asset_type", "asset_id") `,
    );

    // ── 4) 删宠物包表（外键 → 索引 → 表 → 枚举；与 AddPetPacks 的 up 顺序相反）──
    await queryRunner.query(`ALTER TABLE "pet_packs" DROP CONSTRAINT "FK_a86418b08d1c0ab19dfa75a4547"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8ec3883c97ce460097881670b8"`);
    await queryRunner.query(`DROP TABLE "pet_packs"`);
    await queryRunner.query(`DROP TYPE "public"."pet_packs_status_enum"`);

    // ── 5) 云同步：删宠物状态行 → 收窄 kind 枚举 → 从 config 里摘掉宠物键 ──────
    // 注意：`kind` 是枚举 `user_sync_data_kind_enum`，标签是下划线风格（'pet_state' 而非 'pet-state'），
    // 写成连字符会直接 22P02「invalid input value for enum」。
    await queryRunner.query(`DELETE FROM "user_sync_data" WHERE "kind" = 'pet_state'`);
    await queryRunner.query(`ALTER TYPE "public"."user_sync_data_kind_enum" RENAME TO "user_sync_data_kind_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."user_sync_data_kind_enum" AS ENUM('config', 'chat_history')`);
    await queryRunner.query(
      `ALTER TABLE "user_sync_data" ALTER COLUMN "kind" TYPE "public"."user_sync_data_kind_enum" USING "kind"::"text"::"public"."user_sync_data_kind_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."user_sync_data_kind_enum_old"`);

    // 摘掉 config 里的宠物键：不加 `?|` 存在性条件（无该键时 `jsonb - text` 是幂等 no-op，更省事也更不易写错）
    const keys = RemovePetFeature1791100000000.PET_CONFIG_KEYS;
    await queryRunner.query(
      `UPDATE "user_sync_data" SET "data" = "data" ${keys.map((k) => `- '${k}'`).join(' ')} WHERE "kind" = 'config'`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'RemovePetFeature 不可回滚：宠物表与 asset_type 枚举值已删除，无法在缺少原始素材与授权的前提下重建。' +
        '如需恢复，请用 Environment/backups/before-pet-removal-*.sql 做一次完整还原。',
    );
  }
}
