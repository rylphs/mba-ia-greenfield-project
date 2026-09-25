import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  InvalidPartNumberException,
  InvalidVideoStateException,
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { isPgUniqueViolationOnColumn } from '../common/typeorm/pg-errors';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { videoObjectKey } from '../storage/storage-keys';
import uploadConfig from '../config/upload.config';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { CreateVideoUploadResponseDto } from './dto/create-video-upload-response.dto';
import { PresignPartsResponseDto } from './dto/presign-parts-response.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { generateVideoSlug } from './video-slug';

const SLUG_COLUMN = 'slug';
const MAX_SLUG_ATTEMPTS = 3;
const SLUG_SAVEPOINT = 'slug_attempt';

function stripExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video) private readonly videoRepo: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(uploadConfig.KEY)
    private readonly uploadCfg: ConfigType<typeof uploadConfig>,
  ) {}

  async createUpload(
    userId: string,
    dto: CreateVideoUploadDto,
  ): Promise<CreateVideoUploadResponseDto> {
    if (dto.fileSize > this.uploadCfg.maxVideoSizeBytes) {
      throw new VideoTooLargeException();
    }
    if (!dto.contentType.startsWith('video/')) {
      throw new UnsupportedVideoTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const title = stripExtension(dto.fileName);
    const partSize = this.uploadCfg.partSizeBytes;
    const partCount = Math.ceil(dto.fileSize / partSize);

    return this.videoRepo.manager.transaction(async (manager) => {
      let video: Video | undefined;

      for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
        await manager.query(`SAVEPOINT ${SLUG_SAVEPOINT}`);
        try {
          video = await manager.save(
            manager.create(Video, {
              slug: generateVideoSlug(),
              channel_id: channel.id,
              title,
              description: null,
              original_filename: dto.fileName,
              content_type: dto.contentType,
              declared_size_bytes: dto.fileSize,
              upload_part_size_bytes: partSize,
              upload_part_count: partCount,
            }),
          );
          await manager.query(`RELEASE SAVEPOINT ${SLUG_SAVEPOINT}`);
          break;
        } catch (err) {
          await manager.query(`ROLLBACK TO SAVEPOINT ${SLUG_SAVEPOINT}`);
          if (
            !isPgUniqueViolationOnColumn(err, SLUG_COLUMN) ||
            attempt === MAX_SLUG_ATTEMPTS
          ) {
            throw err;
          }
        }
      }

      if (!video) {
        throw new Error('Failed to create video after slug retries');
      }

      const uploadId = await this.storageService.createMultipartUpload(
        videoObjectKey(video.id),
        dto.contentType,
      );
      await manager.update(Video, video.id, { upload_id: uploadId });

      return {
        videoId: video.id,
        slug: video.slug,
        uploadId,
        partSize,
        partCount,
      };
    });
  }

  async findOwnedById(videoId: string, userId: string): Promise<Video> {
    const video = await this.videoRepo
      .createQueryBuilder('video')
      .innerJoin('video.channel', 'channel', 'channel.user_id = :userId', {
        userId,
      })
      .where('video.id = :videoId', { videoId })
      .getOne();

    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  assertAwaitingUpload(
    video: Video,
  ): asserts video is Video & { upload_id: string } {
    if (video.processing_status !== VideoProcessingStatus.AWAITING_UPLOAD) {
      throw new InvalidVideoStateException();
    }
    if (!video.upload_id) {
      throw new Error(
        `Video ${video.id} is awaiting_upload but has no upload_id`,
      );
    }
  }

  async presignParts(
    videoId: string,
    userId: string,
    partNumbers: number[],
  ): Promise<PresignPartsResponseDto> {
    const video = await this.findOwnedById(videoId, userId);
    this.assertAwaitingUpload(video);

    if (partNumbers.some((n) => n > video.upload_part_count)) {
      throw new InvalidPartNumberException();
    }

    const { upload_id: uploadId, id } = video;
    const expiresIn = this.uploadCfg.uploadUrlExpiresSeconds;
    const key = videoObjectKey(id);

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          key,
          uploadId,
          partNumber,
          expiresIn,
        ),
      })),
    );

    return { parts, expiresIn };
  }

  async listUploadedParts(
    videoId: string,
    userId: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = await this.findOwnedById(videoId, userId);
    this.assertAwaitingUpload(video);

    const uploadedParts = await this.storageService.listParts(
      videoObjectKey(video.id),
      video.upload_id,
    );

    const parts = uploadedParts
      .map((part) => ({
        partNumber: part.PartNumber!,
        etag: part.ETag!,
        size: part.Size!,
      }))
      .sort((a, b) => a.partNumber - b.partNumber);

    return {
      parts,
      partSize: video.upload_part_size_bytes,
      partCount: video.upload_part_count,
    };
  }
}
