export function videoObjectKey(videoId: string): string {
  return `${videoId}/original`;
}

export function thumbnailObjectKey(videoId: string): string {
  return `${videoId}.jpg`;
}
