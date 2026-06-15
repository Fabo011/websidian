import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Optional Stripe Checkout Session id returned on the success redirect. */
export class SyncDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  sessionId?: string;
}
