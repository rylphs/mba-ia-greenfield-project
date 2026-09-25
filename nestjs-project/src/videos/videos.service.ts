import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  UnsupportedVideoTypeException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { isPgUniqueViolationOnColumn } from '../common/typeorm/pg-errors';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { videoObjectKey } from '../storage/storage-keys';
import uploadConfig from '../config/upload.config';
import { Video } from './entities/video.entity';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { CreateVideoUploadResponseDto } from './dto/create-video-upload-response.dto';
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
}
