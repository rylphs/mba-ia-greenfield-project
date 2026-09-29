import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and resolve two S3 clients with distinct endpoints', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module.get(StorageService)).toBeDefined();

    const internalClient = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const publicClient = module.get<S3Client>(S3_PUBLIC_CLIENT);
    expect(internalClient).not.toBe(publicClient);

    const internalEndpoint = await internalClient.config.endpoint!();
    const publicEndpoint = await publicClient.config.endpoint!();
    expect(internalEndpoint.hostname).not.toBe(publicEndpoint.hostname);

    await module.close();
  }, 15000);
});
