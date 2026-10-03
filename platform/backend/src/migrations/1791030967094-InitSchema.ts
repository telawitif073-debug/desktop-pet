import { MigrationInterface, QueryRunner } from "typeorm";

export class InitSchema1791030967094 implements MigrationInterface {
    name = 'InitSchema1791030967094'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('user', 'admin')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying(100) NOT NULL, "username" character varying(50) NOT NULL, "password_hash" character varying(255) NOT NULL, "avatar_url" character varying(255), "role" "public"."users_role_enum" NOT NULL DEFAULT 'user', "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE ("username"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."voice_assets_status_enum" AS ENUM('pending', 'approved', 'rejected')`);
        await queryRunner.query(`CREATE TABLE "voice_assets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "description" text, "author_id" uuid NOT NULL, "config_schema" jsonb NOT NULL, "file_url" character varying(255), "version" character varying(20) NOT NULL DEFAULT '1.0.0', "downloads" integer NOT NULL DEFAULT '0', "rating" double precision NOT NULL DEFAULT '0', "status" "public"."voice_assets_status_enum" NOT NULL DEFAULT 'pending', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d2ef71e20c12dd953351bf118bf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c894b5d17876de82ac1db604e2" ON "voice_assets" ("status") `);
        await queryRunner.query(`CREATE TYPE "public"."user_sync_data_kind_enum" AS ENUM('config', 'pet_state', 'chat_history')`);
        await queryRunner.query(`CREATE TABLE "user_sync_data" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "kind" "public"."user_sync_data_kind_enum" NOT NULL, "data" jsonb NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d156885aa79800d7d146c1249ca" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_dbef61beb5dbb2a05dfe8a3e55" ON "user_sync_data" ("user_id", "kind") `);
        await queryRunner.query(`CREATE TYPE "public"."pet_assets_format_enum" AS ENUM('image', 'pack', 'live2d', 'model3d', 'sprite')`);
        await queryRunner.query(`CREATE TYPE "public"."pet_assets_status_enum" AS ENUM('pending', 'approved', 'rejected')`);
        await queryRunner.query(`CREATE TABLE "pet_assets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "description" text, "format" "public"."pet_assets_format_enum" NOT NULL DEFAULT 'image', "author_id" uuid NOT NULL, "category" character varying(50), "tags" jsonb NOT NULL DEFAULT '[]', "preview_url" character varying(255), "background_url" character varying(255), "file_url" character varying(255) NOT NULL, "version" character varying(20) NOT NULL DEFAULT '1.0.0', "downloads" integer NOT NULL DEFAULT '0', "rating" double precision NOT NULL DEFAULT '0', "status" "public"."pet_assets_status_enum" NOT NULL DEFAULT 'pending', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_64a9020a2ee7a6e91a13455bd9a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_51684a952e972ff35b89c74d29" ON "pet_assets" ("format") `);
        await queryRunner.query(`CREATE INDEX "IDX_b90937eeef7428e6d4086e005e" ON "pet_assets" ("status") `);
        await queryRunner.query(`CREATE TYPE "public"."reviews_asset_type_enum" AS ENUM('pet', 'agent', 'action', 'voice')`);
        await queryRunner.query(`CREATE TABLE "reviews" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "asset_type" "public"."reviews_asset_type_enum" NOT NULL, "asset_id" uuid NOT NULL, "rating" integer, "comment" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_231ae565c273ee700b283f15c1d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7a44ce3847f2132fd778b79fff" ON "reviews" ("asset_type", "asset_id") `);
        await queryRunner.query(`CREATE TYPE "public"."download_records_asset_type_enum" AS ENUM('pet', 'agent', 'action', 'voice')`);
        await queryRunner.query(`CREATE TABLE "download_records" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid, "asset_type" "public"."download_records_asset_type_enum" NOT NULL, "asset_id" uuid NOT NULL, "downloaded_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_38fde111105ca11a6691e6c58dd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8d22c86c970ad4f47756bd177f" ON "download_records" ("asset_type", "asset_id") `);
        await queryRunner.query(`CREATE TABLE "multi_agent_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "owner_id" uuid NOT NULL, "agent_profile_id" text NOT NULL, "title" text NOT NULL DEFAULT '', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6147edd9f97c0024fa307336556" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a8520244e8582ac80ab0c6616d" ON "multi_agent_sessions" ("owner_id", "agent_profile_id") `);
        await queryRunner.query(`CREATE TABLE "multi_agent_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "session_id" uuid NOT NULL, "role" text NOT NULL, "agent_id" text, "content" text NOT NULL DEFAULT '', "latency_ms" integer, "error" text, "meta" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_398c5bfae0614ad286866b47037" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4eeb7c5a3c1ff883c5e0bccdf4" ON "multi_agent_messages" ("session_id") `);
        await queryRunner.query(`CREATE TYPE "public"."agent_assets_type_enum" AS ENUM('chat', 'task', 'mixed')`);
        await queryRunner.query(`CREATE TYPE "public"."agent_assets_status_enum" AS ENUM('pending', 'approved', 'rejected')`);
        await queryRunner.query(`CREATE TABLE "agent_assets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "description" text, "author_id" uuid NOT NULL, "type" "public"."agent_assets_type_enum" NOT NULL DEFAULT 'chat', "config_schema" jsonb, "dependencies" jsonb NOT NULL DEFAULT '[]', "file_url" character varying(255) NOT NULL, "preview_url" character varying(255), "version" character varying(20) NOT NULL DEFAULT '1.0.0', "downloads" integer NOT NULL DEFAULT '0', "rating" double precision NOT NULL DEFAULT '0', "status" "public"."agent_assets_status_enum" NOT NULL DEFAULT 'pending', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7c938f338b26f46910a988e724b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cddd92f729671afc14a5e187a7" ON "agent_assets" ("status") `);
        await queryRunner.query(`CREATE TYPE "public"."action_assets_interaction_enum" AS ENUM('none', 'feed', 'rest', 'play')`);
        await queryRunner.query(`CREATE TYPE "public"."action_assets_kind_enum" AS ENUM('frames', 'clip')`);
        await queryRunner.query(`CREATE TABLE "action_assets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "pet_id" uuid NOT NULL, "name" character varying(100) NOT NULL, "description" text, "author_id" uuid NOT NULL, "interaction" "public"."action_assets_interaction_enum" NOT NULL DEFAULT 'none', "kind" "public"."action_assets_kind_enum" NOT NULL DEFAULT 'frames', "clip_name" character varying(100), "frame_count" integer NOT NULL DEFAULT '0', "file_url" character varying(255) NOT NULL, "version" character varying(20) NOT NULL DEFAULT '1.0.0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_61817bf73611d92324e9ab3e68b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_50ac52e6605e284a188eaeafd0" ON "action_assets" ("interaction") `);
        await queryRunner.query(`CREATE INDEX "IDX_0c3df3e7c400c44c267c5d786b" ON "action_assets" ("pet_id") `);
        await queryRunner.query(`ALTER TABLE "voice_assets" ADD CONSTRAINT "FK_995ac9ac98a9347af8490589b95" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_sync_data" ADD CONSTRAINT "FK_133c5c8dedac6643647f36a2ce7" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pet_assets" ADD CONSTRAINT "FK_91bcce5eb51adbfcaaab85b9aec" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "reviews" ADD CONSTRAINT "FK_728447781a30bc3fcfe5c2f1cdf" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "download_records" ADD CONSTRAINT "FK_f55a1e87cd998f7f4c8ebb5a5ab" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "multi_agent_sessions" ADD CONSTRAINT "FK_fb52bfea75fcd0197aff7105e15" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "multi_agent_messages" ADD CONSTRAINT "FK_4eeb7c5a3c1ff883c5e0bccdf49" FOREIGN KEY ("session_id") REFERENCES "multi_agent_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "agent_assets" ADD CONSTRAINT "FK_be2fbe8dc4e37bcf6f3aee55e89" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "action_assets" ADD CONSTRAINT "FK_0c3df3e7c400c44c267c5d786b8" FOREIGN KEY ("pet_id") REFERENCES "pet_assets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "action_assets" ADD CONSTRAINT "FK_580277fa4f93350e2a8f5efebcb" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "action_assets" DROP CONSTRAINT "FK_580277fa4f93350e2a8f5efebcb"`);
        await queryRunner.query(`ALTER TABLE "action_assets" DROP CONSTRAINT "FK_0c3df3e7c400c44c267c5d786b8"`);
        await queryRunner.query(`ALTER TABLE "agent_assets" DROP CONSTRAINT "FK_be2fbe8dc4e37bcf6f3aee55e89"`);
        await queryRunner.query(`ALTER TABLE "multi_agent_messages" DROP CONSTRAINT "FK_4eeb7c5a3c1ff883c5e0bccdf49"`);
        await queryRunner.query(`ALTER TABLE "multi_agent_sessions" DROP CONSTRAINT "FK_fb52bfea75fcd0197aff7105e15"`);
        await queryRunner.query(`ALTER TABLE "download_records" DROP CONSTRAINT "FK_f55a1e87cd998f7f4c8ebb5a5ab"`);
        await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT "FK_728447781a30bc3fcfe5c2f1cdf"`);
        await queryRunner.query(`ALTER TABLE "pet_assets" DROP CONSTRAINT "FK_91bcce5eb51adbfcaaab85b9aec"`);
        await queryRunner.query(`ALTER TABLE "user_sync_data" DROP CONSTRAINT "FK_133c5c8dedac6643647f36a2ce7"`);
        await queryRunner.query(`ALTER TABLE "voice_assets" DROP CONSTRAINT "FK_995ac9ac98a9347af8490589b95"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0c3df3e7c400c44c267c5d786b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_50ac52e6605e284a188eaeafd0"`);
        await queryRunner.query(`DROP TABLE "action_assets"`);
        await queryRunner.query(`DROP TYPE "public"."action_assets_kind_enum"`);
        await queryRunner.query(`DROP TYPE "public"."action_assets_interaction_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cddd92f729671afc14a5e187a7"`);
        await queryRunner.query(`DROP TABLE "agent_assets"`);
        await queryRunner.query(`DROP TYPE "public"."agent_assets_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."agent_assets_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4eeb7c5a3c1ff883c5e0bccdf4"`);
        await queryRunner.query(`DROP TABLE "multi_agent_messages"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a8520244e8582ac80ab0c6616d"`);
        await queryRunner.query(`DROP TABLE "multi_agent_sessions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8d22c86c970ad4f47756bd177f"`);
        await queryRunner.query(`DROP TABLE "download_records"`);
        await queryRunner.query(`DROP TYPE "public"."download_records_asset_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7a44ce3847f2132fd778b79fff"`);
        await queryRunner.query(`DROP TABLE "reviews"`);
        await queryRunner.query(`DROP TYPE "public"."reviews_asset_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b90937eeef7428e6d4086e005e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_51684a952e972ff35b89c74d29"`);
        await queryRunner.query(`DROP TABLE "pet_assets"`);
        await queryRunner.query(`DROP TYPE "public"."pet_assets_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."pet_assets_format_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dbef61beb5dbb2a05dfe8a3e55"`);
        await queryRunner.query(`DROP TABLE "user_sync_data"`);
        await queryRunner.query(`DROP TYPE "public"."user_sync_data_kind_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c894b5d17876de82ac1db604e2"`);
        await queryRunner.query(`DROP TABLE "voice_assets"`);
        await queryRunner.query(`DROP TYPE "public"."voice_assets_status_enum"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
    }

}
