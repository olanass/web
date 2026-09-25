const express = require('express');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { ROBINHOOD_CHAIN_CONFIG: chain } = require('../config/chain');
const { parseAmount } = require('../facilitator/amount');
const { x402 } = require('../middleware/x402');
const { serviceStore, publicService, serviceLogo } = require('./store');
const { parseEndpointUrl, resolvePublicEndpoint, joinEndpoint, proxyRequest } = require('./endpoint-security');
const { validateOpenApi, publicOpenApi, inputSchema } = require('./openapi');
const { validateMetered, meteredDetails } = require('./metered');

const publicRouter = express.Router();
const gatewayRouter = express.Router();
const CREATION_PREFIX = 'x402 launch service\n';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const RESPONSE_HEADERS = new Set(['content-type', 'content-language', 'content-disposition', 'cache-control', 'etag', 'last-modified', 'retry-after']);
const LOGO_LIMIT = 512 * 1024;

function validateLogo(body) {
  if (!body.logoDataUrl) {
    if (body.logoHash) throw Object.assign(new Error('Logo hash does not match an uploaded logo'), { status: 400 });
    return { logo: null, logoHash: '' };
  }
  if (typeof body.logoDataUrl !== 'string') throw Object.assign(new Error('Logo must be a data URL'), { status: 400 });
  const match = body.logoDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Object.assign(new Error('Logo must be a PNG, JPEG, or WebP image'), { status: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > LOGO_LIMIT) throw Object.assign(new Error('Logo must be 512 KB or smaller'), { status: 400 });
  const mimeType = match[1];
  const validMagic = mimeType === 'image/png'
    ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === 'image/jpeg'
      ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (!validMagic) throw Object.assign(new Error('Logo file content does not match its image type'), { status: 400 });
  const logoHash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (body.logoHash !== logoHash) throw Object.assign(new Error('Logo hash mismatch'), { status: 400 });
  return { logo: { buffer, mimeType, hash: logoHash }, logoHash };
}

function baseUrl(req) { return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''); }

async function discoveryHandler(req, res, next) {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const result = await serviceStore.list({ status: 'live', limit, offset });
    const items = result.services.map(service => {
      const metered = meteredDetails(service);
      if (metered) return {
        resource: service.endpointUrl, type: 'http', x402Version: 2, accepts: [],
        metadata: { name: service.name, description: service.description, methods: service.allowedMethods,
          billingMode: 'metered', metered, input: inputSchema(service),
          paymentInstructions: metered.scheme === 'prepaid-balance'
            ? 'Register an agent API key with a buyer-wallet signature, deposit USDG to the verified receiver, submit the finalized transfer hash, then call the service with the agent key. Verify the receiver against the creator-signed payout address. Refunds are manual.'
            : 'Request a model-specific HTTP 402 quote from the service. Verify the receiver against the creator-signed payout address.',
          payTo: service.payoutAddress }, lastUpdated: service.updatedAt
      };
      const token = chain.supportedTokens[service.currency];
      return {
        resource: `${baseUrl(req)}/x402/${service.slug}`, type: 'http', x402Version: 2,
        accepts: [{
          scheme: 'onchain-tx', network: chain.caip2, amount: parseAmount(service.price, service.currency).toString(),
          asset: token.address || '0x0000000000000000000000000000000000000000',
          payTo: service.payoutAddress, maxTimeoutSeconds: 300,
          extra: { name: service.currency, version: '1', proof: 'confirmed-transaction' }
        }],
        metadata: {
          name: service.name, description: service.description, methods: service.allowedMethods,
          openapi: service.openapiDocument ? `${baseUrl(req)}/api/services/${encodeURIComponent(service.slug)}/openapi.json` : null,
          input: inputSchema(service)
        },
        lastUpdated: service.updatedAt
      };
    });
    return res.json({ x402Version: 2, items, pagination: { limit, offset, total: result.total } });
  } catch (error) { return next(error); }
}

function creationPayload(input) {
  return {
    name: input.name, description: input.description, category: input.category, videoUrl: input.videoUrl || '',
    logoHash: input.logoHash || '', openapiHash: input.openapiHash || '',
    endpointUrl: input.endpointUrl, allowedMethods: input.allowedMethods,
    price: input.price, currency: input.currency,
    ...(input.billingMode === 'metered' ? { billingMode: 'metered' } : {}),
    creatorAddress: input.creatorAddress.toLowerCase(), payoutAddress: input.payoutAddress.toLowerCase(),
    network: chain.networkId, chainId: chain.chainId, timestamp: input.creatorTimestamp
  };
}

function serviceCreationMessage(input) { return CREATION_PREFIX + JSON.stringify(creationPayload(input)); }
function managementMessage(action, slug, changes, timestamp) {
  return 'x402 manage service\n' + JSON.stringify({ action, slug, changes, timestamp });
}

function verifyManagement(service, action, changes, body) {
  const timestamp = body.creatorTimestamp;
  if (!/^\d{13}$/.test(timestamp || '') || Math.abs(Date.now() - Number(timestamp)) > 300000) {
    throw Object.assign(new Error('Management signature expired'), { status: 400 });
  }
  let signer;
  try { signer = ethers.verifyMessage(managementMessage(action, service.slug, changes, timestamp), body.creatorSignature); }
  catch (_) { throw Object.assign(new Error('Valid creator signature required'), { status: 401 }); }
  if (signer.toLowerCase() !== service.creatorAddress.toLowerCase()) {
    throw Object.assign(new Error('Only the creator wallet can manage this service'), { status: 403 });
  }
}

function validateCreation(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : 'Developer Tools';
  let videoUrl = typeof body.videoUrl === 'string' ? body.videoUrl.trim() : '';
  if (videoUrl) {
    let parsedVideoUrl;
    try { parsedVideoUrl = new URL(videoUrl); } catch (_) { throw Object.assign(new Error('Video link must be a valid URL'), { status: 400 }); }
    if (!['http:', 'https:'].includes(parsedVideoUrl.protocol) || videoUrl.length > 1000) throw Object.assign(new Error('Video link must use HTTP or HTTPS'), { status: 400 });
    videoUrl = parsedVideoUrl.toString();
  }
  const endpointUrl = parseEndpointUrl(body.endpointUrl).toString();
  const allowedMethods = [...new Set((Array.isArray(body.allowedMethods) ? body.allowedMethods : ['POST']).map(value => String(value).toUpperCase()))].sort();
  const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : 'USDC';
  const creatorAddress = body.creatorAddress;
  const payoutAddress = body.payoutAddress || creatorAddress;
  const creatorTimestamp = body.creatorTimestamp;
  const { logo, logoHash } = validateLogo(body);
  const { document: openapiDocument, hash: openapiHash } = validateOpenApi(body.openapiDocument, body.openapiHash || '');
  if (!name || name.length > 120) throw Object.assign(new Error('Service name is required and must be at most 120 characters'), { status: 400 });
  if (description.length > 2000 || !category || category.length > 80) throw Object.assign(new Error('Description or category is too long'), { status: 400 });
  if (!allowedMethods.length || allowedMethods.some(method => !ALLOWED_METHODS.has(method))) throw Object.assign(new Error('Choose at least one supported HTTP method'), { status: 400 });
  if (body.network && body.network !== chain.networkId) throw Object.assign(new Error(`Network must be ${chain.networkId}`), { status: 400 });
  const metered = validateMetered(body, endpointUrl);
  if (!metered) parseAmount(body.price, currency);
  if (metered && (allowedMethods.length !== 1 || allowedMethods[0] !== 'POST')) throw Object.assign(new Error('Metered inference requires POST'), { status: 400 });
  if (!ethers.isAddress(creatorAddress) || !ethers.isAddress(payoutAddress)) throw Object.assign(new Error('Valid creator and payout addresses are required'), { status: 400 });
  if (!/^\d{13}$/.test(creatorTimestamp || '') || Math.abs(Date.now() - Number(creatorTimestamp)) > 300000) throw Object.assign(new Error('Creator signature expired'), { status: 400 });
  return {
    name, description, category, videoUrl, logo, logoHash, openapiDocument, openapiHash, endpointUrl, allowedMethods,
    price: metered ? null : body.price, currency, creatorAddress, payoutAddress,
    ...(metered ? { billingMode: 'metered' } : {}),
    creatorTimestamp, creatorSignature: body.creatorSignature
  };
}

publicRouter.get('/networks', (req, res) => res.json({
  success: true,
  networks: [{
    id: chain.networkId, name: chain.name, chainId: chain.chainId, caip2: chain.caip2,
    testnet: chain.testnet, explorerUrl: chain.explorerUrl,
    tokens: Object.values(chain.supportedTokens).map(token => ({ symbol: token.symbol, name: token.name, decimals: token.decimals, address: token.address }))
  }]
}));
publicRouter.get('/discovery/resources', discoveryHandler);

publicRouter.post('/', async (req, res, next) => {
  try {
    const input = validateCreation(req.body || {});
    if (await serviceStore.hasCreationSignature(input.creatorSignature)) throw Object.assign(new Error('Creation signature already used'), { status: 400 });
    let signer;
    try { signer = ethers.verifyMessage(serviceCreationMessage(input), input.creatorSignature); }
    catch (_) { throw Object.assign(new Error('Valid creator signature required'), { status: 400 }); }
    if (signer.toLowerCase() !== input.creatorAddress.toLowerCase()) throw Object.assign(new Error('Creator signature mismatch'), { status: 400 });
    await resolvePublicEndpoint(input.endpointUrl);
    const service = await serviceStore.create(input);
    res.status(201).json({ success: true, service: publicService(service, baseUrl(req)) });
  } catch (error) { next(error); }
});

publicRouter.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const result = await serviceStore.list({ status: req.query.status, category: req.query.category, search: req.query.search, limit, offset });
    res.json({ success: true, total: result.total, limit, offset, services: result.services.map(service => publicService(service, baseUrl(req))) });
  } catch (error) { next(error); }
});

publicRouter.get('/creator/:address', async (req, res, next) => {
  if (!ethers.isAddress(req.params.address)) return res.status(400).json({ error: 'Invalid wallet address' });
  try {
    const services = (await serviceStore.byCreator(req.params.address)).map(service => publicService(service, baseUrl(req)));
    return res.json({ success: true, creator: req.params.address, count: services.length, services });
  } catch (error) { return next(error); }
});

publicRouter.get('/:slug/logo', async (req, res, next) => {
  let service;
  try { service = await serviceStore.getBySlug(req.params.slug); } catch (error) { return next(error); }
  const logo = serviceLogo(service);
  if (!service || !logo) return res.status(404).json({ error: 'Service logo not found' });
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.type(logo.mimeType);
  return res.send(logo.buffer);
});

publicRouter.get('/:slug/openapi.json', async (req, res, next) => {
  try {
    const service = await serviceStore.getBySlug(req.params.slug);
    if (!service || !service.openapiDocument) return res.status(404).json({ error: 'OpenAPI document not found' });
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(publicOpenApi(service, service.billingMode === 'metered' ? service.endpointUrl : `${baseUrl(req)}/x402/${encodeURIComponent(service.slug)}`));
  } catch (error) { return next(error); }
});

publicRouter.get('/:slug/health', async (req, res, next) => {
  try {
    const service = await serviceStore.getBySlug(req.params.slug);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const startedAt = Date.now();
    const upstream = await proxyRequest(service.endpointUrl, { method: 'HEAD', headers: { 'user-agent': 'x402-launchpad-health/1.0' }, body: Buffer.alloc(0) });
    return res.json({ success: upstream.status < 500, status: upstream.status, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(error.status || 502).json({ success: false, error: 'Endpoint health check failed', checkedAt: new Date().toISOString() });
  }
});

publicRouter.patch('/:slug', async (req, res, next) => {
  try {
    const service = await serviceStore.getBySlug(req.params.slug);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const requested = req.body?.changes || {};
    const changes = {};
    if (requested.name != null) {
      changes.name = String(requested.name).trim();
      if (!changes.name || changes.name.length > 120) throw Object.assign(new Error('Invalid service name'), { status: 400 });
    }
    if (requested.description != null) {
      changes.description = String(requested.description).trim();
      if (changes.description.length > 2000) throw Object.assign(new Error('Description is too long'), { status: 400 });
    }
    if (requested.category != null) {
      changes.category = String(requested.category).trim();
      if (!changes.category || changes.category.length > 80) throw Object.assign(new Error('Invalid service category'), { status: 400 });
    }
    if (requested.videoUrl != null) {
      changes.videoUrl = String(requested.videoUrl).trim();
      if (changes.videoUrl) {
        const parsed = new URL(changes.videoUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid video URL');
        changes.videoUrl = parsed.toString();
      }
    }
    if (requested.status != null) {
      changes.status = String(requested.status);
      if (!['live', 'paused'].includes(changes.status)) throw Object.assign(new Error('Status must be live or paused'), { status: 400 });
    }
    if (requested.price != null) {
      if (service.billingMode === 'metered') throw Object.assign(new Error('Metered services do not have a fixed price'), { status: 400 });
      parseAmount(String(requested.price), service.currency); changes.price = String(requested.price);
    }
    if (requested.endpointUrl != null) {
      changes.endpointUrl = parseEndpointUrl(requested.endpointUrl).toString();
      if (service.billingMode === 'metered') validateMetered({ ...service, price: null }, changes.endpointUrl);
      await resolvePublicEndpoint(changes.endpointUrl);
    }
    if (requested.allowedMethods != null) {
      if (service.billingMode === 'metered' && JSON.stringify(requested.allowedMethods) !== '["POST"]') throw Object.assign(new Error('Metered inference requires POST'), { status: 400 });
      changes.allowedMethods = [...new Set(requested.allowedMethods.map(value => String(value).toUpperCase()))].sort();
      if (!changes.allowedMethods.length || changes.allowedMethods.some(method => !ALLOWED_METHODS.has(method))) throw Object.assign(new Error('Invalid methods'), { status: 400 });
    }
    if (!Object.keys(changes).length) throw Object.assign(new Error('No supported changes supplied'), { status: 400 });
    verifyManagement(service, 'update', changes, req.body || {});
    if (!await serviceStore.claimManagementSignature(service.serviceId, 'update', req.body.creatorSignature)) {
      throw Object.assign(new Error('Management signature already used'), { status: 409 });
    }
    await serviceStore.update(service, changes);
    return res.json({ success: true, service: publicService(service, baseUrl(req)) });
  } catch (error) { return next(error); }
});

publicRouter.delete('/:slug', async (req, res, next) => {
  try {
    const service = await serviceStore.getBySlug(req.params.slug);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    verifyManagement(service, 'delete', {}, req.body || {});
    if (!await serviceStore.claimManagementSignature(service.serviceId, 'delete', req.body.creatorSignature)) {
      throw Object.assign(new Error('Management signature already used'), { status: 409 });
    }
    await serviceStore.remove(service);
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

publicRouter.get('/:slug', async (req, res, next) => {
  let service;
  try { service = await serviceStore.getBySlug(req.params.slug); } catch (error) { return next(error); }
  if (!service) return res.status(404).json({ error: 'Service not found' });
  return res.json({ success: true, service: publicService(service, baseUrl(req)) });
});

function readRequestBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forwardedHeaders(req, body) {
  const headers = { accept: req.get('accept') || '*/*', 'user-agent': 'x402-launchpad/1.0' };
  if (req.get('content-type')) headers['content-type'] = req.get('content-type');
  if (body.length) headers['content-length'] = String(body.length);
  return headers;
}

gatewayRouter.use('/:slug', async (req, res, next) => {
  let service;
  try { service = await serviceStore.getBySlug(req.params.slug); } catch (error) { return next(error); }
  if (!service) return res.status(404).json({ error: 'Service not found' });
  if (service.status !== 'live') return res.status(503).json({ error: 'Service is not live' });
  if (service.billingMode === 'metered') return res.status(409).json({ error: 'Use the independent service and its advertised payment scheme', metered: meteredDetails(service) });
  if (!service.allowedMethods.includes(req.method)) return res.status(405).set('Allow', service.allowedMethods.join(', ')).json({ error: 'Method not allowed' });
  return x402({
    price: service.price, token: service.currency, recipient: service.payoutAddress,
    settle: (data, metadata) => serviceStore.settlePayment(data, metadata)
  })(req, res, async () => {
    const startedAt = Date.now();
    const receipt = req.x402.receipt;
    try {
      if (!await serviceStore.reserveReceipt(service.serviceId, receipt.receiptId)) {
        return res.status(409).json({ error: 'Payment proof has already completed an API request' });
      }
      const body = ['GET', 'HEAD'].includes(req.method) ? Buffer.alloc(0) : await readRequestBody(req);
      const suffix = req.path.replace(/^\/+/, '');
      const target = joinEndpoint(service.endpointUrl, suffix, new URL(req.originalUrl, 'http://gateway.invalid').search);
      const upstream = await proxyRequest(target, { method: req.method, headers: forwardedHeaders(req, body), body });
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (RESPONSE_HEADERS.has(name.toLowerCase()) && value != null) res.set(name, value);
      }
      res.set('X-X402-Service', service.slug);
      res.set('X-X402-Receipt', receipt.receiptId);
      const success = upstream.status >= 200 && upstream.status < 400;
      await serviceStore.recordResult(service.serviceId, receipt, { status: upstream.status, latencyMs: Date.now() - startedAt, success });
      return res.status(upstream.status).send(upstream.body);
    } catch (error) {
      await serviceStore.recordResult(service.serviceId, receipt, { status: error.status || 502, latencyMs: Date.now() - startedAt, success: false });
      return next(Object.assign(error, { status: error.status || 502 }));
    }
  });
});

module.exports = { publicRouter, gatewayRouter, discoveryHandler, serviceCreationMessage, creationPayload, managementMessage };
