export class NoVideoStreamError extends Error {
  constructor(inputUrl: string) {
    super(`No video stream found in input: ${inputUrl}`);
    this.name = 'NoVideoStreamError';
  }
}
