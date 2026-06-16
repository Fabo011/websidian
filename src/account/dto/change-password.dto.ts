import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  /** Current password, required to authorise the change. */
  @IsString()
  @MinLength(1)
  currentPassword: string;

  /** The new password to set. */
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  @MaxLength(200)
  newPassword: string;

  /** Current 6-digit TOTP code from the authenticator app. */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your authenticator.' })
  code: string;
}
