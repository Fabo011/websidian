import { IsString, Matches } from 'class-validator';

export class TotpDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your authenticator.' })
  code: string;
}
