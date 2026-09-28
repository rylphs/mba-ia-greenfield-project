import { buildAttachmentDisposition } from './content-disposition';

describe('buildAttachmentDisposition', () => {
  it('builds an attachment disposition for a simple filename', () => {
    expect(buildAttachmentDisposition('ferias.mp4')).toBe(
      'attachment; filename="ferias.mp4"',
    );
  });

  it('strips quotes, backslashes and control characters from the filename', () => {
    expect(buildAttachmentDisposition('fe"rias\\file\n.mp4')).toBe(
      'attachment; filename="feriasfile.mp4"',
    );
  });
});
