// apply-edit.js
// Once a national admin clicks "Approve" on a pending edit, this is what
// actually writes the change into the club's live JSON file (which
// commits to GitHub and triggers the site rebuild).

const store = require("./store");
const { provisionClubDiscordResources } = require("./discord-provisioning");

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
    // newValue is the full new club record. Discord provisioning (role +
    // private channels + webhooks) happens here, at approval time — not
    // at submission time — matching how nothing else in this system
    // becomes real until an admin approves it.
    const { vpcRoleId, formWebhooks } = await provisionClubDiscordResources(edit.newValue.slug);
    const club = {
      ...edit.newValue,
      status: "live",
      vpcRoleId: vpcRoleId || null,
      formWebhooks: formWebhooks || {},
    };
    await store.saveClub(club, `Publish new club: ${club.slug} (approved edit ${edit.editId})`);
    return club;
  }

  if (edit.type === "delete-club") {
    await store.deleteClub(edit.clubSlug, `Deleted club: ${edit.clubSlug} (approved edit ${edit.editId})`);
    return null; // club no longer exists — caller should not try to read club.name etc.
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
  } else if (edit.type === "update-item") {
    // path is the list name (e.g. "events"), itemId picks which item,
    // newValue is the full replacement item (used for things like
    // "remove just this event's photo" without deleting the event).
    if (Array.isArray(club[edit.path])) {
      club[edit.path] = club[edit.path].map((item) => (item.id === edit.itemId ? edit.newValue : item));
    }
  } else {
    throw new Error(`Unknown edit type: ${edit.type}`);
  }

  await store.saveClub(club, `Approved edit ${edit.editId}: ${edit.clubSlug} / ${edit.path}`);
  return club;
}

module.exports = { applyEdit, setPath };
