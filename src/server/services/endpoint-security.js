const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

function isPrivateAddress(address) {
  const normalized = String(address || '').toLowerCase().split('%')[0];
  const version = net.isIP(normalized);
  if (version === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || a >= 224;
  }
  if (version === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  }
  return version === 0;
}

function parseEndpointUrl(value) {
  let endpoint;
  try { endpoint = new URL(value); }
  catch (_) { throw Object.assign(new Error('Endpoint must be a valid URL'), { status: 400 }); }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw Object.assign(new Error('Endpoint must use HTTP or HTTPS'), { status: 400 });
  if (endpoint.username || endpoint.password) throw Object.assign(new Error('Endpoint URL cannot contain credentials'), { status: 400 });
  if (endpoint.hash) throw Object.assign(new Error('Endpoint URL cannot contain a fragment'), { status: 400 });
  if (!endpoint.hostname || endpoint.hostname === 'localhost' || endpoint.hostname.endsWith('.localhost') || endpoint.hostname.endsWith('.local')) {
    throw Object.assign(new Error('Endpoint hostname is not allowed'), { status: 400 });
  }
  return endpoint;
}

async function resolvePublicEndpoint(value) {
  const endpoint = value instanceof URL ? value : parseEndpointUrl(value);
  const allowPrivateForTests = process.env.NODE_ENV === 'test' && process.env.X402_TEST_ALLOW_PRIVATE_ENDPOINTS === 'true';
  let addresses;
  try { addresses = await dns.lookup(endpoint.hostname, { all: true, verbatim: true }); }
  catch (_) { throw Object.assign(new Error('Endpoint hostname could not be resolved'), { status: 400 }); }
  if (!addresses.length || (!allowPrivateForTests && addresses.some(item => isPrivateAddress(item.address)))) {
    throw Object.assign(new Error('Endpoint resolves to a private or unsafe address'), { status: 400 });
  }
  return { endpoint, addresses };
}

// A dot segment, percent-encoded or not. Assigning to URL.pathname runs the WHATWG path parser,
// which resolves these, and the parser treats %2e as a dot -- so a suffix of `%2e%2e/admin`
// escapes the path the creator registered. Routers and CDNs do not normalise %2e away, so the
// suffix arrives here intact.
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;

function joinEndpoint(baseUrl, suffix, search) {
  const base = new URL(baseUrl);
  const target = new URL(baseUrl);
  const cleanSuffix = String(suffix || '').replace(/^\/+/, '');
  if (DOT_SEGMENT.test(cleanSuffix)) throw Object.assign(new Error('Path traversal is not allowed'), { status: 400 });
  if (cleanSuffix) target.pathname = target.pathname.replace(/\/+$/, '') + '/' + cleanSuffix;
  // Belt and braces: whatever the parser made of it, the result still has to be inside the
  // registered endpoint.
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/+$/, ''))) {
    throw Object.assign(new Error('Path traversal is not allowed'), { status: 400 });
  }
  // The caller's query is merged into the creator's, not substituted for it: a registered
  // endpoint may carry parameters of its own, and dropping them silently breaks the listing.
  if (search) {
    for (const [key, value] of new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)) {
      target.searchParams.append(key, value);
    }
  }
  return target;
}

async function requestOnce(target, options) {
  const { endpoint, addresses } = await resolvePublicEndpoint(target);
  const selected = addresses[0];
  const transport = endpoint.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(endpoint, {
      method: options.method,
      headers: options.headers,
      timeout: options.timeoutMs,
      servername: endpoint.hostname,
      lookup: (_hostname, _lookupOptions, callback) => callback(null, selected.address, selected.family)
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > options.maxResponseBytes) {
          request.destroy(Object.assign(new Error('Upstream response is too large'), { status: 502 }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode || 502, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('Upstream request timed out'), { status: 504 })));
    request.on('error', reject);
    if (options.body?.length) request.write(options.body);
    request.end();
  });
}

async function proxyRequest(target, options = {}) {
  const requestOptions = {
    method: options.method || 'GET', headers: options.headers || {}, body: options.body || null,
    timeoutMs: options.timeoutMs || Number(process.env.X402_PROXY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes || Number(process.env.X402_PROXY_MAX_RESPONSE_BYTES) || DEFAULT_MAX_RESPONSE_BYTES
  };
  let current = target instanceof URL ? target : new URL(target);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await requestOnce(current, requestOptions);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) return response;
    if (redirects === MAX_REDIRECTS) throw Object.assign(new Error('Upstream redirected too many times'), { status: 502 });
    current = new URL(response.headers.location, current);
    if (response.status === 303) {
      requestOptions.method = 'GET'; requestOptions.body = null;
      delete requestOptions.headers['content-length']; delete requestOptions.headers['content-type'];
    }
  }
  throw Object.assign(new Error('Upstream request failed'), { status: 502 });
}

module.exports = { isPrivateAddress, parseEndpointUrl, resolvePublicEndpoint, joinEndpoint, proxyRequest };
