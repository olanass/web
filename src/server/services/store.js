const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@libsql/client');
const { ethers } = require('ethers');
const { DATA_DIR } = require('../config/paths');
const { ROBINHOOD_CHAIN_CONFIG: chain } = require('../config/chain');
const { parseAmount } = require('../facilitator/amount');

// A payment whose upstream call failed may be retried, so a bad minute at the origin does not
// cost the buyer their money. Without a ceiling that allowance is unbounded: an upstream that
// answers 4xx to a malformed request -- an unknown identifier, say -- hands back a fresh attempt
// every time, and the body is relayed on each one, so a single payment buys unlimited proxied
// calls against the creator's origin. The attempts column was already being counted; this reads it.
const MAX_RECEIPT_ATTEMPTS = 3;

function slugify(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'service';
}

function databaseConfig() {
  const url = process.env.TURSO_DATABASE_URL || `file:${path.join(DATA_DIR, 'launchpad.db')}`;
  if (process.env.NODE_ENV === 'production' && !process.env.TURSO_DATABASE_URL) {
    const error = new Error('Durable service storage is not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }
  return { url, authToken: process.env.TURSO_AUTH_TOKEN || undefined };
}

function addAmount(left, right, currency) {
  const decimals = chain.supportedTokens[currency].decimals;
  return ethers.formatUnits(ethers.parseUnits(left || '0', decimals) + parseAmount(right, currency), decimals);
}

function publicService(service, baseUrl) {
  const gatewayPath = `/x402/${service.slug}`;
  const openapiPath = `/api/services/${encodeURIComponent(service.slug)}/openapi.json`;
  return {
    serviceId: service.serviceId, slug: service.slug, name: service.name, description: service.description,
    category: service.category, videoUrl: service.videoUrl || null,
    logoUrl: service.logo ? `${baseUrl ? baseUrl.replace(/\/$/, '') : ''}/api/services/${encodeURIComponent(service.slug)}/logo` : null,
    allowedMethods: service.allowedMethods, price: service.price, currency: service.currency,
    network: service.network, chainId: service.chainId, creatorAddress: service.creatorAddress,
    payoutAddress: service.payoutAddress, status: service.status, requests: service.paidRequests,
    revenue: service.totalEarned, revenueUsd: ['USDC', 'USDG'].includes(service.currency) ? Number(service.totalEarned) : null,
    successfulResponses: service.successfulResponses, failedResponses: service.failedResponses,
    lastRequestAt: service.lastRequestAt, lastSuccessAt: service.lastSuccessAt,
    createdAt: service.createdAt, updatedAt: service.updatedAt, gatewayPath,
    openapiUrl: service.openapiDocument ? (baseUrl ? baseUrl.replace(/\/$/, '') : '') + openapiPath : null,
    gatewayUrl: baseUrl ? baseUrl.replace(/\/$/, '') + gatewayPath : gatewayPath
  };
}

class ServiceStore {
  constructor() { this.client = null; this.initializing = null; }
  async init() {
    if (this.client) return this.client;
    if (!this.initializing) this.initializing = (async () => {
      const client = createClient(databaseConfig());
      await client.execute(`CREATE TABLE IF NOT EXISTS services (
        service_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, creator_address TEXT NOT NULL,
        creation_signature TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
      )`);
      const serviceColumns = await client.execute('PRAGMA table_info(services)');
      if (!serviceColumns.rows.some(row => row.name === 'version')) {
        await client.execute('ALTER TABLE services ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
      }
      await client.execute('CREATE INDEX IF NOT EXISTS services_creator_idx ON services(creator_address, created_at DESC)');
      await client.execute(`CREATE TABLE IF NOT EXISTS service_receipts (
        receipt_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        FOREIGN KEY(service_id) REFERENCES services(service_id) ON DELETE CASCADE
      )`);
      await client.execute(`CREATE TABLE IF NOT EXISTS durable_redemptions (
        redemption_key TEXT PRIMARY KEY, receipt_id TEXT, receipt TEXT NOT NULL, created_at TEXT NOT NULL
      )`);
      const redemptionColumns = await client.execute('PRAGMA table_info(durable_redemptions)');
      if (!redemptionColumns.rows.some(row => row.name === 'receipt_id')) {
        await client.execute('ALTER TABLE durable_redemptions ADD COLUMN receipt_id TEXT');
      }
      await client.execute('CREATE INDEX IF NOT EXISTS durable_redemptions_receipt_idx ON durable_redemptions(receipt_id)');
      await client.execute(`CREATE TABLE IF NOT EXISTS service_management_signatures (
        signature TEXT PRIMARY KEY, service_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(service_id) REFERENCES services(service_id) ON DELETE CASCADE
      )`);
      this.client = client;
      return client;
    })().catch(error => { this.initializing = null; throw error; });
    return this.initializing;
  }
  rowService(row) {
    if (!row) return null;
    return { ...JSON.parse(row.data), _version: Number(row.version || 0) };
  }
  async persist(service) {
    const client = await this.init();
    const stored = { ...service };
    delete stored._version;
    const result = await client.execute({
      sql: 'UPDATE services SET status = ?, data = ?, version = version + 1 WHERE service_id = ? AND version = ?',
      args: [service.status, JSON.stringify(stored), service.serviceId, service._version || 0]
    });
    if (result.rowsAffected !== 1) throw Object.assign(new Error('Service changed concurrently; retry the update'), { status: 409 });
    service._version = (service._version || 0) + 1;
  }
  async create(input) {
    const client = await this.init();
    let slug = slugify(input.slug || input.name);
    const collision = await client.execute({ sql: 'SELECT 1 FROM services WHERE slug = ?', args: [slug] });
    if (collision.rows.length) slug += '-' + crypto.randomBytes(3).toString('hex');
    const now = new Date().toISOString();
    const serviceId = 'svc_' + crypto.randomBytes(12).toString('hex');
    const logo = input.logo ? { mimeType: input.logo.mimeType, hash: input.logo.hash, data: input.logo.buffer.toString('base64') } : null;
    const service = {
      serviceId, slug, name: input.name, description: input.description, category: input.category,
      videoUrl: input.videoUrl || '', logo, endpointUrl: input.endpointUrl,
      openapiDocument: input.openapiDocument || null, openapiHash: input.openapiHash || '',
      allowedMethods: input.allowedMethods, price: input.price, currency: input.currency,
      network: chain.networkId, chainId: chain.chainId,
      creatorAddress: ethers.getAddress(input.creatorAddress.toLowerCase()), payoutAddress: ethers.getAddress(input.payoutAddress.toLowerCase()),
      creatorSignature: input.creatorSignature, status: 'live', paidRequests: 0, successfulResponses: 0,
      failedResponses: 0, totalEarned: '0', lastRequestAt: null, lastSuccessAt: null,
      recentCalls: [], createdAt: now, updatedAt: now
    };
    await client.execute({
      sql: 'INSERT INTO services(service_id, slug, creator_address, creation_signature, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [serviceId, slug, service.creatorAddress.toLowerCase(), service.creatorSignature, service.status, now, JSON.stringify(service)]
    });
    return service;
  }
  async getById(id) {
    const c = await this.init();
    const r = await c.execute({ sql: 'SELECT data, version FROM services WHERE service_id = ?', args: [id] });
    return this.rowService(r.rows[0]);
  }
  async getBySlug(slug) {
    const c = await this.init();
    const r = await c.execute({ sql: 'SELECT data, version FROM services WHERE slug = ?', args: [slug] });
    return this.rowService(r.rows[0]);
  }
  async byCreator(address) {
    const c = await this.init();
    const r = await c.execute({ sql: 'SELECT data, version FROM services WHERE creator_address = ? ORDER BY created_at DESC', args: [address.toLowerCase()] });
    return r.rows.map(row => this.rowService(row));
  }
  async hasCreationSignature(signature) {
    const c = await this.init();
    const r = await c.execute({ sql: 'SELECT 1 FROM services WHERE creation_signature = ?', args: [signature] });
    return Boolean(r.rows.length);
  }
  async list({ status, category, search, limit = 20, offset = 0 } = {}) {
    const c = await this.init();
    const r = await c.execute('SELECT data, version FROM services ORDER BY created_at DESC');
    let services = r.rows.map(row => this.rowService(row));
    if (status) services = services.filter(service => service.status === status);
    if (category) services = services.filter(service => service.category.toLowerCase() === category.toLowerCase());
    if (search) {
      const query = search.toLowerCase();
      services = services.filter(service => `${service.name} ${service.description}`.toLowerCase().includes(query));
    }
    return { total: services.length, services: services.slice(offset, offset + limit) };
  }
  async update(service, changes) {
    Object.assign(service, changes, { updatedAt: new Date().toISOString() });
    await this.persist(service);
    return service;
  }
  async remove(service) {
    const c = await this.init();
    await c.execute({ sql: 'DELETE FROM services WHERE service_id = ?', args: [service.serviceId] });
  }
  async claimManagementSignature(serviceId, action, signature) {
    const c = await this.init();
    const result = await c.execute({
      sql: 'INSERT OR IGNORE INTO service_management_signatures(signature, service_id, action, created_at) VALUES (?, ?, ?, ?)',
      args: [signature, serviceId, action, new Date().toISOString()]
    });
    return result.rowsAffected === 1;
  }
  async reserveReceipt(serviceId, receiptId) {
    const c = await this.init();
    const now = new Date().toISOString();
    const result = await c.execute({
      sql: 'INSERT INTO service_receipts(receipt_id, service_id, state, attempts, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(receipt_id) DO UPDATE SET state = ?, attempts = attempts + 1, updated_at = excluded.updated_at WHERE state = ? AND service_id = ? AND attempts < ?',
      args: [receiptId, serviceId, 'pending', now, 'pending', 'failed', serviceId, MAX_RECEIPT_ATTEMPTS]
    });
    return result.rowsAffected === 1;
  }
  async settlePayment(data, metadata = {}) {
    if (!data?.valid || (!data.isSimulated && !data.txHash)) throw new Error('Confirmed payment required');
    const c = await this.init();
    const receipt = {
      receiptId: 'rcpt_rh_' + crypto.createHash('sha256').update(data.redemptionKey).digest('hex').slice(0, 16),
      status: data.isSimulated ? 'simulated' : 'settled', isSimulated: Boolean(data.isSimulated),
      network: chain.networkId, chainId: chain.chainId, caip2: chain.caip2,
      token: data.token, amount: data.amount, facilitatorFee: '0', merchantPayout: data.amount,
      payer: data.payer, recipient: data.recipient,
      settlementType: data.isSimulated ? 'simulation' : 'onchain-mined',
      txHash: data.txHash || null, settledAt: new Date().toISOString(),
      explorerLink: data.txHash ? chain.explorerUrl + '/tx/' + data.txHash : null, metadata
    };
    const inserted = await c.execute({
      sql: 'INSERT OR IGNORE INTO durable_redemptions(redemption_key, receipt_id, receipt, created_at) VALUES (?, ?, ?, ?)',
      args: [data.redemptionKey, receipt.receiptId, JSON.stringify(receipt), receipt.settledAt]
    });
    if (inserted.rowsAffected === 1) return receipt;
    const existing = await c.execute({ sql: 'SELECT receipt FROM durable_redemptions WHERE redemption_key = ?', args: [data.redemptionKey] });
    const previous = existing.rows[0] ? JSON.parse(existing.rows[0].receipt) : null;
    if (previous && previous.payer === receipt.payer && previous.recipient === receipt.recipient &&
        previous.token === receipt.token && previous.amount === receipt.amount &&
        previous.metadata?.endpoint === receipt.metadata?.endpoint) return { ...previous, replayed: true };
    throw new Error('Payment has already been redeemed for another requirement');
  }
  async getReceiptById(receiptId) {
    const c = await this.init();
    const result = await c.execute({
      sql: 'SELECT receipt FROM durable_redemptions WHERE receipt_id = ? LIMIT 1',
      args: [receiptId]
    });
    return result.rows[0] ? JSON.parse(result.rows[0].receipt) : null;
  }
  async recordResult(serviceId, receipt, result) {
    const c = await this.init();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const service = await this.getById(serviceId);
      if (!service) return;
      const now = new Date().toISOString();
      if (result.success) {
        service.paidRequests += 1;
        service.successfulResponses += 1;
        service.totalEarned = addAmount(service.totalEarned, service.price, service.currency);
        service.lastRequestAt = now;
        service.lastSuccessAt = now;
      } else {
        service.failedResponses += 1;
      }
      service.recentCalls.unshift({
        receiptId: receipt.receiptId, status: result.status, latencyMs: result.latencyMs,
        success: result.success, timestamp: now
      });
      service.recentCalls = service.recentCalls.slice(0, 50);
      service.updatedAt = now;
      const stored = { ...service };
      delete stored._version;
      const update = await c.execute({
        sql: 'UPDATE services SET data = ?, version = version + 1 WHERE service_id = ? AND version = ?',
        args: [JSON.stringify(stored), serviceId, service._version || 0]
      });
      if (update.rowsAffected === 1) {
        await c.execute({
          sql: 'UPDATE service_receipts SET state = ?, updated_at = ? WHERE receipt_id = ? AND service_id = ?',
          args: [result.success ? 'succeeded' : 'failed', now, receipt.receiptId, serviceId]
        });
        return;
      }
    }
    throw Object.assign(new Error('Could not record service analytics due to concurrent updates'), { status: 409 });
  }
  async close() {
    if (this.client) await this.client.close();
    this.client = null;
    this.initializing = null;
  }
}

const serviceStore = new ServiceStore();
function serviceLogo(service) { return service?.logo?.data ? { buffer: Buffer.from(service.logo.data, 'base64'), mimeType: service.logo.mimeType } : null; }
module.exports = { serviceStore, publicService, slugify, serviceLogo };
