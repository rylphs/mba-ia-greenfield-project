import { randomBytes } from 'node:crypto';

// 8 random bytes base64url-encoded is always 11 chars (no padding, since 8 is
// not a multiple of 3) — keep this regex in sync with the generator above.
export const VIDEO_SLUG_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}
