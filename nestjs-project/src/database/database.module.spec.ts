import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppConfigModule } from '../config/app-config.module';
import { DatabaseModule } from './database.module';

describe('DatabaseModule / AppConfigModule', () => {
  it('compiles and connects to the database using env-driven config', async () => {
    const module = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
    }).compile();

    expect(module.get(ConfigService)).toBeDefined();
    const dataSource = module.get(DataSource);
    expect(dataSource.isInitialized).toBe(true);

    await module.close();
  }, 30000);
});
