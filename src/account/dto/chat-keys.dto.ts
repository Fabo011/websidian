import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Client-computed chat identity keypair. Both values are opaque base64 the
 * server stores verbatim: `chatPublicKey` is the SPKI public key (shareable),
 * `wrappedChatPrivateKey` is the private key wrapped with the user's vault key
 * (the server can never unwrap it).
 */
export class ChatKeysDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  chatPublicKey: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  wrappedChatPrivateKey: string;
}
