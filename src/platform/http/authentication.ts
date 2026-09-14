import { unauthenticated } from "../errors.js";
import type { RequestHeaders } from "./headers.js";

/**
 * Whether a registration may be reached without a credential.
 *
 * Milestone 30 measured what an undeclared answer costs. Authentication lived
 * inside handlers, so whether a route had any was a property of a function body
 * rather than of its registration: an anonymous sweep of all 52 registrations
 * found 28 of them answering `400` about the body to a caller who had presented
 * no credential at all, and the two fulfillment reads answering `404` for an
 * identifier that does not exist and `401` for one that does — which tells an
 * anonymous caller which identifiers are real.
 *
 * So the requirement is declared at the registration, like `accepts` and
 * `body`, and the router — not the handler — enforces it. `AUTHENTICATED` is the
 * default in `Router.add`, so a route whose author forgot to think about it
 * requires a credential; reaching a route without one has to be argued for in
 * writing, at the registration, by name.
 */
export interface AuthenticationSpec {
  readonly required: boolean;
  /**
   * Why this route is reachable without a credential. Empty exactly when the
   * route requires one — an anonymous route cannot be declared without a
   * reason, because "nobody remembered" is the state this milestone closed.
   */
  readonly reason: string;
}

/** The default: this route is reachable only with a credential CORE accepts. */
export const AUTHENTICATED: AuthenticationSpec = { required: true, reason: "" };

/**
 * A route that is reachable without a credential, and the reason it is.
 *
 * The reason is not documentation. It is read back by the authentication gate,
 * which lists every anonymous registration by name: adding one is a deliberate,
 * visible act, and the gate fails until the list is updated to say so.
 */
export function anonymous(reason: string): AuthenticationSpec {
  if (reason.trim() === "") {
    throw new Error("an anonymous route must record why it needs no credential");
  }
  return { required: false, reason };
}

/**
 * What CORE authenticates with, as the router sees it.
 *
 * Declared here rather than imported from the identity module: the platform
 * describes the shape of the thing it needs, and the module supplies it. The
 * actor is opaque to the router — it establishes it, puts it on the context and
 * never reads a field of it. Who is entitled to what is the identity module's
 * question, and the router deciding any part of it would be a second
 * authorization surface.
 */
export interface Authenticator<A> {
  authenticate(credential: string): Promise<A>;
}

const BEARER = "Bearer ";

/**
 * The credential on a request, or a refusal.
 *
 * The only reader of `authorization` in CORE. Milestone 26 made
 * `RequestHeaders` the single reader of a header value; this is the single
 * reader of this header, so no handler can pick up a credential the router did
 * not act on, and no second interpretation of "is this caller authenticated"
 * can exist.
 */
export function bearerCredential(headers: RequestHeaders): string {
  const raw = headers.value("authorization");
  if (raw === undefined || !raw.startsWith(BEARER)) throw unauthenticated("missing bearer token");
  const credential = raw.slice(BEARER.length);
  if (credential === "") throw unauthenticated("missing bearer token");
  return credential;
}
