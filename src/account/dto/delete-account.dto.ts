import { IsString, MinLength } from 'class-validator';

export class DeleteAccountDto {
  /** Current password, required to confirm irreversible deletion. */
  @IsString()
  @MinLength(1)
  password: string;
}
