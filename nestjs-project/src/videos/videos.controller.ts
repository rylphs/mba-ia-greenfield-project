import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpRedirectResponse,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
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
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { VideoSlugParamDto } from './dto/video-slug-param.dto';
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

  @Get(':id/upload/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts already received by storage for an owned, awaiting-upload video, so an interrupted upload can be resumed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer' },
              etag: { type: 'string' },
              size: { type: 'integer' },
            },
          },
        },
        partSize: { type: 'integer' },
        partCount: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR',
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
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videosService.listUploadedParts(id, user.sub);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finishes the multipart upload, verifies the real uploaded size and, on success, moves the video to processing and enqueues the processing job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed, processing started',
    schema: {
      properties: {
        videoId: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        processingStatus: { type: 'string', enum: ['processing'] },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'INVALID_UPLOAD_PARTS, VIDEO_TOO_LARGE or VALIDATION_ERROR',
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
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(id, user.sub, dto.parts);
  }

  @Get(':slug/stream')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Authorizes and redirects to a presigned GetObject URL; storage serves Range requests natively, so no bytes pass through the API.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned GET URL',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR',
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
    description: 'VIDEO_NOT_READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoSlugParamDto,
  ): Promise<HttpRedirectResponse> {
    const url = await this.videosService.getStreamUrl(
      params.slug,
      user.sub,
    );
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':slug/download')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Authorizes and redirects to a presigned GetObject URL with an attachment Content-Disposition, so the browser downloads the file under its original name.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned GET URL with attachment disposition',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR',
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
    description: 'VIDEO_NOT_READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoSlugParamDto,
  ): Promise<HttpRedirectResponse> {
    const url = await this.videosService.getDownloadUrl(
      params.slug,
      user.sub,
    );
    return { url, statusCode: HttpStatus.FOUND };
  }
}
