// The usage-analytics tag (Umami Cloud), added to each app's index.html when
// the publish directory is assembled (assemble-dist.mjs) — so only the deployed
// build carries it: `pnpm dev`, the test suites and a per-app build never do.
// App code reports events through @hkl/bridge/analytics.js, which is a no-op
// without the tracker.
//
// The tracker and its endpoint are served from our own origin under
// ANALYTICS_PREFIX, by the two proxy rewrites in netlify.toml (content blockers
// list the Umami hosts). The tracker posts to `<data-host-url>/api/send`, so
// those rewrites and this prefix must agree.
//
// The loader skips every host but the production one (deploy previews, a local
// `vite preview`) and the `?overlay` instance, an OBS Browser Source that
// reloads with every scene change and is not a visit.

export const ANALYTICS_HOST = 'hexkeylab.maxrandalmusic.com';
export const ANALYTICS_PREFIX = '/u';

const WEBSITE_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** The inline loader for `websiteId` (an Umami website UUID). */
export function analyticsTag(websiteId) {
  if (!WEBSITE_ID.test(websiteId)) {
    throw new Error(`analytics-tag: not an Umami website id: ${JSON.stringify(websiteId)}`);
  }
  return '<script>(function(){'
    + `if(location.hostname!=='${ANALYTICS_HOST}'||new URLSearchParams(location.search).has('overlay'))return;`
    + "var s=document.createElement('script');s.async=true;"
    + `s.src='${ANALYTICS_PREFIX}/s.js';`
    + `s.setAttribute('data-website-id','${websiteId}');`
    + `s.setAttribute('data-host-url','${ANALYTICS_PREFIX}');`
    + 'document.head.appendChild(s);'
    + '})();</script>';
}

/** `html` with the loader as the last element of <head>. */
export function injectAnalytics(html, websiteId) {
  const at = html.indexOf('</head>');
  if (at < 0) throw new Error('analytics-tag: no </head> to inject before');
  return html.slice(0, at) + analyticsTag(websiteId) + '\n' + html.slice(at);
}
