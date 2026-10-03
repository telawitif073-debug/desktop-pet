import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 新建宠物包表 `pet_packs` + 为 reviews / download_records 回补 `'pet'` 枚举值
 * ===========================================================================
 * 背景（设计文档 `.trae/documents/pet-store-successor-design.md` 实施清单第 2 步）：
 * 旧宠物商店（`pet_assets` / `action_assets`）已由 1791036000000 删除，平台侧
 * 「发布 / 浏览 / 下载 / 安装」一度没有承接方。本迁移落地新载体——**宠物包**：
 *
 *  1. `pet_packs`：以 `pack_url`（zip）为唯一必填载体（不再有 `file_url`），
 *     并增加 `pack_sha256`（完整性校验）、`body_kinds`（**由校验结果派生**的本体类型，
 *     供筛选）、`manifest`（校验时清单快照，审核页直接展示）、`pack_schema_version`
 *     （包格式版本，便于将来重算派生字段）。
 *     刻意**不建动作表**：动作是包内 `pet/actions.json` 的一部分。
 *
 *  2. `reviews` / `download_records` 的 `asset_type` 回补 `'pet'`：
 *     `'pet'` 的语义没变（载体从「单个文件」变成「包」），只是被 1791036000000
 *     连同旧表一起剔除了。**这是一次「先删后补」的顺序教训**——破坏性删除本应排在
 *     替代方案定稿之后（见设计文档 §六）。
 *
 * 为什么用「建新类型 → 改列 → 删旧类型 → 改名」重建枚举，而不是
 * `ALTER TYPE ... ADD VALUE`：后者不可回滚（Postgres 无法删除枚举值），
 * 而本项目要求每条 migration 都有可用的 `down()`。同理，因两张表的
 * `(asset_type, asset_id)` 复合索引依赖该列，重建期间需要先删后建（TypeORM 生成）。
 *
 * 注意：本迁移**只建表与改枚举，不迁移任何旧数据**——旧数据已按设计文档 §1.1 的
 * 证据判定为「全部 file_url 为空 + 多为 E2E 测试数据」而放弃（已导出留档于
 * `Environment/build/backups/`）。发布（写入本表）由实施清单第 3 步的服务端包校验负责。
 *
 * 回滚：`down()` 会删表、删索引并重建不含 `'pet'` 的枚举；若库中已存在
 * `asset_type='pet'` 的业务行，回滚会因为枚举不含该值而失败（这是刻意的：
 * 宁可报错也不要静默丢数据），需先清理这些行再回滚。
 */
export class AddPetPacks1791041000000 implements MigrationInterface {
  name = 'AddPetPacks1791041000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1) 宠物包表 ─────────────────────────────────────────────────────────
    await queryRunner.query(`CREATE TYPE "public"."pet_packs_status_enum" AS ENUM('pending', 'approved', 'rejected')`);
    await queryRunner.query(`CREATE TABLE "pet_packs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "description" text, "author_id" uuid NOT NULL, "category" character varying(50), "tags" jsonb NOT NULL DEFAULT '[]', "pack_url" character varying(255) NOT NULL, "pack_sha256" character varying(64) NOT NULL, "pack_bytes" integer, "pack_schema_version" integer NOT NULL DEFAULT '1', "manifest" jsonb, "body_kinds" text array NOT NULL DEFAULT '{}', "preview_url" character varying(255), "version" character varying(20) NOT NULL DEFAULT '1.0.0', "downloads" integer NOT NULL DEFAULT '0', "rating" double precision NOT NULL DEFAULT '0', "status" "public"."pet_packs_status_enum" NOT NULL DEFAULT 'pending', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b0751faa907ec8d282098c47455" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_8ec3883c97ce460097881670b8" ON "pet_packs" ("status") `);
    await queryRunner.query(`ALTER TABLE "pet_packs" ADD CONSTRAINT "FK_a86418b08d1c0ab19dfa75a4547" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

    // ── 2) reviews.asset_type 回补 'pet'（重建类型，名字保持不变以免元数据漂移） ──
    await queryRunner.query(`DROP INDEX "public"."IDX_7a44ce3847f2132fd778b79fff"`);
    await queryRunner.query(`ALTER TYPE "public"."reviews_asset_type_enum" RENAME TO "reviews_asset_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."reviews_asset_type_enum" AS ENUM('agent', 'action', 'voice', 'pet')`);
    await queryRunner.query(`ALTER TABLE "reviews" ALTER COLUMN "asset_type" TYPE "public"."reviews_asset_type_enum" USING "asset_type"::"text"::"public"."reviews_asset_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."reviews_asset_type_enum_old"`);
    await queryRunner.query(`CREATE INDEX "IDX_7a44ce3847f2132fd778b79fff" ON "reviews" ("asset_type", "asset_id") `);

    // ── 3) download_records.asset_type 回补 'pet' ───────────────────────────
    await queryRunner.query(`DROP INDEX "public"."IDX_8d22c86c970ad4f47756bd177f"`);
    await queryRunner.query(`ALTER TYPE "public"."download_records_asset_type_enum" RENAME TO "download_records_asset_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."download_records_asset_type_enum" AS ENUM('agent', 'action', 'voice', 'pet')`);
    await queryRunner.query(`ALTER TABLE "download_records" ALTER COLUMN "asset_type" TYPE "public"."download_records_asset_type_enum" USING "asset_type"::"text"::"public"."download_records_asset_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."download_records_asset_type_enum_old"`);
    await queryRunner.query(`CREATE INDEX "IDX_8d22c86c970ad4f47756bd177f" ON "download_records" ("asset_type", "asset_id") `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 依赖顺序与 up 相反：先退回枚举（若已有 asset_type='pet' 的行，这里会因枚举
    // 不含 'pet' 而报错中止——宁可失败也不静默丢数据），再删表。
    await queryRunner.query(`DROP INDEX "public"."IDX_8d22c86c970ad4f47756bd177f"`);
    await queryRunner.query(`CREATE TYPE "public"."download_records_asset_type_enum_old" AS ENUM('agent', 'action', 'voice')`);
    await queryRunner.query(`ALTER TABLE "download_records" ALTER COLUMN "asset_type" TYPE "public"."download_records_asset_type_enum_old" USING "asset_type"::"text"::"public"."download_records_asset_type_enum_old"`);
    await queryRunner.query(`DROP TYPE "public"."download_records_asset_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."download_records_asset_type_enum_old" RENAME TO "download_records_asset_type_enum"`);
    await queryRunner.query(`CREATE INDEX "IDX_8d22c86c970ad4f47756bd177f" ON "download_records" ("asset_type", "asset_id") `);

    await queryRunner.query(`DROP INDEX "public"."IDX_7a44ce3847f2132fd778b79fff"`);
    await queryRunner.query(`CREATE TYPE "public"."reviews_asset_type_enum_old" AS ENUM('agent', 'action', 'voice')`);
    await queryRunner.query(`ALTER TABLE "reviews" ALTER COLUMN "asset_type" TYPE "public"."reviews_asset_type_enum_old" USING "asset_type"::"text"::"public"."reviews_asset_type_enum_old"`);
    await queryRunner.query(`DROP TYPE "public"."reviews_asset_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."reviews_asset_type_enum_old" RENAME TO "reviews_asset_type_enum"`);
    await queryRunner.query(`CREATE INDEX "IDX_7a44ce3847f2132fd778b79fff" ON "reviews" ("asset_type", "asset_id") `);

    await queryRunner.query(`ALTER TABLE "pet_packs" DROP CONSTRAINT "FK_a86418b08d1c0ab19dfa75a4547"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8ec3883c97ce460097881670b8"`);
    await queryRunner.query(`DROP TABLE "pet_packs"`);
    await queryRunner.query(`DROP TYPE "public"."pet_packs_status_enum"`);
  }
}
