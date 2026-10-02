import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ModulesContainer } from '@nestjs/core';
import { ChannelsModule } from './channels/channels.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { StorageService } from './storage/storage.service';
import { UsersModule } from './users/users.module';
import { FfmpegService } from './video-processing/ffmpeg/ffmpeg.service';
import { VideoProcessingModule } from './video-processing/video-processing.module';
import { WorkerModule } from './worker.module';

// DatabaseModule's real DB connection is already covered by
// database.module.spec.ts, and QueueModule's real Redis connection has
// nothing to do with what this test verifies (DI wiring + no controllers) —
// stub both out so this test doesn't pay for unrelated network I/O.
@Module({})
class NoopDatabaseModule {}

@Module({})
class NoopQueueModule {}

// VideoProcessingModule (SI-03.12) registers TypeOrmModule.forFeature([Video])
// and BullModule.registerQueue(...), both of which resolve against the real
// DatabaseModule/QueueModule connections stubbed out above — swap it for a
// stub that still exposes the FfmpegService this test asserts on, without
// pulling in VideoProcessingService/VideoProcessor (covered by their own
// specs, not by this DI-wiring test).
@Module({ providers: [FfmpegService], exports: [FfmpegService] })
class NoopVideoProcessingModule {}

// ChannelsModule/UsersModule are imported only to register their entities
// with the real DataSource (covered by worker.module.integration-spec.ts);
// their forFeature() repositories cannot resolve against the stubbed DB.
@Module({})
class NoopChannelsModule {}

@Module({})
class NoopUsersModule {}

describe('WorkerModule', () => {
  it('compiles with FfmpegService and StorageService wired, and registers no HTTP controllers', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(NoopDatabaseModule)
      .overrideModule(QueueModule)
      .useModule(NoopQueueModule)
      .overrideModule(VideoProcessingModule)
      .useModule(NoopVideoProcessingModule)
      .overrideModule(ChannelsModule)
      .useModule(NoopChannelsModule)
      .overrideModule(UsersModule)
      .useModule(NoopUsersModule)
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
