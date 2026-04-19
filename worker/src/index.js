// Cloudflare Worker — Proxy for ai.ezif.in
// Deploy: npx wrangler deploy
// Free tier: 100k requests/day

const TARGET = 'https://ai.ezif.in';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    // Normalize path: strip double slashes
    const path = url.pathname.replace(/\/+/g, '/');

    // Only allow /v1/ API paths
    if (!path.startsWith('/v1/')) {
      return new Response(JSON.stringify({ error: `Path not allowed: ${path}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Build target URL
    const targetUrl = `${TARGET}${path}${url.search}`;

    // Forward request
    const headers = new Headers();
    for (const [key, value] of request.headers) {
      if (['content-type', 'authorization'].includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }

    const init = {
      method: request.method,
      headers,
    };

    if (request.method === 'POST') {
      init.body = await request.text();
    }

    const response = await fetch(targetUrl, init);

    // Return response with CORS
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
