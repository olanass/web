const express = require('express');
const cors = require('cors');

const agentRouter = require('./agent/routes');
const privyAuthRouter = require('./auth/routes');
const path = require('path');
const { CLIENT_DIR, GENERATED_DIR } = require('./config/paths');
const CLIENT_INDEX_PATH = path.join(CLIENT_DIR, 'index.html');
const { ROBINHOOD_CHAIN_CONFIG } = require('./config/chain');
const demoApiRouter = require('./demo/routes');
const facilitatorRouter = require('./facilitator/facilitator');
const paywallRouter = require('./paywall/routes');
const { router: mcpRouter } = require('./mcp/routes');
const { publicRouter: serviceRouter, gatewayRouter: serviceGatewayRouter, discoveryHandler } = require('./services/routes');

function createApp({ serveClient = true } = {}) {
const app = express();
// Behind Vercel's TLS terminator req.protocol is 'http' unless the proxy is trusted, and that
// value is what baseUrl() and the 402 challenge's resource.url are built from. The API was
// handing out http:// links to its own HTTPS endpoints -- which the project's own MCP client
// refuses, since it requires an HTTPS launchpad origin.
app.set('trust proxy', 1);

// This origin runs the wallet connection and builds the transactions people sign, so it should
// not be framable, and a response should not be sniffed into a different type than it claims.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.get('/api/version', (req, res) => res.set('Cache-Control', 'no-store').json({
  application: 'x402-launchpad',
  repository: 'olanass/launchpad-app',
  commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development'
}));

app.use(cors({
  origin: '*',
  exposedHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'WWW-Authenticate']
}));
const jsonParser = express.json();
const serviceJsonParser = express.json({ limit: '1mb' });
const urlencodedParser = express.urlencoded({ extended: true });
app.use((req, res, next) => (req.path.startsWith('/x402/') || req.path.startsWith('/api/services')) ? next() : jsonParser(req, res, next));
app.use((req, res, next) => req.path.startsWith('/x402/') ? next() : urlencodedParser(req, res, next));

app.use('/facilitator', facilitatorRouter);
if (ROBINHOOD_CHAIN_CONFIG.demoMode) app.use('/api', demoApiRouter);
app.use('/api/paywalls', paywallRouter);
app.use('/api/services', serviceJsonParser, serviceRouter);
app.get('/discovery/resources', discoveryHandler);
app.use('/x402', serviceGatewayRouter);
app.use('/api/privy', privyAuthRouter);
app.use('/agent-runner', agentRouter);
app.use('/mcp', mcpRouter);
app.get('/llms.txt', (req, res) => res.type('text/plain').sendFile(path.join(GENERATED_DIR, 'llms.txt')));
app.get(/^\/docs\/(.+)\.md$/, (req, res, next) => {
  const relative = String(req.params[0] || '').replace(/\\/g, '/');
  if (!/^[a-z0-9/_-]+$/i.test(relative) || relative.includes('..')) return next();
  return res.type('text/markdown').sendFile(path.join(GENERATED_DIR, 'docs-markdown', relative + '.md'));
});

const staticOptions = {
  etag: false,
  setHeaders: response => response.setHeader('Cache-Control', 'no-store')
};
if (serveClient) {
  app.use(express.static(CLIENT_DIR, staticOptions));
  app.use('/p', express.static(CLIENT_DIR, staticOptions));
}

app.use(['/api', '/facilitator', '/agent-runner', '/mcp'], (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.code === 'STORAGE_NOT_CONFIGURED'
    ? 503
    : error.code === 'LIMIT_FILE_SIZE'
    ? 413
    : (error.name === 'MulterError' ? 400 : (error.status || 500));
  return res.status(status).json({
    success: false,
    error: error.code === 'STORAGE_NOT_CONFIGURED'
      ? 'The service catalog is temporarily unavailable'
      : (status >= 500 ? 'The request could not be completed' : error.message)
  });
});

if (serveClient) app.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  return res.sendFile(CLIENT_INDEX_PATH);
});

return app;
}

const app = createApp();
module.exports = app;
module.exports.createApp = createApp;
