import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ModulesContainer } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { StorageService } from './storage/storage.service';
import { FfmpegService } from './video-processing/ffmpeg/ffmpeg.service';
import { WorkerModule } from './worker.module';

// DatabaseModule's real DB connection is already covered by
// database.module.spec.ts, and QueueModule's real Redis connection has
// nothing to do with what this test verifies (DI wiring + no controllers) —
// stub both out so this test doesn't pay for unrelated network I/O.
@Module({})
class NoopDatabaseModule {}

@Module({})
class NoopQueueModule {}

describe('WorkerModule', () => {
  it('compiles with FfmpegService and StorageService wired, and registers no HTTP controllers', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(NoopDatabaseModule)
      .overrideModule(QueueModule)
      .useModule(NoopQueueModule)
      .compile();

    expect(module.get(FfmpegService)).toBeDefined();
    expect(module.get(StorageService)).toBeDefined();

    const modulesContainer = module.get(ModulesContainer);
    const allControllers = [...modulesContainer.values()].flatMap((m) => [
      ...m.controllers.values(),
    ]);
    expect(allControllers).toHaveLength(0);

    await module.close();
  });
});
