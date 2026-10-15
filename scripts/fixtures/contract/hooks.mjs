// Loader hook for the contract tests' server (see net.mjs): every import of
// 'undici' in the server gets undici.mjs instead, which forwards to the real
// package but sends the food-search hosts to the fake upstream.
let wrapper = null;
let serverUrl = null;

export async function initialize(data) {
  wrapper = data.wrapper;
  serverUrl = data.serverUrl;
}

export async function resolve(specifier, context, next) {
  if (specifier !== 'undici') return next(specifier, context);
  // The wrapper's own import is the real package, found from the server.
  if (context.parentURL === wrapper) return next(specifier, { ...context, parentURL: serverUrl });
  return { url: wrapper, shortCircuit: true };
}
