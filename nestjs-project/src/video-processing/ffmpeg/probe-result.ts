export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  size_bytes: number;
  mime: string;
}
