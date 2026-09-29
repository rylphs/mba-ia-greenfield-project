import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1790357447592 implements MigrationInterface {
  name = 'CreateVideos1790357447592';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_publication_status_enum" AS ENUM('draft')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_processing_status_enum" AS ENUM('awaiting_upload', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "slug" character varying(11) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(255) NOT NULL, "description" text, "original_filename" character varying(255) NOT NULL, "content_type" character varying(255) NOT NULL, "declared_size_bytes" bigint NOT NULL, "upload_part_size_bytes" integer NOT NULL, "upload_part_count" integer NOT NULL, "upload_id" character varying(1024), "publication_status" "public"."videos_publication_status_enum" NOT NULL DEFAULT 'draft', "processing_status" "public"."videos_processing_status_enum" NOT NULL DEFAULT 'awaiting_upload', "processing_error" text, "duration" numeric(12,3), "width" integer, "height" integer, "video_codec" character varying(50), "audio_codec" character varying(50), "size_bytes" bigint, "mime" character varying(100), "thumbnail_key" character varying(255), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5dbcc1ee100f853490582eccc71" UNIQUE ("slug"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(
      `DROP TYPE "public"."videos_processing_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."videos_publication_status_enum"`,
    );
  }
}
