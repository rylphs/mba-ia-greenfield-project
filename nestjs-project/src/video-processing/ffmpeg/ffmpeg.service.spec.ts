import { execFile } from 'child_process';
import { Test } from '@nestjs/testing';
import videoProcessingConfig from '../../config/video-processing.config';
import { NoVideoStreamError } from './ffmpeg.errors';
import { FfmpegService } from './ffmpeg.service';

jest.mock('child_process');
const mockedExecFile = execFile as unknown as jest.Mock;

const CFG = { attempts: 3, backoffDelayMs: 1000, ffmpegTimeoutMs: 30000 };

function ffprobeJson(overrides: {
  duration: string;
  size: string;
  format_name: string;
  streams: Array<{
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
  }>;
}): string {
  return JSON.stringify({
    format: {
      duration: overrides.duration,
      size: overrides.size,
      format_name: overrides.format_name,
    },
    streams: overrides.streams,
  });
}

function mockExecFileOnce(stdout: string | Buffer): void {
  mockedExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: unknown, stdout: string | Buffer) => void,
    ) => {
      cb(null, stdout);
    },
  );
}

describe('FfmpegService', () => {
  let service: FfmpegService;

  beforeEach(async () => {
    mockedExecFile.mockReset();
    const module = await Test.createTestingModule({
      providers: [
        FfmpegService,
        { provide: videoProcessingConfig.KEY, useValue: CFG },
      ],
    }).compile();
    service = module.get(FfmpegService);
  });

  describe('probe', () => {
    it('chama execFile com ffprobe e o array de argumentos correto, sem shell', async () => {
      mockExecFileOnce(
        ffprobeJson({
          duration: '5.000000',
          size: '123456',
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 1920,
              height: 1080,
            },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
        }),
      );

      const result = await service.probe('http://minio/internal/video.mp4');

      expect(mockedExecFile).toHaveBeenCalledWith(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          'http://minio/internal/video.mp4',
        ],
        expect.objectContaining({ timeout: CFG.ffmpegTimeoutMs }),
        expect.any(Function),
      );
      expect(result).toEqual({
        duration: 5,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        size_bytes: 123456,
        mime: 'mov,mp4,m4a,3gp,3g2,mj2',
      });
    });

    it('retorna audio_codec null quando não há trilha de áudio', async () => {
      mockExecFileOnce(
        ffprobeJson({
          duration: '3.000000',
          size: '1000',
          format_name: 'mp4',
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 640,
              height: 480,
            },
          ],
        }),
      );

      const result = await service.probe('http://x/video-no-audio.mp4');

      expect(result.audio_codec).toBeNull();
    });

    it('lança NoVideoStreamError quando não há stream de vídeo', async () => {
      mockExecFileOnce(
        ffprobeJson({
          duration: '1.000000',
          size: '10',
          format_name: 'wav',
          streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le' }],
        }),
      );

      await expect(service.probe('http://x/not-a-video.wav')).rejects.toThrow(
        NoVideoStreamError,
      );
    });
  });

  describe('computeThumbnailTimestamp', () => {
    it('retorna ~10% da duração para vídeos normais', () => {
      expect(service.computeThumbnailTimestamp(20)).toBeCloseTo(2, 5);
    });

    it('faz clamp abaixo da duração total para vídeos muito curtos', () => {
      const timestamp = service.computeThumbnailTimestamp(0.05);
      expect(timestamp).toBeGreaterThanOrEqual(0);
      expect(timestamp).toBeLessThan(0.05);
    });
  });

  describe('extractThumbnail', () => {
    it('chama execFile com ffmpeg, encoding buffer, e retorna o Buffer do stdout', async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      mockExecFileOnce(jpeg);

      const result = await service.extractThumbnail('http://x/video.mp4', 2);

      expect(mockedExecFile).toHaveBeenCalledWith(
        'ffmpeg',
        [
          '-ss',
          '2',
          '-i',
          'http://x/video.mp4',
          '-frames:v',
          '1',
          '-vf',
          'scale=1280:-2',
          '-f',
          'image2',
          '-c:v',
          'mjpeg',
          'pipe:1',
        ],
        expect.objectContaining({ encoding: 'buffer' }),
        expect.any(Function),
      );
      expect(result).toBe(jpeg);
    });
  });
});
