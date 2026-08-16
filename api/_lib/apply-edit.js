// apply-edit.js
// Once a national admin clicks "Approve" on a pending edit, this is what
// actually writes the change into the club's live JSON file (which
// commits to GitHub and triggers the site rebuild).

const store = require("./store");

// Simple dot-path setter, e.g. setPath(club, "memberCount", 42)
// or setPath(club, "hero.image", url).
function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

async function applyEdit(edit) {
  if (edit.type === "create") {
    // newValue is the full new club record
    const club = { ...edit.newValue, status: "live" };
    await store.saveClub(club, `Publish new club: ${club.slug} (approved edit ${edit.editId})`);
    return club;
  }

  let club = await store.getClub(edit.clubSlug);
  if (!club) throw new Error(`Club "${edit.clubSlug}" not found — cannot apply edit.`);

  if (edit.type === "update") {
    setPath(club, edit.path, edit.newValue);
  } else if (edit.type === "add") {
    // path is e.g. "events", "bel", "partners" — newValue is the item to push
    if (!Array.isArray(club[edit.path])) club[edit.path] = [];
    club[edit.path].push(edit.newValue);
  } else if (edit.type === "remove") {
    // path is e.g. "events", "bel", "partners" — newValue is the item id to remove
    if (Array.isArray(club[edit.path])) {
      club[edit.path] = club[edit.path].filter((item) => item.id !== edit.newValue);
    }
  } else {
    throw new Error(`Unknown edit type: ${edit.type}`);
  }

  await store.saveClub(club, `Approved edit ${edit.editId}: ${edit.clubSlug} / ${edit.path}`);
  return club;
}

module.exports = { applyEdit, setPath };
