import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
  type CompletedPart,
  type Part,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { InvalidUploadPartsException } from '../common/exceptions/domain.exception';

const INVALID_UPLOAD_PARTS_ERROR_NAMES = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'NoSuchUpload',
]);

// These three codes aren't modeled as typed exceptions for CompleteMultipartUpload
// in the SDK, so they surface as a generic S3ServiceException with `.name` set to
// the S3 error Code. Narrowing to S3ServiceException (rather than plain `Error`)
// keeps an unrelated error that happens to share one of these names from being
// misclassified as INVALID_UPLOAD_PARTS.
function isInvalidUploadPartsError(err: unknown): boolean {
  return (
    err instanceof S3ServiceException &&
    INVALID_UPLOAD_PARTS_ERROR_NAMES.has(err.name)
  );
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly cfg: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.cfg.videosBucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(
        'S3 did not return an UploadId for CreateMultipartUpload',
      );
    }
    return UploadId;
  }

  async listParts(key: string, uploadId: string): Promise<Part[]> {
    const { Parts } = await this.internalClient.send(
      new ListPartsCommand({
        Bucket: this.cfg.videosBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
    return Parts ?? [];
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.cfg.videosBucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (err) {
      if (isInvalidUploadPartsError(err)) {
        throw new InvalidUploadPartsException();
      }
      throw err;
    }
  }

  async headObject(key: string): Promise<number> {
    const { ContentLength } = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.cfg.videosBucket, Key: key }),
    );
    return ContentLength ?? 0;
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.cfg.videosBucket, Key: key }),
    );
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.cfg.videosBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async presignGetObject(
    key: string,
    expiresIn: number,
    contentDisposition?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.cfg.videosBucket,
        Key: key,
        ResponseContentDisposition: contentDisposition,
      }),
      { expiresIn },
    );
  }

  async presignInternalGetObject(
    key: string,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.cfg.videosBucket, Key: key }),
      { expiresIn },
    );
  }

  async putThumbnail(key: string, body: Buffer): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.cfg.thumbnailsBucket,
        Key: key,
        Body: body,
        ContentType: 'image/jpeg',
      }),
    );
  }

  getThumbnailPublicUrl(key: string): string {
    return `${this.cfg.publicEndpoint}/${this.cfg.thumbnailsBucket}/${key}`;
  }
}
