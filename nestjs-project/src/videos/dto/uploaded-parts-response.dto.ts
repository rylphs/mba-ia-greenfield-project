export class UploadedPartDto {
  partNumber: number;
  etag: string;
  size: number;
}

export class UploadedPartsResponseDto {
  parts: UploadedPartDto[];
  partSize: number;
  partCount: number;
}
