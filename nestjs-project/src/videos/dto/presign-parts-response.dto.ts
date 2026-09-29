export class PresignedPartDto {
  partNumber: number;
  url: string;
}

export class PresignPartsResponseDto {
  parts: PresignedPartDto[];
  expiresIn: number;
}
