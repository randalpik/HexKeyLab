// Usage analytics: relays the tracker's events to Umami Cloud, adding the
// visitor's address to the payload. A plain rewrite to the gateway is not
// enough: Umami then geolocates the Netlify node that made the request, so
// every visitor shows up in a data-center city. Umami's send handler takes the
// payload's `ip` over anything it derives from the connection.
//
// The path must match ANALYTICS_PREFIX in vite/analytics-tag.mjs (the tracker
// posts to <prefix>/api/send). The tracker script itself is a rewrite in
// netlify.toml.

const UPSTREAM = 'https://gateway.umami.is/api/send';

export default async function umamiSend(request, context) {
  let body;
  try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
  const payload = body?.payload;
  if (payload === null || typeof payload !== 'object') return new Response(null, { status: 400 });
  /* Always ours, so a sender cannot choose its own location. */
  payload.ip = context.ip;

  /* What Umami reads: the browser (user-agent) and the tracker's own headers. */
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (name === 'content-type' || name === 'user-agent' || name.startsWith('x-umami-')) {
      headers.set(name, value);
    }
  }

  const upstream = await fetch(UPSTREAM, { method: 'POST', headers, body: JSON.stringify(body) });
  /* The tracker reads the JSON body (its session cache token) and, when
     throttled, Retry-After. */
  const out = new Headers();
  for (const name of ['content-type', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const config = { path: '/u/api/send', method: 'POST' };
