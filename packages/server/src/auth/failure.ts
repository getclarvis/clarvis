/**
 * A refused request, carrying the status and the RFC 6750 error code it must be
 * reported with.
 *
 * @remarks `401` means "no acceptable credential was presented" and invites a
 * retry with a better one; `403` means the credential was understood and the
 * caller still may not do this. Collapsing the two would make a revoked client
 * retry forever against a server that will never accept it.
 *
 *   It lives in a module of its own, importing nothing, because both the
 *   authenticator and the owner resolver raise it and either import direction
 *   between those two would close a cycle.
 */
export class AuthFailure extends Error {
  readonly status: 401 | 403;
  readonly code: string;

  constructor(status: 401 | 403, code: string, description: string) {
    super(description);
    this.name = "AuthFailure";
    this.status = status;
    this.code = code;
  }
}
