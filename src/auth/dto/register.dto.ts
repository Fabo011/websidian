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
}
