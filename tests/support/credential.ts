/**
 * A real bearer token for an app under test.
 *
 * Needed from milestone 30 onwards. Before it, a gate about the query string or
 * the body could drive every route anonymously, because authentication happened
 * inside each handler and the parse ran first. The router now authenticates a
 * route that declared `AUTHENTICATED` before it parses anything, so a gate that
 * still drove anonymously would measure the 401 on every route and never reach
 * the refusal it exists to assert.
 *
 * The principal this mints holds **no membership and no permission**: enough to
 * be authenticated, not enough to be authorized anywhere. That is deliberate —
 * a gate about a malformed request must be shown to answer `400` before the
 * `403` this caller would otherwise receive, so the refusal under test cannot
 * be confused with a permission answer.
 *
 * **It no longer goes through `POST /v1/sessions`.** Until milestone 31 that
 * route required no credential, so a probe could obtain one over HTTP the way
 * anybody else could — which was B-39, the hole that cycle closed. Issuing a
 * session now requires `session.issue`, and a helper that granted its probe that
 * permission in order to mint a powerless token would be granting the strongest
 * permission CORE has to produce the weakest credential. So the session is
 * minted in process, through the same `IdentityService` the route calls, and the
 * token it returns is indistinguishable from one the route would have issued —
 * `authenticate` reads the same row either way.
 */
import type { CoreApp } from "../../src/app.js";

export async function anonymousCredential(core: Pick<CoreApp, "identity">): Promise<string> {
  const registered = await core.identity.registerIdentity({
    channel_type: "telegram",
    external_id: `gate-probe-${Math.random().toString(36).slice(2)}`,
    display_name: "Gate probe",
    source_system: "market",
    correlation_id: "gate-probe",
  });
  const { token } = await core.identity.issueSession({
    principal_id: registered.principal.principal_id,
    channel_type: "telegram",
    correlation_id: "gate-probe",
  });
  return token;
}
