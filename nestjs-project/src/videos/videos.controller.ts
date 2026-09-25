import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { CreateVideoUploadResponseDto } from './dto/create-video-upload-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video draft in the caller channel and starts a multipart upload, returning the server-dictated chunking contract.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload started',
    schema: {
      properties: {
        videoId: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        uploadId: { type: 'string' },
        partSize: { type: 'integer' },
        partCount: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'VIDEO_TOO_LARGE, UNSUPPORTED_VIDEO_TYPE or VALIDATION_ERROR',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoUploadDto,
  ): Promise<CreateVideoUploadResponseDto> {
    return this.videosService.createUpload(user.sub, dto);
  }
}
