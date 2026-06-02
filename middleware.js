// Edge Middleware — host-based routing for the charts.stagelink365.com subdomain,
// plus the clean /calendar/{token}.ics availability-feed URL.
//
// Why this exists (and not a vercel.json rewrite): vercel.json `rewrites` are
// skipped whenever the request path already matches a real file. The request
// path `/` always matches the platform's root `index.html`, so a host-scoped
// rewrite never fired. Middleware runs ahead of the filesystem, so it can route
// the charts host to the proposal page reliably.
//
// Plain Edge runtime — no build step, no package.json, no dependency. We set
// the platform primitives `x-middleware-rewrite` / `x-middleware-next` directly
// (the same headers @vercel/edge's rewrite()/next() set under the hood).

export const config = {
  // Run on everything except the platform's API functions, which must be
  // untouched by this middleware.
  matcher: '/((?!api/).*)',
};

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase();
  const url = new URL(request.url);

  // 1) Charts subdomain → always serve the proposal page (clean URL).
  if (host === 'charts.stagelink365.com') {
    url.pathname = '/charts/index.html';
    return new Response(null, {
      headers: { 'x-middleware-rewrite': url.toString() },
    });
  }

  // 1.5) Clean availability-feed URL: /calendar/{token}.ics → /api/ics?token={token}
  //      (the raw /api/ics?token= path also works; this just gives a tidy,
  //      .ics-suffixed URL calendar apps are happy to subscribe to).
  const icsMatch = url.pathname.match(/^\/calendar\/([A-Za-z0-9]{6,32})\.ics$/);
  if (icsMatch) {
    url.pathname = '/api/ics';
    url.search = `?token=${icsMatch[1]}`;
    return new Response(null, {
      headers: { 'x-middleware-rewrite': url.toString() },
    });
  }

  // 2) Keep the (confidential) Charts page off the production main domains.
  //    Preview hosts (*.vercel.app) are intentionally NOT blocked, so the page
  //    stays viewable at <preview>/charts/ for PR verification.
  if (
    (host === 'stagelink365.com' || host === 'www.stagelink365.com') &&
    url.pathname.startsWith('/charts')
  ) {
    return Response.redirect(new URL('/', request.url), 307);
  }

  // 3) Everything else passes through unchanged.
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
