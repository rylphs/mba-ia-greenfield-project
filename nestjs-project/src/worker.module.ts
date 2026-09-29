import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { VideoProcessingModule } from './video-processing/video-processing.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    QueueModule,
    StorageModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
