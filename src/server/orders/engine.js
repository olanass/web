'use strict';
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const { serviceStore } = require('../services/store');
const { ROBINHOOD_CHAIN_CONFIG: chain } = require('../config/chain');
const { parseAmount } = require('../facilitator/amount');
const { verifyPayment } = require('../facilitator/verifier');
const { proxyRequest, joinEndpoint } = require('../services/endpoint-security');
const { validateInput } = require('./input');

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function requestPath(value = '') {
  if (typeof value !== 'string' || value.length > 1000 || (value && !value.startsWith('/')) || value.startsWith('//') || /[\\#\r\n]/.test(value)) throw fail('Use a relative API path without fragments or traversal', 400);
  let pathname;
  try { pathname = decodeURIComponent(value.split('?')[0]); } catch { throw fail('Invalid encoded API path', 400); }
  if (pathname.includes('..') || /[%\\?#]/.test(pathname) || pathname.startsWith('//')) throw fail('API path traversal is not allowed', 400);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function approvalMessage(order, payer) {
  return 'Olanas order approval\n' + canonical({ orderId: order.id, requestHash: order.requestHash,
    quote: order.quote, payer: ethers.getAddress(payer), purpose: 'Approve one payment and one API execution' });
}
function cancellationMessage(order) {
  return 'Olanas cancel unpaid approval\n' + canonical({ orderId: order.id, revision: order.revision, payer: order.payer,
    statement: 'I checked my wallet activity. No transfer was submitted for this approval. Reopen this order for review.' });
}
function view(order) {
  const { endpointUrl, accessHash, fingerprint, revision, ...visible } = order;
  const expired = order.approvalStatus === 'pending' && order.quote.expiresAt <= Date.now();
  return { ...visible, resultStatus: order.result ? (order.result.status >= 200 && order.result.status < 300 ? 'succeeded' : 'failed') : null, approvalStatus: expired ? 'expired' : order.approvalStatus,
    deliveryStatus: order.deliveryStatus === 'executing' && order.executionStartedAt + 60000 < Date.now() ? 'unknown' : order.deliveryStatus,
    nextAction: expired ? 'refresh_quote' : order.approvalStatus === 'rejected' ? 'reopen_order' :
      order.paymentStatus === 'submitted' ? 'reconcile_payment' : order.deliveryStatus === 'completed' ? (order.result?.status >= 200 && order.result.status < 300 ? 'read_result' : 'inspect_service_error') :
        order.approvalStatus === 'pending' ? 'human_approval' : order.paymentStatus === 'unpaid' ? 'recover_wallet_transaction' : 'inspect_delivery' };
}

class OrderEngine {
  constructor({ services = serviceStore, network = chain, verify = verifyPayment, proxy = proxyRequest } = {}) {
    this.services = services; this.chain = network; this.verify = verify; this.proxy = proxy;
  }
  async db() {
    const db = await this.services.init();
    await db.execute(`CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY, access_hash TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL,
      UNIQUE(access_hash, request_id))`);
    return db;
  }
  secret(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) throw fail('A 32-byte hexadecimal order access token is required', 401);
    return hash(token);
  }
  async load(id, token) {
    const accessHash = this.secret(token);
    const db = await this.db();
    const rows = await db.execute({ sql: 'SELECT data, revision FROM purchase_orders WHERE id = ? AND access_hash = ?', args: [id, accessHash] });
    if (!rows.rows[0]) throw fail('Order not found or access denied', 404);
    return { ...JSON.parse(rows.rows[0].data), revision: Number(rows.rows[0].revision) };
  }
  async save(order, event) {
    if (event) order.events.push({ action: event, at: Date.now() });
    order.updatedAt = Date.now();
    const db = await this.db();
    const r = await db.execute({ sql: 'UPDATE purchase_orders SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ?',
      args: [JSON.stringify(order), order.id, order.revision] });
    if (r.rowsAffected !== 1) throw fail('Order changed in another session. Reload before continuing.');
    order.revision++;
    return view(order);
  }
  async quote(slug, method, version = 1) {
    const service = await this.services.getBySlug(slug);
    if (!service || service.status !== 'live' || service.chainId !== this.chain.chainId) throw fail('Service is unavailable on this network', 400);
    if (service.billingMode === 'metered') throw fail('Use the payment scheme advertised by the listed metered service; fixed-price orders are unavailable', 409);
    if (!service.allowedMethods.includes(method)) throw fail('Method is not supported', 400);
    const asset = this.chain.supportedTokens[service.currency];
    if (!asset) throw fail('Unsupported payment asset', 400);
    const amount = parseAmount(service.price, service.currency).toString();
    return { service, quote: { version, serviceId: service.serviceId, serviceVersion: service._version || 0,
      name: service.name, chainId: this.chain.chainId, network: this.chain.name, token: service.currency,
      asset: asset.address || null, decimals: asset.decimals, amount, displayAmount: service.price,
      recipient: ethers.getAddress(service.payoutAddress), issuedAt: Date.now(), expiresAt: Date.now() + 5 * 60000 } };
  }
  async create({ slug, method = 'POST', path = '', body = null, requestId, accessToken }) {
    const accessHash = this.secret(accessToken);
    path = requestPath(path);
    if (!/^[a-z0-9-]{1,80}$/.test(slug || '') || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId || '')) throw fail('Valid service slug and request ID are required', 400);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || (method === 'GET' && body !== null)) throw fail('Invalid method or GET body', 400);
    const encoded = canonical(body);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 16000) throw fail('Request body exceeds 16 KB', 400);
    const fingerprint = hash(canonical({ slug, method, path, body }));
    const db = await this.db();
    const existing = await db.execute({ sql: 'SELECT data FROM purchase_orders WHERE access_hash = ? AND request_id = ?', args: [accessHash, requestId] });
    if (existing.rows[0]) {
      const old = JSON.parse(existing.rows[0].data);
      if (old.fingerprint !== fingerprint) throw fail('Request ID already belongs to different input');
      return view(old);
    }
    const { service, quote } = await this.quote(slug, method);
    validateInput(service, method, path, body);
    const order = { id: 'ord_' + crypto.randomBytes(16).toString('hex'), accessHash, requestId, fingerprint,
      slug, method, path, body, requestHash: fingerprint, endpointUrl: service.endpointUrl, quote, quoteHistory: [quote],
      approvalStatus: 'pending', paymentStatus: 'unpaid', deliveryStatus: 'not_started', payer: null,
      txHash: null, result: null, receipt: null, revision: 0, createdAt: Date.now(), updatedAt: Date.now(),
      events: [{ action: 'created', at: Date.now() }] };
    const inserted = await db.execute({ sql: 'INSERT OR IGNORE INTO purchase_orders(id, access_hash, request_id, fingerprint, data) VALUES (?, ?, ?, ?, ?)',
      args: [order.id, accessHash, requestId, fingerprint, JSON.stringify(order)] });
    if (inserted.rowsAffected !== 1) return this.create({ slug, method, path, body, requestId, accessToken });
    return view(order);
  }
  async get(id, token) { return view(await this.load(id, token)); }
  async review(id, token, action) {
    const order = await this.load(id, token);
    if (order.paymentStatus !== 'unpaid' || order.approvalStatus === 'approved') throw fail('Payment approval already started. Recover the original transaction.');
    if (action === 'reject') {
      order.approvalStatus = 'rejected';
    } else {
      if (action === 'reopen' && order.approvalStatus !== 'rejected') throw fail('Only rejected orders can be reopened');
      if (action === 'refresh' && order.approvalStatus !== 'pending') throw fail('Reopen the rejected order first');
      const { service, quote } = await this.quote(order.slug, order.method, order.quote.version + 1);
      validateInput(service, order.method, order.path, order.body);
      order.quote = quote; order.endpointUrl = service.endpointUrl; order.approvalStatus = 'pending';
      order.quoteHistory ||= []; order.quoteHistory.push(quote);
    }
    return this.save(order, action);
  }
  async approval(id, token, payer) {
    const order = await this.load(id, token);
    this.assertApprovable(order);
    return { message: approvalMessage(order, payer), quoteVersion: order.quote.version };
  }
  assertApprovable(order) {
    if (order.approvalStatus !== 'pending' || order.paymentStatus !== 'unpaid') throw fail('Order is not awaiting approval');
    if (order.quote.expiresAt <= Date.now()) throw fail('Quote expired. Refresh it and review the new terms.');
  }
  async approve(id, token, { payer, signature, quoteVersion }) {
    const order = await this.load(id, token);
    this.assertApprovable(order);
    if (quoteVersion !== order.quote.version) throw fail('Quote changed. Review it again.');
    let address;
    try { address = ethers.getAddress(payer); if (ethers.verifyMessage(approvalMessage(order, address), signature) !== address) throw Error(); }
    catch (_) { throw fail('Wallet signature does not match this order and quote', 401); }
    order.payer = address; order.approvalStatus = 'approved'; order.approvalSignature = signature;
    order.approvalHistory ||= []; order.approvalHistory.push({ payer: address, signature, quoteVersion, at: Date.now() });
    return this.save(order, 'approved');
  }
  async submit(id, token, txHash) {
    const order = await this.load(id, token);
    if (order.approvalStatus !== 'approved') throw fail('Wallet approval is required');
    if (!/^0x[0-9a-f]{64}$/i.test(txHash || '')) throw fail('Invalid transaction hash', 400);
    if (order.txHash) {
      if (order.txHash.toLowerCase() !== txHash.toLowerCase()) throw fail('Only the original transaction may be recovered');
      return view(order);
    }
    order.txHash = txHash; order.paymentStatus = 'submitted';
    return this.save(order, 'payment_submitted');
  }
  async cancellation(id, token) {
    const order = await this.load(id, token);
    if (order.approvalStatus !== 'approved' || order.paymentStatus !== 'unpaid' || order.txHash) throw fail('Only an unpaid approval can be cancelled');
    return { message: cancellationMessage(order), revision: order.revision };
  }
  async cancelApproval(id, token, { signature, revision }) {
    const order = await this.load(id, token);
    if (order.approvalStatus !== 'approved' || order.paymentStatus !== 'unpaid' || order.txHash || order.revision !== revision) throw fail('Order changed or a payment was already submitted');
    try { if (ethers.verifyMessage(cancellationMessage(order), signature) !== order.payer) throw Error(); }
    catch (_) { throw fail('The approving wallet must confirm cancellation', 401); }
    const { service, quote } = await this.quote(order.slug, order.method, order.quote.version + 1);
    validateInput(service, order.method, order.path, order.body);
    order.quote = quote; order.endpointUrl = service.endpointUrl; order.approvalStatus = 'pending';
    order.quoteHistory ||= []; order.quoteHistory.push(quote);
    order.payer = null; order.approvalSignature = null;
    return this.save(order, 'unpaid_approval_cancelled_by_wallet');
  }
  async reconcile(id, token) {
    const order = await this.load(id, token);
    if (order.deliveryStatus === 'completed') {
      await this.recordAnalytics(order);
      return view(order);
    }
    if (!order.txHash || !['submitted', 'confirmed'].includes(order.paymentStatus) || order.deliveryStatus !== 'not_started') return view(order);
    const q = order.quote;
    if (q.chainId !== this.chain.chainId) throw fail('This order is not on Robinhood Chain mainnet', 400);
    const checked = await this.verify({ scheme: 'onchain-tx', payer: order.payer, txHash: order.txHash },
      { token: q.token, price: q.displayAmount, recipient: q.recipient, resource: '/api/orders/' + order.id });
    if (!checked.valid) {
      order.paymentMessage = checked.error || 'Waiting for confirmation';
      return this.save(order);
    }
    if (checked.isSimulated) throw fail('Orders require real on-chain payment verification', 400);
    order.receipt = await this.services.settlePayment(checked, { endpoint: '/api/orders/' + order.id, orderId: order.id, quoteVersion: q.version });
    order.paymentStatus = 'confirmed'; order.paymentMessage = null;
    // Claim execution durably before invoking an external service. Never replay a
    // side-effecting request after a crash or ambiguous network failure.
    order.deliveryStatus = 'executing'; order.executionStartedAt = Date.now();
    await this.save(order, 'payment_confirmed');
    try {
      const bytes = order.body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(order.body));
      const split = (order.path || '').indexOf('?');
      const target = joinEndpoint(order.endpointUrl, split < 0 ? order.path : order.path.slice(0, split), split < 0 ? '' : order.path.slice(split));
      const response = await this.proxy(target, { method: order.method,
        headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': order.id },
        body: bytes, maxResponseBytes: 1000000, timeoutMs: 25000, followRedirects: false });
      order.result = { status: response.status, contentType: response.headers['content-type'] || 'application/octet-stream',
        encoding: 'base64', body: response.body.toString('base64'), receivedAt: Date.now() };
      order.deliveryStatus = 'completed';
      await this.save(order, 'result_saved');
    } catch (error) {
      order.deliveryStatus = 'unknown';
      // Keep actionable diagnostics without exposing private endpoint URLs or
      // upstream messages. An uncertain delivery must still never be replayed.
      order.deliveryError = {
        code: /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code || '') ? error.code : 'UPSTREAM_DELIVERY_ERROR',
        message: 'Payment confirmed, but the API result could not be saved. Inspect this order; do not pay again.'
      };
      await this.save(order, 'delivery_unknown');
    }
    if (order.deliveryStatus === 'completed') await this.recordAnalytics(order);
    return view(order);
  }
  async recordAnalytics(order) {
    if (!order.analyticsRecorded && this.services.recordOrderResult) {
      try {
        await this.services.recordOrderResult(order);
        order.analyticsRecorded = true;
        await this.save(order);
      } catch (_) { /* The saved service result remains retrievable; reconcile can retry analytics only. */ }
    }
  }
}
const orders = new OrderEngine();
module.exports = { OrderEngine, orders, approvalMessage, cancellationMessage, canonical, view };
