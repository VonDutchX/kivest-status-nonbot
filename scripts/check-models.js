const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DIRECT_API = 'https://ai.ezif.in';
const PROXY_URL = process.env.API_PROXY_URL ? process.env.API_PROXY_URL.replace(/\/+$/, '') : null;
let API_BASE = (PROXY_URL || DIRECT_API);
const API_KEY = process.env.KIVEST_API_KEY;
let PROXY_TOKEN = process.env.PROXY_TOKEN || null;
const DATA_DIR = path.join(__dirname, '..', 'data');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Force no keep-alive — critical for Playit.gg tunnel which hangs on reused connections
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

const MAX_HISTORY_ENTRIES = 288; // 24h at 5-min intervals
const DELAY_BETWEEN_MODELS_MS = 12000; // 12s between each model (stays safely under burst limit + 5 RPM global)

// Non-LLM models to exclude (image generation, video generation, slides, deep-research)
const EXCLUDED_MODELS = new Set([
  'qwen-image', 'glm-image', 'gpt-image-1', 'gpt-image-1.5',
  'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'grok-image',
  'qwen-video', 'grok-video', 'veo-3.1',
  'qwen-slides', 'qwen-deep-research'
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchModels() {
  // Helper: add proxy token if configured
  const proxyHeader = PROXY_TOKEN ? { 'x-proxy-token': PROXY_TOKEN } : {};

  // Prefer documented auth flow first, then fallback without auth if needed.
  for (const authHeaders of [{ 'Authorization': `Bearer ${API_KEY}` }, {}]) {
    try {
      const url = `${API_BASE}/v1/models`;
      console.log(`Fetching models from ${url} (auth=${!!authHeaders.Authorization})...`);
      const res = await rawRequest(url, {
        method: 'GET',
        headers: { 'Connection': 'close', ...proxyHeader, ...authHeaders },
        timeout: 30000
      });
      console.log(`  ← ${res.status} (${res.body.length} bytes)`);
      if (res.status >= 200 && res.status < 300) {
        const data = JSON.parse(res.body);
        return (data.data || []).filter(m => !EXCLUDED_MODELS.has(m.id));
      }
      console.warn(`/v1/models returned ${res.status} (auth=${!!authHeaders.Authorization}): ${res.body.slice(0, 200)}`);
    } catch (err) {
      console.warn(`/v1/models fetch failed (auth=${!!authHeaders.Authorization}): ${err.message}`);
    }
  }
  // Fallback: use model list from previous status.json
  console.warn('Live model list unavailable, falling back to cached status.json');
  try {
    const cached = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
    const ids = Object.keys(cached.models || {});
    if (ids.length > 0) {
      return ids.filter(id => !EXCLUDED_MODELS.has(id)).map(id => ({
        id,
        owned_by: cached.models[id].ownedBy || 'unknown'
      }));
    }
  } catch {}
  throw new Error('Failed to fetch models from API and no cached data available');
}

/**
 * Make an HTTP(S) request manually to avoid Node.js fetch (undici) keeping TCP alive.
 * This is critical for the Playit.gg tunnel which hangs on reused connections.
 */
function rawRequest(url, options, bodyStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers
      },
      agent,
      timeout: options.timeout || 90000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Test a single LLM model.
 * First tries with thinking params to detect reasoning support.
 * If content comes back empty, retries without thinking params.
 * Stores the full raw JSON response for the frontend to display.
 */
async function testModel(modelId) {
  const start = Date.now();
  const url = `${API_BASE}/v1/chat/completions`;

  async function doRequest(withThinking) {
    const params = {
      model: modelId,
      messages: [{ role: 'user', content: 'Which LLM are you?' }],
      max_tokens: 120,
      stream: false,
    };
    if (withThinking) {
      params.include_thinking = true;
    }

    console.log(`    → POST ${url} (model: ${modelId}${withThinking ? ', +thinking' : ', plain'})`);
    const res = await rawRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'close',
        'Authorization': `Bearer ${API_KEY}`,
        ...(PROXY_TOKEN ? { 'x-proxy-token': PROXY_TOKEN } : {})
      },
      timeout: 90000
    }, JSON.stringify(params));

    const elapsed = Date.now() - start;
    console.log(`    ← ${res.status} (${elapsed}ms, ${res.body.length} bytes, content-type: ${res.headers['content-type'] || 'none'})`);
    return { res, elapsed };
  }

  try {
    // First attempt: with thinking params
    let { res, elapsed } = await doRequest(true);

    // Handle non-JSON responses (e.g. proxy errors)
    const contentType = res.headers['content-type'] || '';
    let body;
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(res.body);
      } catch (parseErr) {
        console.log(`    ⚠ JSON parse failed: ${parseErr.message}, body: ${res.body.slice(0, 200)}`);
        return {
          status: 'down',
          responseTime: elapsed,
          isPaidOnly: false,
          supportsReasoning: false,
          response: null,
          rawResponse: null,
          error: `JSON parse error: ${res.body.slice(0, 300)}`
        };
      }
    } else {
      console.log(`    ⚠ Non-JSON response: ${res.body.slice(0, 200)}`);
      return {
        status: 'down',
        responseTime: elapsed,
        isPaidOnly: false,
        supportsReasoning: false,
        response: null,
        rawResponse: null,
        error: `HTTP ${res.status}: ${res.body.slice(0, 500)}`
      };
    }

    if (res.status >= 400 || body?.error) {
      const errMsg = body?.error?.message || '';
      console.log(`    ⚠ API error: ${errMsg.slice(0, 150)}`);
      // Paid model detection: check multiple error patterns from Kivest API
      const isPaid = errMsg.includes('does not have access to model')
        || errMsg.includes('is only available on paid plans');
      return {
        status: isPaid ? 'paid_only' : 'down',
        responseTime: elapsed,
        isPaidOnly: isPaid,
        supportsReasoning: false,
        response: null,
        reasoningContent: null,
        rawResponse: body,
        error: errMsg.slice(0, 500)
      };
    }

    // Detect reasoning support from the response
    let choice = body?.choices?.[0];
    let hasReasoningContent = !!(
      choice?.message?.reasoning_content ||
      choice?.message?.reasoning
    );
    // Check content_blocks for thinking (e.g. Gemini)
    let contentBlocks = choice?.message?.content_blocks || [];
    let thinkingBlock = contentBlocks.find(b => b.type === 'thinking');
    let hasThinkingBlock = !!thinkingBlock;
    // Check multiple locations for reasoning tokens
    let hasReasoningTokens = (body?.usage?.reasoning_tokens || 0) > 0
      || (body?.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0;
    let responseText = (choice?.message?.content || '').trim();
    let reasoningText = (
      choice?.message?.reasoning_content ||
      choice?.message?.reasoning ||
      (thinkingBlock?.thinking || '')
    ).trim();

    // If content is empty, retry WITHOUT thinking params — some models break with them
    if (!responseText && !reasoningText) {
      console.log(`    ⚠ Empty content with thinking params, retrying without...`);
      const retry = await doRequest(false);
      elapsed = retry.elapsed;
      const retryContentType = retry.res.headers['content-type'] || '';
      if (retryContentType.includes('application/json')) {
        try {
          body = JSON.parse(retry.res.body);
          choice = body?.choices?.[0];
          responseText = (choice?.message?.content || '').trim();
          // No need to re-check reasoning — this was a plain request
        } catch {}
      }
    }

    // If the model only returned reasoning content but no main content,
    // use a truncated version of the reasoning as the display response.
    // Always ensure a non-null response for successful models.
    const displayResponse = responseText
      || (reasoningText ? `[Reasoning only] ${reasoningText.slice(0, 300)}` : null)
      || '[No text content returned]';

    return {
      status: 'operational',
      responseTime: elapsed,
      isPaidOnly: false,
      supportsReasoning: hasReasoningContent || hasReasoningTokens || hasThinkingBlock,
      response: displayResponse,
      reasoningContent: reasoningText || null,
      rawResponse: body,
      error: null
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const errType = err.message?.includes('timed out') ? 'Timeout (90s)' : `${err.name}: ${err.message}`;
    console.log(`    ✗ Request failed after ${elapsed}ms: ${errType}`);
    return {
      status: 'down',
      responseTime: elapsed,
      isPaidOnly: false,
      supportsReasoning: false,
      response: null,
      rawResponse: null,
      error: errType.slice(0, 500)
    };
  }
}

async function main() {
  if (!API_KEY) {
    console.error('KIVEST_API_KEY environment variable is required');
    process.exit(1);
  }

  // Load existing data
  let statusData;
  try {
    statusData = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
  } catch {
    statusData = { lastRun: null, runCount: 0, models: {} };
  }

  let history;
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    history = [];
  }

  const runCount = (statusData.runCount || 0) + 1;
  const now = new Date().toISOString();

  // Fetch LLM models only
  console.log('Fetching model list...');
  const models = await fetchModels();
  console.log(`Found ${models.length} LLM models (excluded ${EXCLUDED_MODELS.size} non-LLM models)`);
  console.log(`Run #${runCount}`);

  // Build test queue
  const testQueue = models.map(m => ({
    id: m.id,
    ownedBy: m.owned_by
  }));

  console.log(`Testing ${testQueue.length} models sequentially (${DELAY_BETWEEN_MODELS_MS / 1000}s delay between each)...`);

  const MAX_RETRIES = 2;

  // Live status object — written to disk after every model
  const liveModels = { ...(statusData.models || {}) };

  // Helper: build and write status.json with current results
  function writeLiveStatus(testedCount) {
    const liveStatus = {
      lastRun: now,
      runCount,
      totalModels: models.length,
      testedModels: testedCount,
      inProgress: testedCount < testQueue.length,
      models: liveModels
    };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(liveStatus, null, 2));
  }

  // Process one model at a time to stay within rate limits
  const results = {};
  for (let i = 0; i < testQueue.length; i++) {
    const model = testQueue[i];
    console.log(`[${i + 1}/${testQueue.length}] Testing ${model.id}...`);

    let result;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      result = await testModel(model.id);

      // Retry on rate limit errors
      const isRateLimit = result.error && (
        result.error.includes('rate limit') ||
        result.error.includes('Rate limit') ||
        result.error.includes('Burst limit') ||
        result.error.includes('Slow down') ||
        result.error.includes('too many requests')
      );

      if (isRateLimit && attempt < MAX_RETRIES) {
        const waitSec = 15 + attempt * 10; // 15s, 25s
        console.log(`  ⏳ Rate limited, retrying in ${waitSec}s (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`);
        await sleep(waitSec * 1000);
        continue;
      }
      break;
    }

    results[model.id] = { ...model, ...result };

    const r = results[model.id];
    const emoji = r.status === 'operational' ? '✓' :
                   r.status === 'paid_only' ? '$' : '✗';
    const extras = [];
    if (r.supportsReasoning) extras.push('reasoning');
    if (r.isPaidOnly) extras.push('paid');
    const extraStr = extras.length ? ` [${extras.join(', ')}]` : '';
    console.log(`  ${emoji} ${r.status} (${r.responseTime}ms)${extraStr}`);

    // Immediately update live status with this model's result
    const prev = statusData.models?.[model.id];
    const prevReasoning = prev?.supportsReasoning || false;
    liveModels[model.id] = {
      id: model.id,
      ownedBy: model.ownedBy,
      status: r.status,
      responseTime: r.responseTime,
      supportsReasoning: r.supportsReasoning || prevReasoning,
      isPaidOnly: r.isPaidOnly,
      response: r.response,
      reasoningContent: r.reasoningContent || null,
      rawResponse: r.rawResponse || null,
      error: r.error,
      lastChecked: now,
      uptime: prev?.uptime ?? null,
      totalChecks: prev?.totalChecks ?? null
    };
    writeLiveStatus(i + 1);

    // Wait between models (except after the last one)
    if (i < testQueue.length - 1) {
      await sleep(DELAY_BETWEEN_MODELS_MS);
    }
  }

  // Merge results with existing status data
  const updatedModels = {};
  for (const model of models) {
    const id = model.id;
    const prev = statusData.models?.[id];
    if (results[id]) {
      // Preserve reasoning flag if previously detected (reasoning is sticky)
      const prevReasoning = prev?.supportsReasoning || false;
      updatedModels[id] = {
        id,
        ownedBy: model.owned_by,
        status: results[id].status,
        responseTime: results[id].responseTime,
        supportsReasoning: results[id].supportsReasoning || prevReasoning,
        isPaidOnly: results[id].isPaidOnly,
        response: results[id].response,
        reasoningContent: results[id].reasoningContent || null,
        rawResponse: results[id].rawResponse || null,
        error: results[id].error,
        lastChecked: now
      };
    } else {
      updatedModels[id] = prev || {
        id,
        ownedBy: model.owned_by,
        status: 'unknown',
        responseTime: null,
        supportsReasoning: false,
        isPaidOnly: false,
        response: null,
        error: null,
        lastChecked: null
      };
    }
  }

  // Build history entry
  const historyEntry = {
    timestamp: now,
    runCount,
    statuses: {}
  };
  for (const [id, m] of Object.entries(results)) {
    historyEntry.statuses[id] = {
      status: m.status,
      responseTime: m.responseTime
    };
  }
  history.push(historyEntry);

  // Trim history
  if (history.length > MAX_HISTORY_ENTRIES) {
    history = history.slice(-MAX_HISTORY_ENTRIES);
  }

  // Calculate uptime per model from history
  const uptimeMap = {};
  for (const entry of history) {
    for (const [id, s] of Object.entries(entry.statuses)) {
      if (!uptimeMap[id]) uptimeMap[id] = { total: 0, up: 0 };
      uptimeMap[id].total++;
      if (s.status === 'operational') uptimeMap[id].up++;
    }
  }
  for (const [id, u] of Object.entries(uptimeMap)) {
    if (updatedModels[id]) {
      updatedModels[id].uptime = u.total > 0
        ? parseFloat(((u.up / u.total) * 100).toFixed(2))
        : null;
      updatedModels[id].totalChecks = u.total;
    }
  }

  // Write status.json
  const finalStatus = {
    lastRun: now,
    runCount,
    totalModels: models.length,
    models: updatedModels
  };

  fs.writeFileSync(STATUS_FILE, JSON.stringify(finalStatus, null, 2));
  console.log(`\nWrote ${STATUS_FILE}`);

  // Write history.json
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  console.log(`Wrote ${HISTORY_FILE}`);

  // Summary
  const statuses = Object.values(updatedModels);
  const operational = statuses.filter(m => m.status === 'operational').length;
  const down = statuses.filter(m => m.status === 'down').length;
  const paidOnly = statuses.filter(m => m.status === 'paid_only').length;
  const reasoning = statuses.filter(m => m.supportsReasoning).length;

  console.log(`\n=== Summary ===`);
  console.log(`Operational: ${operational} | Down: ${down} | Paid Only: ${paidOnly}`);
  console.log(`Reasoning-capable: ${reasoning}`);
  console.log(`Total LLMs: ${models.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
