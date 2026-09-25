import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
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
import { PresignPartsDto } from './dto/presign-parts.dto';
import { PresignPartsResponseDto } from './dto/presign-parts-response.dto';
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

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Presign upload part URLs',
    description:
      'Returns presigned PUT URLs for the requested part numbers of an owned, awaiting-upload video.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
        expiresIn: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'INVALID_PART_NUMBER or VALIDATION_ERROR',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignPartsDto,
  ): Promise<PresignPartsResponseDto> {
    return this.videosService.presignParts(id, user.sub, dto.partNumbers);
  }
}
