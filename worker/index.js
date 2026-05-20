/**
 * Cloudflare Worker — OpenRouter proxy for dristi-dashboard
 *
 * Secrets required (set via `wrangler secret put` or Cloudflare dashboard):
 *   OPENROUTER_KEY   your OpenRouter API key
 *
 * Allowed origin: your GitHub Pages URL (edit ALLOWED_ORIGIN below).
 */

const ALLOWED_ORIGIN = 'https://varun-heman.github.io';
const OR_URL         = 'https://openrouter.ai/api/v1/chat/completions';

export default {
  async fetch(request, env) {

    // ── CORS preflight ──────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // ── Only allow POST from your Pages site ────────────────────
    const origin = request.headers.get('Origin') || '';
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    if (!origin.startsWith(ALLOWED_ORIGIN)) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── Forward request to OpenRouter ───────────────────────────
    let body;
    try { body = await request.json(); }
    catch { return new Response('Bad JSON', { status: 400 }); }

    const orResp = await fetch(OR_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });

    // Stream the response back (supports SSE streaming)
    return new Response(orResp.body, {
      status:  orResp.status,
      headers: {
        'Content-Type': orResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(),
      },
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
