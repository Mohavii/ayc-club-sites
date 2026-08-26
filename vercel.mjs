// vercel.mjs
//
// Vercel evaluates this configuration before packaging filesystem API routes.
// The same repository is imported by multiple projects, so each project
// selects only its own function entrypoints through DEPLOY_TARGET.

import targetsModule from "./scripts/deployment-targets.js";

const { TARGETS, getDeployTarget } = targetsModule;
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
  { source: "/api/session", destination: "https://REPLACE-portal-auth.vercel.app/api/session" },
  { source: "/api/admin/:path*", destination: "https://REPLACE-portal-admin.vercel.app/api/admin/:path*" },
  { source: "/", destination: "/portal/login.html" },
];

const functionRoutes = TARGETS[target].flatMap((source) => {
  const route = `/${source.slice(0, -3)}`;
  return [
    { src: route, dest: `/${source}` },
    { src: `${route}.js`, dest: `/${source}` },
  ];
});

const config = {
  builds,
  // Legacy builds need explicit routes. Without these, Vercel can package
  // the Lambda outputs successfully but still return NOT_FOUND for the
  // extensionless `/api/...` URLs used by the browser.
  ...(target === "portal-edge"
    ? { rewrites: edgeRewrites }
    : {
        routes: [
          { src: "/", dest: "/portal/login.html" },
          ...functionRoutes,
          { handle: "filesystem" },
        ],
      }),
};

// Vercel accepts either export form; providing both is compatible with the
// current config loader and makes the intended contract explicit.
export { config };
export default config;
