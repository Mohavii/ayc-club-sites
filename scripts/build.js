// build.js
// Reads every club JSON file in /data/clubs, and (for clubs marked "live")
// writes /public/clubs/<slug>/index.html using render-club.js.
//
// This is run automatically by GitHub Actions every time data changes
// (see .github/workflows/build-and-deploy.yml). It can also be run by
// hand locally with: node scripts/build.js

const fs = require("fs");
const path = require("path");
const { renderClubPage } = require("./render-club");

const CLUBS_DIR = path.join(__dirname, "..", "data", "clubs");
const OUTPUT_DIR = path.join(__dirname, "..", "public", "clubs");

function main() {
  if (!fs.existsSync(CLUBS_DIR)) {
    console.log("No data/clubs directory found — nothing to build.");
    return;
  }

  const files = fs.readdirSync(CLUBS_DIR).filter((f) => f.endsWith(".json"));
  let built = 0;
  let skipped = 0;

  for (const file of files) {
    const filePath = path.join(CLUBS_DIR, file);
    let club;
    try {
      club = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      console.error(`Skipping ${file}: invalid JSON (${err.message})`);
      skipped++;
      continue;
    }

    if (!club.slug) {
      console.error(`Skipping ${file}: missing "slug" field`);
      skipped++;
      continue;
    }

    if (club.status !== "live") {
      // Draft clubs (not yet published via /club publish) don't get a
      // public page yet — this is the safety net from the brief: a
      // half-filled-in club can never accidentally go live.
      skipped++;
      continue;
    }

    const html = renderClubPage(club);
    const outDir = path.join(OUTPUT_DIR, club.slug);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");
    built++;
    console.log(`Built: /clubs/${club.slug}/`);
  }

  console.log(`\nDone. ${built} club page(s) built, ${skipped} skipped (draft or invalid).`);
}

main();
