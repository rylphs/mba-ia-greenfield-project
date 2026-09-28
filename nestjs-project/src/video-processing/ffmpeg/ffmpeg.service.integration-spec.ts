import { execFile } from 'child_process';
import { promisify } from 'util';
import { unlink, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../../config/storage.config';
import videoProcessingConfig from '../../config/video-processing.config';
import { uploadTestObject } from '../../test/minio';
import { videoObjectKey } from '../../storage/storage-keys';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';

const execFileAsync = promisify(execFile);
const FIXTURE_MAX_BUFFER = 50 * 1024 * 1024;

async function generateFixture(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('ffmpeg', args, {
    encoding: 'buffer',
    maxBuffer: FIXTURE_MAX_BUFFER,
  });
  return stdout;
}

describe('FfmpegService (integration)', () => {
  let ffmpegService: FfmpegService;
  let storageService: StorageService;
  let withAudioUrl: string;
  let withoutAudioUrl: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoProcessingConfig],
        }),
        StorageModule,
      ],
      providers: [FfmpegService],
    }).compile();

    ffmpegService = module.get(FfmpegService);
    storageService = module.get(StorageService);

    const [withAudioFixture, withoutAudioFixture] = await Promise.all([
      generateFixture([
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1920x1080:rate=25:duration=5',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:duration=5',
        '-shortest',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-movflags',
        '+frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ]),
      generateFixture([
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x360:rate=25:duration=1',
        '-c:v',
        'libx264',
        '-movflags',
        '+frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ]),
    ]);

    const withAudioKey = videoObjectKey(`ffmpeg-it-with-audio-${Date.now()}`);
    const withoutAudioKey = videoObjectKey(`ffmpeg-it-no-audio-${Date.now()}`);

    await Promise.all([
      uploadTestObject(storageService, withAudioKey, withAudioFixture),
      uploadTestObject(storageService, withoutAudioKey, withoutAudioFixture),
    ]);

    [withAudioUrl, withoutAudioUrl] = await Promise.all([
      storageService.presignInternalGetObject(withAudioKey, 300),
      storageService.presignInternalGetObject(withoutAudioKey, 300),
    ]);
  }, 60000);

  it('probe retorna os metadados esperados de um vídeo 1920x1080 H.264/AAC de 5s', async () => {
    const result = await ffmpegService.probe(withAudioUrl);

    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.video_codec).toBe('h264');
    expect(result.audio_codec).toBe('aac');
    expect(result.duration).toBeCloseTo(5, 0);
  }, 30000);

  it('probe retorna audio_codec null para um vídeo sem trilha de áudio', async () => {
    const result = await ffmpegService.probe(withoutAudioUrl);

    expect(result.audio_codec).toBeNull();
    expect(result.video_codec).toBe('h264');
  }, 30000);

  it('extractThumbnail produz um JPEG de largura 1280 com proporção preservada', async () => {
    const timestamp = ffmpegService.computeThumbnailTimestamp(1);
    const thumbnail = await ffmpegService.extractThumbnail(
      withoutAudioUrl,
      timestamp,
    );

    expect(thumbnail.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const thumbPath = path.join(os.tmpdir(), `ffmpeg-it-${Date.now()}.jpg`);
    try {
      await writeFile(thumbPath, thumbnail);
      const probed = await ffmpegService.probe(thumbPath);
      expect(probed.width).toBe(1280);
      expect(probed.height).toBe(720);
    } finally {
      await unlink(thumbPath);
    }
  }, 30000);
});
