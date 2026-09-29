import { IsInt, IsString, Min, MaxLength, MinLength } from 'class-validator';

export class CreateVideoUploadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName: string;

  @IsInt()
  @Min(1)
  fileSize: number;

  @IsString()
  contentType: string;
}
