// prune-functions.js
//
// Optional local helper for inspecting one deployment target. Production
// Vercel deployments use vercel.cjs to allowlist function entrypoints before
// packaging; they must not delete routes during npm run build.

const fs = require("fs");
const path = require("path");
const { TARGETS, getDeployTarget } = require("./deployment-targets");

function allKnownRoutes() {
  return Object.values(TARGETS).flat();
}

function removeFiles(files) {
  for (const rel of files) {
    const full = path.join(__dirname, "..", rel);
    if (fs.existsSync(full)) {
      fs.rmSync(full);
      console.log(`prune-functions: removed ${rel} (not part of this deployment)`);
    }
  }
}

function removeEmptyDirs(startDirs) {
  const apiRoot = path.join(__dirname, "..", "api");
  for (const rel of startDirs) {
    let dir = path.join(__dirname, "..", rel);
    while (dir.startsWith(apiRoot)) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    }
  }
}

function main() {
  const target = getDeployTarget();
  if (!target) {
    console.log("prune-functions: no deployment target set — keeping all routes (local/dev helper).");
    return;
  }
  if (!TARGETS[target]) {
    console.error(
      `prune-functions: unknown deployment target "${target}". Valid values: ${Object.keys(TARGETS).join(", ")}`
    );
    process.exit(1);
  }

  const keep = new Set(TARGETS[target]);
  const toRemove = allKnownRoutes().filter((route) => !keep.has(route));
  removeFiles(toRemove);
  removeEmptyDirs(toRemove.map((f) => path.dirname(f)));
  console.log(`prune-functions: inspected "${target}" routes only (${keep.size} function(s) kept).`);
}

main();
