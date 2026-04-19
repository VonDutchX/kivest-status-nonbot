const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3099;
const TARGET = (process.env.UPSTREAM_BASE_URL || 'https://ai.ezif.in').replace(/\/+$/, '');
const PROXY_TOKEN = process.env.PROXY_TOKEN;

// Constant-time comparison to prevent timing attacks
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// === Request log for dashboard ===
const MAX_LOG_ENTRIES = 200;
const requestLog = [];
let stats = { total: 0, success: 0, errors: 0, started: new Date().toISOString() };

function logRequest(entry) {
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_ENTRIES) requestLog.shift();
  stats.total++;
  if (entry.upstreamStatus && entry.upstreamStatus < 400) stats.success++;
  else stats.errors++;
}

// === Dashboard HTML ===
function dashboardHTML() {
  const uptime = Math.floor((Date.now() - new Date(stats.started).getTime()) / 1000);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  const rows = requestLog.slice().reverse().map(r => {
    const statusClass = r.upstreamStatus < 400 ? '#4ade80' : '#f87171';
    const model = r.model || '-';
    return `<tr>
      <td>${r.time}</td>
      <td>${r.method}</td>
      <td>${r.path}</td>
      <td>${model}</td>
      <td style="color:${statusClass};font-weight:bold">${r.upstreamStatus || r.error || '?'}</td>
      <td>${r.duration}ms</td>
      <td>${r.clientIP}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Kivest Proxy Dashboard</title>
<meta http-equiv="refresh" content="5">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0f172a; color:#e2e8f0; font-family:system-ui,-apple-system,sans-serif; padding:20px; }
  h1 { color:#38bdf8; margin-bottom:8px; }
  .stats { display:flex; gap:20px; margin:16px 0; flex-wrap:wrap; }
  .stat { background:#1e293b; padding:16px 24px; border-radius:8px; }
  .stat-value { font-size:28px; font-weight:bold; color:#38bdf8; }
  .stat-label { font-size:13px; color:#94a3b8; margin-top:4px; }
  .stat-success .stat-value { color:#4ade80; }
  .stat-error .stat-value { color:#f87171; }
  table { width:100%; border-collapse:collapse; margin-top:16px; font-size:13px; }
  th { background:#1e293b; padding:10px 12px; text-align:left; position:sticky; top:0; color:#94a3b8; }
  td { padding:8px 12px; border-bottom:1px solid #1e293b; }
  tr:hover td { background:#1e293b; }
  .info { color:#94a3b8; font-size:13px; margin-bottom:16px; }
</style></head><body>
  <h1>Kivest Proxy Dashboard</h1>
  <p class="info">Target: ${TARGET} | Uptime: ${h}h ${m}m ${s}s | Auto-refresh: 5s</p>
  <div class="stats">
    <div class="stat"><div class="stat-value">${stats.total}</div><div class="stat-label">Total Requests</div></div>
    <div class="stat stat-success"><div class="stat-value">${stats.success}</div><div class="stat-label">Success</div></div>
    <div class="stat stat-error"><div class="stat-value">${stats.errors}</div><div class="stat-label">Errors</div></div>
  </div>
  <table>
    <thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Model</th><th>Status</th><th>Duration</th><th>Client</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:20px;color:#64748b">No requests yet</td></tr>'}</tbody>
  </table>
</body></html>`;
}

const server = http.createServer((req, res) => {
  // Dashboard endpoint (no auth needed, only shows request metadata)
  if (req.url === '/' || req.url === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardHTML());
    return;
  }

  // JSON stats endpoint
  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats, recentRequests: requestLog.slice(-20) }));
    return;
  }

  // Reject if no token configured (fail-closed)
  if (!PROXY_TOKEN) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy not configured' }));
    return;
  }

  // Authenticate request via X-Proxy-Token header
  const token = req.headers['x-proxy-token'];
  if (!safeCompare(token || '', PROXY_TOKEN)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  // Only allow /v1/ paths
  const urlPath = req.url.replace(/\/+/g, '/');
  if (!urlPath.startsWith('/v1/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const targetUrl = new URL(urlPath, TARGET);
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid upstream protocol' }));
    return;
  }

  // Extract model name from request body for logging
  let modelName = null;
  const requestStart = Date.now();
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const bodyChunks = [];

  // Forward only safe headers, strip proxy token
  const headers = {
    'user-agent': 'Mozilla/5.0 (compatible; status-monitor/1.0)',
    'connection': 'close',
  };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'];

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers,
  };

  console.log(`[${new Date().toISOString()}] ${req.method} ${urlPath} from ${clientIP}`);

  const upstreamClient = targetUrl.protocol === 'https:' ? https : http;
  const proxyReq = upstreamClient.request(options, (proxyRes) => {
    const duration = Date.now() - requestStart;
    console.log(`  → ${proxyRes.statusCode} (${duration}ms)${modelName ? ` [${modelName}]` : ''}`);

    logRequest({
      time: new Date().toISOString(),
      method: req.method,
      path: urlPath,
      model: modelName,
      upstreamStatus: proxyRes.statusCode,
      duration,
      clientIP
    });

    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    const duration = Date.now() - requestStart;
    console.error(`  ✗ Proxy error (${duration}ms): ${err.message}${modelName ? ` [${modelName}]` : ''}`);

    logRequest({
      time: new Date().toISOString(),
      method: req.method,
      path: urlPath,
      model: modelName,
      error: err.message,
      upstreamStatus: 502,
      duration,
      clientIP
    });

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  // Collect body to extract model name, then forward
  req.on('data', chunk => bodyChunks.push(chunk));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(bodyChunks);
    try {
      const parsed = JSON.parse(bodyBuf.toString());
      modelName = parsed.model || null;
    } catch {}
    proxyReq.write(bodyBuf);
    proxyReq.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy running on :${PORT} → ${TARGET}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  if (!PROXY_TOKEN) console.warn('WARNING: PROXY_TOKEN not set — all requests will be rejected');
});
