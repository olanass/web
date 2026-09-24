const crypto = require('crypto');

const OPENAPI_LIMIT = 256 * 1024;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function validateOpenApi(document, expectedHash) {
  if (document == null) {
    if (expectedHash) throw Object.assign(new Error('OpenAPI hash does not match an uploaded document'), { status: 400 });
    return { document: null, hash: '' };
  }
  if (typeof document !== 'object' || Array.isArray(document)) {
    throw Object.assign(new Error('OpenAPI document must be a JSON object'), { status: 400 });
  }
  let serialized;
  try { serialized = JSON.stringify(document); }
  catch (_) { throw Object.assign(new Error('OpenAPI document must be valid JSON'), { status: 400 }); }
  if (!serialized || Buffer.byteLength(serialized) > OPENAPI_LIMIT) {
    throw Object.assign(new Error('OpenAPI document must be 256 KB or smaller'), { status: 400 });
  }
  if (typeof document.openapi !== 'string' || !/^3\.(0|1)\./.test(document.openapi)) {
    throw Object.assign(new Error('OpenAPI 3.0 or 3.1 document required'), { status: 400 });
  }
  if (!document.info || typeof document.info.title !== 'string' || typeof document.info.version !== 'string' ||
      !document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths)) {
    throw Object.assign(new Error('OpenAPI info.title, info.version, and paths are required'), { status: 400 });
  }
  const hash = crypto.createHash('sha256').update(serialized).digest('hex');
  if (expectedHash !== hash) throw Object.assign(new Error('OpenAPI document hash mismatch'), { status: 400 });
  const sanitized = JSON.parse(serialized);
  delete sanitized.servers;
  for (const pathItem of Object.values(sanitized.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    delete pathItem.servers;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method.toLowerCase()) && operation && typeof operation === 'object') delete operation.servers;
    }
  }
  return { document: sanitized, hash };
}

function publicOpenApi(service, gatewayUrl) {
  if (!service?.openapiDocument) return null;
  const document = JSON.parse(JSON.stringify(service.openapiDocument));
  document.servers = [{ url: gatewayUrl }];
  document['x-olanas-payment'] = {
    scheme: service.billingMode === 'metered' ? 'batch-settlement' : 'onchain-tx',
    billingMode: service.billingMode || 'fixed',
    network: service.network,
    chainId: service.chainId,
    price: service.price,
    currency: service.currency,
    payTo: service.payoutAddress
  };
  return document;
}

function inputSchema(service) {
  if (!service?.openapiDocument?.paths) return null;
  const document = service.openapiDocument;
  const resolve = value => {
    const seen = new Set();
    while (value?.$ref) {
      const ref = value.$ref;
      if (typeof ref !== 'string' || !ref.startsWith('#/') || seen.has(ref) || seen.size >= 8) return null;
      seen.add(ref);
      value = document;
      for (const key of ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (!value || !Object.prototype.hasOwnProperty.call(value, key)) return null;
        value = value[key];
      }
    }
    return value;
  };
  for (const [pathName, pathItem] of Object.entries(service.openapiDocument.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of service.allowedMethods || []) {
      const operation = pathItem[method.toLowerCase()];
      if (!operation) continue;
      const requestBody = resolve(operation.requestBody);
      const media = requestBody?.content?.['application/json'];
      const schema = resolve(media?.schema) ?? null;
      const parameters = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : [])].map(resolve).filter(Boolean);
      return { path: pathName, method, schema, parameters, required: Boolean(requestBody?.required),
        ...(media?.example !== undefined ? { example: media.example } : {}) };
    }
  }
  return null;
}

module.exports = { OPENAPI_LIMIT, validateOpenApi, publicOpenApi, inputSchema };
