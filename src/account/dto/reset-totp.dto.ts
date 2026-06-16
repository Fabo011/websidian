import { IsString, Matches, MinLength } from 'class-validator';

/** Start an authenticator reset: current password + a code from the old app. */
export class BeginResetTotpDto {
  @IsString()
  @MinLength(1)
  currentPassword: string;

  /** Current 6-digit TOTP code from the existing authenticator. */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your authenticator.' })
  code: string;
}

/** Confirm an authenticator reset with a code from the newly added app. */
export class ConfirmResetTotpDto {
  /** 6-digit code generated from the new secret. */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your authenticator.' })
  code: string;
}
