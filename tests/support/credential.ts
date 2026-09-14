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
 * It uses the two routes that are declared anonymous because they are the way a
 * credential is obtained, so no test needs to reach behind the HTTP surface to
 * construct one.
 */
export async function anonymousCredential(core: {
  router: { handle(input: { method: string; url: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: unknown }> };
}): Promise<string> {
  const identity = await core.router.handle({
    method: "POST",
    url: "/v1/identities",
    body: {
      channel_type: "telegram",
      external_id: `gate-probe-${Math.random().toString(36).slice(2)}`,
      display_name: "Gate probe",
      source_system: "market",
    },
    headers: {},
  });
  if (identity.status !== 201 && identity.status !== 200) {
    throw new Error(`could not register a probe identity: ${identity.status}`);
  }
  const principalId = (identity.body as { principal_id: string }).principal_id;
  const session = await core.router.handle({
    method: "POST",
    url: "/v1/sessions",
    body: { principal_id: principalId, channel_type: "telegram" },
    headers: {},
  });
  if (session.status !== 201) throw new Error(`could not issue a probe session: ${session.status}`);
  return (session.body as { access_token: string }).access_token;
}
