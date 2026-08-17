// build.js
// Reads every club JSON file in /data/clubs, and (for clubs marked "live")
// writes /public/clubs/<slug>/index.html using render-club.js.
//
// This is run automatically by GitHub Actions every time data changes
// (see .github/workflows/build-and-deploy.yml). It can also be run by
// hand locally with: node scripts/build.js

const fs = require("fs");
const path = require("path");
const { renderClubPage, renderSchoolCard } = require("./render-club");

const CLUBS_DIR = path.join(__dirname, "..", "data", "clubs");
const OUTPUT_DIR = path.join(__dirname, "..", "public", "clubs");
const REJOINDRE_FILE = path.join(__dirname, "..", "public", "rejoindre.html");

function main() {
  if (!fs.existsSync(CLUBS_DIR)) {
    console.log("No data/clubs directory found — nothing to build.");
    return;
  }

  const files = fs.readdirSync(CLUBS_DIR).filter((f) => f.endsWith(".json"));
  let built = 0;
  let skipped = 0;
  const liveClubs = [];

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
    liveClubs.push(club);
    console.log(`Built: /clubs/${club.slug}/`);
  }

  updateRejoindrePage(liveClubs);

  console.log(`\nDone. ${built} club page(s) built, ${skipped} skipped (draft or invalid).`);
}

function updateRejoindrePage(liveClubs) {
  if (!fs.existsSync(REJOINDRE_FILE)) {
    console.log("rejoindre.html not found — skipping club directory update.");
    return;
  }

  let html = fs.readFileSync(REJOINDRE_FILE, "utf8");
  const startMarker = "<!-- CLUB_CARDS_START -->";
  const endMarker = "<!-- CLUB_CARDS_END -->";
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.log("Club card markers not found in rejoindre.html — skipping directory update.");
    return;
  }

  // Group by city, alphabetically; within the same city, sort by name so
  // the order stays stable and predictable as more clubs are added.
  const sorted = [...liveClubs].sort((a, b) => {
    const cityCompare = (a.city || "").localeCompare(b.city || "", "fr");
    if (cityCompare !== 0) return cityCompare;
    return (a.name || "").localeCompare(b.name || "", "fr");
  });
  const cardsHtml = sorted.length
    ? sorted.map(renderSchoolCard).join("\n")
    : `      <p class="team-note">Aucun club publié pour le moment.</p>`;

  const before = html.slice(0, startIdx + startMarker.length);
  const after = html.slice(endIdx);
  html = `${before}\n${cardsHtml}\n${after}`;

  fs.writeFileSync(REJOINDRE_FILE, html, "utf8");
  console.log(`Updated rejoindre.html with ${sorted.length} club(s).`);
}

main();
