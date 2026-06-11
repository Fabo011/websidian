export type TokenPurpose = 'auth' | 'pending';

export interface JwtPayload {
  /** user id */
  sub: number;
  username: string;
  purpose: TokenPurpose;
}

/** Shape attached to the request once authenticated. */
export interface AuthenticatedUser {
  id: number;
  username: string;
}
