import { Module } from '@nestjs/common';
import { ChannelsModule } from './channels/channels.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './video-processing/video-processing.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    // autoLoadEntities only registers entities declared via forFeature(), not
    // those reached through relations: Video -> Channel -> User must each be
    // registered by its owning module for the worker's DataSource to build.
    ChannelsModule,
    UsersModule,
    QueueModule,
    StorageModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
