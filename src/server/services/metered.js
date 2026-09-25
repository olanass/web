'use strict';
const SUFFIX = '/api/inference/escrow/chat/completions';
const PREPAID_SUFFIX = '/api/inference/prepaid/chat/completions';
function validateMetered(body, endpoint) {
  if (body.billingMode == null || body.billingMode === 'fixed') return false;
  if (body.billingMode !== 'metered') throw Object.assign(new Error('Unknown billing mode'), { status: 400 });
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || ![SUFFIX, PREPAID_SUFFIX].includes(url.pathname) || url.search || url.hash ||
      body.currency?.toUpperCase() !== 'USDG' || (body.price != null && body.price !== '')) {
    throw Object.assign(new Error('Metered services require an HTTPS escrow or prepaid completion endpoint, USDG, and no fixed price'), { status: 400 });
  }
  return true;
}
function meteredDetails(service) {
  if (service.billingMode !== 'metered') return null;
  const origin = new URL(service.endpointUrl).origin;
  if (new URL(service.endpointUrl).pathname === PREPAID_SUFFIX) return {
    scheme: 'prepaid-balance', endpoint: service.endpointUrl,
    configUrl: origin + '/api/inference/prepaid/config', modelsUrl: origin + '/api/inference/prepaid/models',
    balanceUrl: origin + '/api/inference/prepaid/balance', depositUrl: origin + '/api/inference/prepaid/deposits',
    refundUrl: origin + '/api/inference/prepaid/refunds', authentication: 'agent-api-key', refunds: 'manual-transfer',
    billing: 'provider-reported-cost', rounding: 'ceil-to-micro-usd', markupBps: 0
  };
  return { scheme: 'batch-settlement', endpoint: service.endpointUrl,
    configUrl: origin + '/api/inference/escrow/config', modelsUrl: origin + '/api/inference/escrow/models',
    refundUrl: origin + '/api/inference/escrow/refund',
    billing: 'provider-reported-cost', rounding: 'ceil-to-micro-usd', markupBps: 0 };
}
module.exports = { validateMetered, meteredDetails };
