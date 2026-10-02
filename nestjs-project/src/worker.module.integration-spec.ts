import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Video } from './videos/entities/video.entity';
import { WorkerModule } from './worker.module';

// worker.module.spec.ts stubs DatabaseModule, so it cannot see the entity set
// that autoLoadEntities builds from the worker's own forFeature() calls. This
// boots the real WorkerModule against the Compose db/redis to prove the
// worker's DataSource can build metadata for Video and every related entity.
describe('WorkerModule (real DataSource)', () => {
  it('initializes the DataSource with the entities related to Video registered', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const dataSource = module.get(DataSource);
    expect(dataSource.isInitialized).toBe(true);
    expect(
      dataSource.getMetadata(Video).findRelationWithPropertyPath('channel'),
    ).toBeDefined();

    await module.close();
  }, 60000);
});
