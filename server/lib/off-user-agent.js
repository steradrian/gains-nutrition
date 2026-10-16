/**
 * off-user-agent.js: who this server says it is to Open Food Facts.
 *
 * OFF asks every app for a name, a version and a way to reach whoever runs
 * it, in the User-Agent, so they can contact an app that misbehaves instead
 * of blocking it. The default names Gains and its repository; an operator
 * who wants OFF to reach them instead sets OFF_USER_AGENT, for example
 * `MyGains/1.0 (+https://github.com/you/your-gains)`.
 *
 * It is sent on every outbound request to an OFF host (the product and
 * search lookups through /api/proxy, the images saved with a food, the
 * local mirror's download) and nowhere else: other hosts keep what they
 * were sent before, since some image hosts refuse an agent that is not a
 * browser's.
 */
export const DEFAULT_OFF_USER_AGENT = 'Gains/0.1.0 (+https://github.com/steradrian/gains)';

const MAX_LENGTH = 200;

/**
 * The configured agent: OFF_USER_AGENT, or the default when it is unset or
 * empty. A header value is printable ASCII, so anything else in the variable
 * (a newline from a copied line, a character outside it) is dropped rather
 * than sent, and it is cut to 200 characters. Read on every call, so it
 * follows the environment the server was started with.
 */
export function offUserAgent(env = process.env) {
  const raw = typeof env.OFF_USER_AGENT === 'string' ? env.OFF_USER_AGENT : '';
  const cleaned = raw.replace(/[^\x20-\x7e]/g, '').trim().slice(0, MAX_LENGTH).trim();
  return cleaned || DEFAULT_OFF_USER_AGENT;
}

/** Is this host Open Food Facts: openfoodfacts.org or a proper subdomain of it (never `openfoodfacts.org.evil.tld`). */
export function isOffHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return h === 'openfoodfacts.org' || h.endsWith('.openfoodfacts.org');
}

/**
 * The User-Agent for a request to `url`: the configured one for an OFF host,
 * `otherwise` (what that call sent before) for any other.
 */
export function userAgentFor(url, otherwise) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* not a URL: not OFF */ }
  return isOffHost(host) ? offUserAgent() : otherwise;
}
