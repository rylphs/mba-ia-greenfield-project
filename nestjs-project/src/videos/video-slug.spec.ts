import { generateVideoSlug } from './video-slug';

describe('generateVideoSlug', () => {
  it('returns an 11-character string', () => {
    expect(generateVideoSlug()).toHaveLength(11);
  });

  it('only uses the base64url alphabet', () => {
    expect(generateVideoSlug()).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('returns distinct values across calls', () => {
    const slugs = new Set(
      Array.from({ length: 50 }, () => generateVideoSlug()),
    );
    expect(slugs.size).toBe(50);
  });
});
