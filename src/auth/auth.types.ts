export type TokenPurpose = 'auth' | 'pending';

export interface JwtPayload {
  /** user id */
  sub: number;
  username: string;
  /** Opaque storage namespace id (S3 prefix / disk folder owner). */
  storageId: string;
  purpose: TokenPurpose;
}

/** Shape attached to the request once authenticated. */
export interface AuthenticatedUser {
  id: number;
  username: string;
  /** Opaque storage namespace id used for all vault storage operations. */
  storageId: string;
}
