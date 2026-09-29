import { VideoProcessingStatus } from '../entities/video.entity';

export class CompleteUploadResponseDto {
  videoId: string;
  slug: string;
  processingStatus: VideoProcessingStatus.PROCESSING;
}
