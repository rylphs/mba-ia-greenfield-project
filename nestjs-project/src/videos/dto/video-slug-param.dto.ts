import { Matches } from 'class-validator';
import { VIDEO_SLUG_PATTERN } from '../video-slug';

export class VideoSlugParamDto {
  @Matches(VIDEO_SLUG_PATTERN)
  slug: string;
}
