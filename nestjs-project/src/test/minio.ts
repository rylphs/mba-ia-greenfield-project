import * as http from 'http';
import type { StorageService } from '../storage/storage.service';

// S3_PUBLIC_ENDPOINT (http://localhost:9000) is the browser-facing host and is not
// reachable from inside this container (see nestjs-project/compose.yaml — only 3000
// is published to nestjs-api's own namespace). SigV4 validates the signed `host`
// header, not the TCP peer, and MinIO's anonymous policy checks are host-independent,
// so requests are routed through the reachable internal host while the original Host
// header is kept intact — equivalent to what a hosts-file alias does for a real
// browser client.
const internalS3 = new URL(process.env.S3_ENDPOINT!);

export function requestViaInternalNetwork(
  presignedUrl: string,
  options: {
    method?: string;
    body?: Buffer;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  const target = new URL(presignedUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: internalS3.hostname,
        port: internalS3.port,
        path: target.pathname + target.search,
        method: options.method ?? 'GET',
        headers: {
          ...options.headers,
          host: target.host,
          ...(options.body
            ? { 'content-length': String(options.body.length) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export async function uploadTestObject(
  storageService: StorageService,
  key: string,
  body: Buffer,
  contentType = 'video/mp4',
): Promise<{ uploadId: string; etag: string; partUrl: string }> {
  const uploadId = await storageService.createMultipartUpload(key, contentType);
  const partUrl = await storageService.presignUploadPart(key, uploadId, 1, 60);
  const etag = (
    await requestViaInternalNetwork(partUrl, { method: 'PUT', body })
  ).headers.etag as string;
  await storageService.completeMultipartUpload(key, uploadId, [
    { ETag: etag, PartNumber: 1 },
  ]);
  return { uploadId, etag, partUrl };
}
