// middleware.js
//
// Vercel Edge Middleware, runs on every request before routing/rewrites.
//
// This repo is imported by several Vercel projects (see
// scripts/deployment-targets.js / PORTAL-SETUP.md). Only the
// `portal-edge` project owns the real internal domain
// (internes.associationyouthclubs.org) and must NEVER serve anything
// other than the member portal — no public marketing pages, even though
// they physically ship in the same `public/` static-build output.
//
// Every other DEPLOY_TARGET (local, bot, portal-auth, portal-admin, ...)
// is untouched by this file: local dev needs the full public/ tree
// reachable, and the service projects don't serve static pages at all.

export const config = {
  // Run on every path so we can allowlist, rather than trying to list
  // every externe page (new pages must "opt in" to being blocked, not
  // the other way around).
  matcher: "/:path*",
};

const ALLOWED_PREFIXES = ["/portal", "/api"];

// Static assets the portal pages themselves depend on (icons, fonts,
// shared images referenced with a root-relative /assets/... path).
// Keep this narrow — the goal is "portal works", not "everything works".
const ALLOWED_EXTRA_EXACT = new Set(["/favicon.ico"]);
const ALLOWED_EXTRA_PREFIXES = ["/assets"];

function isAllowed(pathname) {
  if (pathname === "/") return false; // handled by the /portal/login rewrite/redirect
  if (ALLOWED_EXTRA_EXACT.has(pathname)) return true;
  return [...ALLOWED_PREFIXES, ...ALLOWED_EXTRA_PREFIXES].some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );
}

export default function middleware(request) {
  const target = (process.env.DEPLOY_TARGET ?? process.env.deploy_target ?? "").trim();

  // Only the internes-facing deployment is locked down. Everything else
  // (local dev, bot, service projects) passes through unmodified.
  if (target !== "portal-auth") {
    return;
  }

  const { pathname } = new URL(request.url);

  if (isAllowed(pathname)) {
    return;
  }

  // Anything outside /portal (and the /api proxies /portal pages call) is
  // out of bounds on this domain — send visitors to the portal home page.
  return Response.redirect(new URL("/portal/home", request.url), 302);
}
