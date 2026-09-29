import { thumbnailObjectKey, videoObjectKey } from './storage-keys';

describe('storage-keys', () => {
  it('videoObjectKey returns "{videoId}/original"', () => {
    expect(videoObjectKey('abc-123')).toBe('abc-123/original');
  });

  it('thumbnailObjectKey returns "{videoId}.jpg"', () => {
    expect(thumbnailObjectKey('abc-123')).toBe('abc-123.jpg');
  });
});
