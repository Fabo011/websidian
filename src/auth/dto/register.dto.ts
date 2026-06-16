import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{3,32}$/, {
    message:
      'Username must be 3-32 characters: letters, numbers, dashes or underscores only.',
  })
  username: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  @MaxLength(200)
  password: string;

  // --- Client-computed zero-knowledge key material (opaque base64) ----------

  /** Base64 salt for the Argon2id password-derived wrapping key. */
  @IsString()
  @MaxLength(128)
  kdfSalt: string;

  /** Base64 salt for the Argon2id recovery-key-derived wrapping key. */
  @IsString()
  @MaxLength(128)
  recoverySalt: string;

  /** Vault key wrapped with the password-derived key (base64). */
  @IsString()
  @MaxLength(512)
  wrappedVaultKey: string;

  /** Vault key wrapped with the recovery-key-derived key (base64). */
  @IsString()
  @MaxLength(512)
  recoveryWrappedVaultKey: string;
}
