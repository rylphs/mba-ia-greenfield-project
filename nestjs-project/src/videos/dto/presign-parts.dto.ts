import { ArrayNotEmpty, ArrayUnique, IsInt, Min } from 'class-validator';

export class PresignPartsDto {
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
