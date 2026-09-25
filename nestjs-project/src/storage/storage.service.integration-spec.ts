import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { requestViaInternalNetwork } from '../test/minio';
import { thumbnailObjectKey, videoObjectKey } from './storage-keys';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const internalS3 = new URL(process.env.S3_ENDPOINT!);

async function uploadTestObject(
  storageService: StorageService,
  key: string,
  body: Buffer,
): Promise<{ uploadId: string; etag: string; partUrl: string }> {
  const uploadId = await storageService.createMultipartUpload(key, 'video/mp4');
  const partUrl = await storageService.presignUploadPart(key, uploadId, 1, 60);
  const etag = (
    await requestViaInternalNetwork(partUrl, { method: 'PUT', body })
  ).headers.etag as string;
  await storageService.completeMultipartUpload(key, uploadId, [
    { ETag: etag, PartNumber: 1 },
  ]);
  return { uploadId, etag, partUrl };
}

describe('StorageService (integration)', () => {
  let storageService: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
  });

  it('runs the multipart cycle via a presigned URL and reports the total size on headObject', async () => {
    const key = videoObjectKey(`it-${Date.now()}`);
    const body = Buffer.from('integration-test-video-bytes');

    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    const partUrl = await storageService.presignUploadPart(
      key,
      uploadId,
      1,
      60,
    );
    expect(new URL(partUrl).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).host,
    );

    const putResponse = await requestViaInternalNetwork(partUrl, {
      method: 'PUT',
      body,
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.etag as string;
    expect(etag).toBeTruthy();

    const parts = await storageService.listParts(key, uploadId);
    expect(parts).toHaveLength(1);
    expect(parts[0].ETag).toBe(etag);

    await storageService.completeMultipartUpload(key, uploadId, [
      { ETag: etag, PartNumber: 1 },
    ]);

    const size = await storageService.headObject(key);
    expect(size).toBe(body.length);

    await storageService.deleteObject(key);
  }, 30000);

  it('presigns a GET with Content-Disposition and honors Range requests', async () => {
    const key = videoObjectKey(`it-disp-${Date.now()}`);
    const body = Buffer.from('range-and-disposition-bytes');
    await uploadTestObject(storageService, key, body);

    const downloadUrl = await storageService.presignGetObject(
      key,
      60,
      'attachment; filename="a.mp4"',
    );
    const [getResponse, rangeResponse] = await Promise.all([
      requestViaInternalNetwork(downloadUrl),
      requestViaInternalNetwork(downloadUrl, {
        headers: { range: 'bytes=0-9' },
      }),
    ]);
    expect(getResponse.headers['content-disposition']).toBe(
      'attachment; filename="a.mp4"',
    );
    expect(rangeResponse.status).toBe(206);

    await storageService.deleteObject(key);
  }, 30000);

  it('presigns an internal GET URL reachable from inside the API container', async () => {
    const key = videoObjectKey(`it-internal-${Date.now()}`);
    const body = Buffer.from('internal-read-bytes');
    await uploadTestObject(storageService, key, body);

    const internalUrl = await storageService.presignInternalGetObject(key, 60);
    expect(new URL(internalUrl).host).toBe(internalS3.host);

    const response = await fetch(internalUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body.toString());

    await storageService.deleteObject(key);
  }, 30000);

  it('putThumbnail writes an object readable without credentials at the public thumbnail URL', async () => {
    const key = thumbnailObjectKey(`it-${Date.now()}`);
    const body = Buffer.from('jpeg-bytes');

    await storageService.putThumbnail(key, body);

    const publicUrl = storageService.getThumbnailPublicUrl(key);
    expect(publicUrl).toBe(
      `${process.env.S3_PUBLIC_ENDPOINT}/${process.env.S3_THUMBNAILS_BUCKET}/${key}`,
    );

    const response = await requestViaInternalNetwork(publicUrl);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(body);
  }, 30000);
});
