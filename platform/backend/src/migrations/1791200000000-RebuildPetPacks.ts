import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 重建宠物包表 `pet_packs` + 把评价/下载/云同步三处枚举**扩回**含宠物取值
 * ===========================================================================
 * 背景：`RemovePetFeature1791100000000` 曾把宠物系统在 DB 侧整体删除（drop `pet_packs`、
 * 把 `asset_type` 收窄为 ('agent','voice')、把 `user_sync_data.kind` 收窄为
 * ('config','chat_history')）。本迁移是它的**结构逆操作**（不是回滚——旧迁移 down() 仍抛错），
 * 用于在新建的 `pet/` 模块下重新承载宠物包分发。
 *
 * 与 `AddPetPacks1791041000000` 的关系：表结构、索引名、外键名、状态枚举名**逐字照抄**该迁移，
 * 避免 TypeORM `migration:generate` 之后产出「重命名索引/外键」的漂移迁移。
 *
 * 与旧迁移的两点不同：
 *  1. 枚举是**扩大**（加 'pet' / 'pet_state'），现存业务行都是 agent/voice/config/chat_history，
 *     无需先删行；重建期间仍需先删复合索引（该列被索引依赖），改列后回建。
 *  2. 本迁移**可回滚**（旧迁移是「删表+收窄」，刻意不可逆；本次是纯新建+扩枚举）。
 *
 * 破坏性操作前置（项目硬约束）：执行前需
 *   · `pg_dump desktop_pet_platform` 全量备份到 `Environment/backups/before-pet-rebuild-*.sql`
 *   · 临时库恢复演练 + `migration:revert` 演练（见实施计划 §2）
 *
 * 说明：`user_sync_data` 里 `kind='config'` 的 config jsonb 由客户端透传写入，
 * 服务端无需键白名单，因此 up() **不写任何 config 数据**；宠物键由客户端首次写入自然出现。
 */
export class RebuildPetPacks1791200000000 implements MigrationInterface {
  name = 'RebuildPetPacks1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1) 重建宠物包表（枚举 → 表 → 索引 → 外键；DDL 照抄 AddPetPacks1791041000000）──
    await queryRunner.query(`CREATE TYPE "public"."pet_packs_status_enum" AS ENUM('pending', 'approved', 'rejected')`);
    await queryRunner.query(`CREATE TABLE "pet_packs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "description" text, "author_id" uuid NOT NULL, "category" character varying(50), "tags" jsonb NOT NULL DEFAULT '[]', "pack_url" character varying(255) NOT NULL, "pack_sha256" character varying(64) NOT NULL, "pack_bytes" integer, "pack_schema_version" integer NOT NULL DEFAULT '1', "manifest" jsonb, "body_kinds" text array NOT NULL DEFAULT '{}', "preview_url" character varying(255), "version" character varying(20) NOT NULL DEFAULT '1.0.0', "downloads" integer NOT NULL DEFAULT '0', "rating" double precision NOT NULL DEFAULT '0', "status" "public"."pet_packs_status_enum" NOT NULL DEFAULT 'pending', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b0751faa907ec8d282098c47455" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_8ec3883c97ce460097881670b8" ON "pet_packs" ("status") `);
    await queryRunner.query(`ALTER TABLE "pet_packs" ADD CONSTRAINT "FK_a86418b08d1c0ab19dfa75a4547" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

    // ── 2) reviews.asset_type → ('agent','voice','pet')（扩大；索引先删后建）──────
    await queryRunner.query(`DROP INDEX "public"."IDX_7a44ce3847f2132fd778b79fff"`);
    await queryRunner.query(`ALTER TYPE "public"."reviews_asset_type_enum" RENAME TO "reviews_asset_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."reviews_asset_type_enum" AS ENUM('agent', 'voice', 'pet')`);
    await queryRunner.query(
      `ALTER TABLE "reviews" ALTER COLUMN "asset_type" TYPE "public"."reviews_asset_type_enum" USING "asset_type"::"text"::"public"."reviews_asset_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."reviews_asset_type_enum_old"`);
    await queryRunner.query(`CREATE INDEX "IDX_7a44ce3847f2132fd778b79fff" ON "reviews" ("asset_type", "asset_id") `);

    // ── 3) download_records.asset_type → ('agent','voice','pet') ─────────────
    await queryRunner.query(`DROP INDEX "public"."IDX_8d22c86c970ad4f47756bd177f"`);
    await queryRunner.query(
      `ALTER TYPE "public"."download_records_asset_type_enum" RENAME TO "download_records_asset_type_enum_old"`,
    );
    await queryRunner.query(`CREATE TYPE "public"."download_records_asset_type_enum" AS ENUM('agent', 'voice', 'pet')`);
    await queryRunner.query(
      `ALTER TABLE "download_records" ALTER COLUMN "asset_type" TYPE "public"."download_records_asset_type_enum" USING "asset_type"::"text"::"public"."download_records_asset_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."download_records_asset_type_enum_old"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_8d22c86c970ad4f47756bd177f" ON "download_records" ("asset_type", "asset_id") `,
    );

    // ── 4) user_sync_data.kind → ('config','chat_history','pet_state') ────────
    // 标签是**下划线**风格 `pet_state`（写成连字符会 22P02 invalid input value for enum）。
    await queryRunner.query(`ALTER TYPE "public"."user_sync_data_kind_enum" RENAME TO "user_sync_data_kind_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."user_sync_data_kind_enum" AS ENUM('config', 'chat_history', 'pet_state')`);
    await queryRunner.query(
      `ALTER TABLE "user_sync_data" ALTER COLUMN "kind" TYPE "public"."user_sync_data_kind_enum" USING "kind"::"text"::"public"."user_sync_data_kind_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."user_sync_data_kind_enum_old"`);
  }

  /**
   * 可回滚：先删掉枚举里将消失的值的业务行，再逐项收窄枚举，最后删表。
   * 注意：config jsonb 里的 12 个宠物键**不回填**（原值不可知）——这类损失仅限宠物偏好，
   * 用户可重新设置；若需完整还原请用 `Environment/backups/before-pet-rebuild-*.sql`。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── 1) 先删业务行（否则下面 ALTER COLUMN 会因目标枚举不含 'pet'/'pet_state' 失败）──
    await queryRunner.query(`DELETE FROM "reviews" WHERE "asset_type"::text = 'pet'`);
    await queryRunner.query(`DELETE FROM "download_records" WHERE "asset_type"::text = 'pet'`);
    await queryRunner.query(`DELETE FROM "user_sync_data" WHERE "kind" = 'pet_state'`);

    // ── 2) 收窄 reviews.asset_type → ('agent','voice') ───────────────────────
    await queryRunner.query(`DROP INDEX "public"."IDX_7a44ce3847f2132fd778b79fff"`);
    await queryRunner.query(`ALTER TYPE "public"."reviews_asset_type_enum" RENAME TO "reviews_asset_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."reviews_asset_type_enum" AS ENUM('agent', 'voice')`);
    await queryRunner.query(
      `ALTER TABLE "reviews" ALTER COLUMN "asset_type" TYPE "public"."reviews_asset_type_enum" USING "asset_type"::"text"::"public"."reviews_asset_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."reviews_asset_type_enum_old"`);
    await queryRunner.query(`CREATE INDEX "IDX_7a44ce3847f2132fd778b79fff" ON "reviews" ("asset_type", "asset_id") `);

    // ── 3) 收窄 download_records.asset_type → ('agent','voice') ──────────────
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

    // ── 4) 收窄 user_sync_data.kind → ('config','chat_history') ──────────────
    await queryRunner.query(`ALTER TYPE "public"."user_sync_data_kind_enum" RENAME TO "user_sync_data_kind_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."user_sync_data_kind_enum" AS ENUM('config', 'chat_history')`);
    await queryRunner.query(
      `ALTER TABLE "user_sync_data" ALTER COLUMN "kind" TYPE "public"."user_sync_data_kind_enum" USING "kind"::"text"::"public"."user_sync_data_kind_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."user_sync_data_kind_enum_old"`);

    // ── 5) 删宠物包表（外键 → 索引 → 表 → 枚举）──────────────────────────────
    await queryRunner.query(`ALTER TABLE "pet_packs" DROP CONSTRAINT "FK_a86418b08d1c0ab19dfa75a4547"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8ec3883c97ce460097881670b8"`);
    await queryRunner.query(`DROP TABLE "pet_packs"`);
    await queryRunner.query(`DROP TYPE "public"."pet_packs_status_enum"`);
  }
}
