import { Matches } from 'class-validator';

/** A username to block. Same shape rule as registration usernames. */
export class BlockDto {
  @Matches(/^[a-zA-Z0-9_-]{3,32}$/, {
    message: 'Enter a valid username (3-32 letters, numbers, - or _).',
  })
  username: string;
}
