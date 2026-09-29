import { execFile } from 'child_process';
import type {
  ExecFileOptionsWithBufferEncoding,
  ExecFileOptionsWithStringEncoding,
} from 'child_process';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoProcessingConfig from '../../config/video-processing.config';
import { NoVideoStreamError } from './ffmpeg.errors';
import type { FfprobeOutput } from './ffprobe-output';
import type { ProbeResult } from './probe-result';

const PROBE_MAX_BUFFER = 10 * 1024 * 1024;
const THUMBNAIL_MAX_BUFFER = 20 * 1024 * 1024;
const THUMBNAIL_TIME_FRACTION = 0.1;
const THUMBNAIL_SAFETY_MARGIN_SECONDS = 0.1;

@Injectable()
export class FfmpegService {
  constructor(
    @Inject(videoProcessingConfig.KEY)
    private readonly cfg: ConfigType<typeof videoProcessingConfig>,
  ) {}

  async probe(inputUrl: string): Promise<ProbeResult> {
    const stdout = await this.execFilePromise(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputUrl,
      ],
      { timeout: this.cfg.ffmpegTimeoutMs, maxBuffer: PROBE_MAX_BUFFER },
    );

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams.find((s) => s.codec_type === 'video');
    if (!videoStream) {
      throw new NoVideoStreamError(inputUrl);
    }
    const audioStream = parsed.streams.find((s) => s.codec_type === 'audio');

    return {
      duration: Number(parsed.format.duration),
      width: videoStream.width!,
      height: videoStream.height!,
      video_codec: videoStream.codec_name,
      audio_codec: audioStream ? audioStream.codec_name : null,
      size_bytes: Number(parsed.format.size),
      mime: parsed.format.format_name,
    };
  }

  computeThumbnailTimestamp(duration: number): number {
    const target = duration * THUMBNAIL_TIME_FRACTION;
    const maxTimestamp = Math.max(
      duration - THUMBNAIL_SAFETY_MARGIN_SECONDS,
      0,
    );
    return Math.min(target, maxTimestamp);
  }

  async extractThumbnail(inputUrl: string, atSeconds: number): Promise<Buffer> {
    return this.execFilePromise(
      'ffmpeg',
      [
        '-ss',
        String(atSeconds),
        '-i',
        inputUrl,
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
      {
        timeout: this.cfg.ffmpegTimeoutMs,
        maxBuffer: THUMBNAIL_MAX_BUFFER,
        encoding: 'buffer',
      },
    );
  }

  private execFilePromise(
    cmd: string,
    args: string[],
    options: ExecFileOptionsWithBufferEncoding,
  ): Promise<Buffer>;
  private execFilePromise(
    cmd: string,
    args: string[],
    options: ExecFileOptionsWithStringEncoding,
  ): Promise<string>;
  private execFilePromise(
    cmd: string,
    args: string[],
    options:
      | ExecFileOptionsWithStringEncoding
      | ExecFileOptionsWithBufferEncoding,
  ): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
      // The exact overload of `execFile` depends on `options.encoding`, which
      // is only known at each call site — this is the boundary cast per
      // .claude/rules/typescript-strict.md ("cast at the boundary where the
      // value enters the library API").
      execFile(
        cmd,
        args,
        options as ExecFileOptionsWithBufferEncoding,
        (error, stdout) => {
          if (error) {
            reject(error as Error);
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}
