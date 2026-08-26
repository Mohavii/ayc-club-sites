// vercel.cjs
//
// Vercel evaluates this configuration before it packages filesystem API
// routes. The same Git repository is imported by multiple projects, so the
// selected project must allowlist its function entrypoints here rather than
// deleting other routes from npm's build command.

const { TARGETS, getDeployTarget } = require("./scripts/deployment-targets");

const target = getDeployTarget();
if (!target) {
  throw new Error(
    "Missing DEPLOY_TARGET (or deploy_target). Set it to one of: " +
      Object.keys(TARGETS).join(", ")
  );
}
if (!TARGETS[target]) {
  throw new Error(
    `Unknown deployment target "${target}". Valid values: ${Object.keys(TARGETS).join(", ")}`
  );
}

const builds = [
  // Runs package.json#build and publishes the generated public/ directory.
  { src: "package.json", use: "@vercel/static-build", config: { distDir: "public" } },
  ...TARGETS[target].map((src) => ({ src, use: "@vercel/node" })),
];

const edgeRewrites = [
  { source: "/api/auth/:path*", destination: "https://REPLACE-portal-auth.vercel.app/api/auth/:path*" },
  { source: "/api/onboarding/:path*", destination: "https://REPLACE-portal-auth.vercel.app/api/onboarding/:path*" },
  { source: "/api/schools", destination: "https://REPLACE-portal-auth.vercel.app/api/schools" },
  { source: "/api/admin/:path*", destination: "https://REPLACE-portal-admin.vercel.app/api/admin/:path*" },
  { source: "/", destination: "/portal/login.html" },
];

module.exports = {
  builds,
  // Rewrites belong only to portal-edge. If service projects inherit these,
  // their local functions can be shadowed by proxy rules or placeholders.
  ...(target === "portal-edge" ? { rewrites: edgeRewrites } : {}),
};
