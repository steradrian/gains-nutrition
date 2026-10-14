/**
 * TRUST_PROXY: which proxies may tell the server a client's address
 * (X-Forwarded-For), and so what req.ip is.
 *
 * Unset, nobody: req.ip is the connection's own address, as upstream. Behind
 * a reverse proxy or a hub that is the proxy's address for everyone, so the
 * sign-in throttle (routes/auth.js, 10 tries per 15 min per address) and the
 * anonymous rate limits become one bucket shared by every visitor: one
 * person guessing passwords locks the rest out.
 *
 *   1, true, yes, on        one proxy in front; req.ip is the address it added
 *   a number N              N proxies in a row
 *   addresses and subnets   Express's list form, e.g. "loopback, 172.16.0.0/12"
 *   0, false, no, off       unset
 *
 * Never Express's `true` (believe every hop): the leftmost X-Forwarded-For
 * entry is whatever the client typed. A value Express cannot read stops the
 * server at startup rather than quietly trusting nobody.
 */
export function trustProxySetting(raw) {
  const value = String(raw ?? '').trim();
  if (!value || /^(0|false|no|off)$/i.test(value)) return undefined;
  if (/^(true|yes|on)$/i.test(value)) return 1;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/** Apply TRUST_PROXY to an Express app. Throws on a value Express rejects. */
export function applyTrustProxy(app, env = process.env) {
  const setting = trustProxySetting(env.TRUST_PROXY);
  if (setting === undefined) return undefined;
  try {
    app.set('trust proxy', setting);
  } catch (e) {
    throw new Error(`TRUST_PROXY is not a hop count or a list of addresses/subnets (${e.message})`);
  }
  return setting;
}
