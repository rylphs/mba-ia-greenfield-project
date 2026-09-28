// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /["\\\x00-\x1f]/g;

export function buildAttachmentDisposition(filename: string): string {
  const sanitized = filename.replace(UNSAFE_CHARS, '');
  return `attachment; filename="${sanitized}"`;
}
