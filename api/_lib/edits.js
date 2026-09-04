// edits.js
// Handles the "submit for review" side of every write command.
//
// Flow:
//  1. A VPC (or admin) runs a command like /club set-stats.
//  2. Instead of writing straight to the club's live file, we create a
//     "pending edit" record and post it to the national-admin review
//     channel as a message with Approve / Reject buttons.
//  3. National admins click Approve or Reject (handled in
//     api/interactions.js under MESSAGE_COMPONENT). Approve commits the
//     change to the club's live file (which triggers the site rebuild).
//
// National admins bypass review for their own actions if they want speed,
// but by default (per the project brief) even admin-submitted edits are
// routed through the same queue for consistency and a full audit trail.
// Set ADMIN_EDITS_SKIP_REVIEW=true in env vars to let admins publish
// instantly instead, if you decide you want that later.

const crypto = require("crypto");
const store = require("./store");

function randomEditId() {
  return "edit_" + crypto.randomBytes(4).toString("hex");
}

// type: "update" (single field) | "add" (push to a list) | "remove" (delete from a list)
//     | "update-item" (replace one item within a list, e.g. clearing just its photo)
//     | "create" (whole new club) | "delete-club" (remove a club entirely)
async function submitEdit({ clubSlug, submittedBy, submittedByTag, type, path, itemId, oldValue, newValue, label }) {
  const edit = {
    editId: randomEditId(),
    clubSlug,
    submittedBy,
    submittedByTag,
    submittedAt: new Date().toISOString(),
    type,
    path,
    itemId: itemId || null,
    oldValue: oldValue === undefined ? null : oldValue,
    newValue,
    label, // human-readable one-liner for the review message
    status: "pending",
    reviewMessageId: null, // filled in after postToReviewChannel — see attachReviewMessageId
  };
  await store.savePendingEdit(edit);
  return edit;
}

// Records which Discord message a pending edit was posted as, so it can
// be looked up and edited in place later (e.g. once an image link is
// added — see the "add image" flow in control-panel.js).
async function attachReviewMessageId(edit, messageId) {
  if (!messageId) return edit;
  const updated = { ...edit, reviewMessageId: messageId };
  await store.savePendingEdit(updated);
  return updated;
}

function formatValue(v) {
  if (v === null || v === undefined || v === "") return "*(vide)*";
  if (isImageUrl(v)) return "*(voir l'aperçu ci-dessous)*";
  if (typeof v === "object") {
    const clone = { ...v };
    if (isImageUrl(clone.photo)) clone.photo = "(voir l'aperçu ci-dessous)";
    if (isImageUrl(clone.logo)) clone.logo = "(voir l'aperçu ci-dessous)";
    if (isImageUrl(clone.image)) clone.image = "(voir l'aperçu ci-dessous)";
    return "```json\n" + JSON.stringify(clone, null, 2) + "\n```";
  }
  return "`" + String(v) + "`";
}

function isImageUrl(v) {
  if (typeof v !== "string") return false;
  if (/^https?:\/\/.*\.(png|jpe?g|webp|gif)(\?|$)/i.test(v)) return true;
  // Google Drive direct-view links (see normalizeDriveImageLink in
  // images.js) don't end in a file extension, so match them explicitly.
  if (/^https:\/\/drive\.google\.com\/uc\?export=view&id=/i.test(v)) return true;
  return false;
}

function findImageUrl(edit) {
  // Looks for an image URL either directly (heroImage update) or nested
  // inside an added item (bel photo / partner logo / event image).
  if (isImageUrl(edit.newValue)) return edit.newValue;
  if (edit.newValue && typeof edit.newValue === "object") {
    if (isImageUrl(edit.newValue.photo)) return edit.newValue.photo;
    if (isImageUrl(edit.newValue.logo)) return edit.newValue.logo;
    if (isImageUrl(edit.newValue.image)) return edit.newValue.image;
  }
  return null;
}

// Builds the Discord message payload (content + buttons) for a pending edit.
function buildReviewMessage(edit) {
  const title =
    edit.type === "create"
      ? `🆕 Nouveau club : **${edit.clubSlug}**`
      : edit.type === "delete-club"
      ? `🗑️ SUPPRESSION DE CLUB — **${edit.clubSlug}** (irréversible)`
      : edit.type === "add"
      ? `➕ Ajout — **${edit.clubSlug}** / ${edit.label || edit.path}`
      : edit.type === "remove"
      ? `➖ Suppression — **${edit.clubSlug}** / ${edit.label || edit.path}`
      : edit.type === "update-item"
      ? `✏️ Modification d'un élément — **${edit.clubSlug}** / ${edit.label || edit.path}`
      : `✏️ Modification — **${edit.clubSlug}** / ${edit.label || edit.path}`;

  const lines = [
    title,
    `Proposé par <@${edit.submittedBy}>`,
  ];
  if (edit.type === "update" || edit.type === "update-item") {
    lines.push(`Avant : ${formatValue(edit.oldValue)}`);
    lines.push(`Après : ${formatValue(edit.newValue)}`);
  } else {
    lines.push(`Contenu : ${formatValue(edit.newValue)}`);
  }

  const imageUrl = findImageUrl(edit);
  const payload = {
    content: lines.join("\n"),
    components: [
      {
        type: 1, // action row
        components: [
          {
            type: 2, // button
            style: 3, // green
            label: "Approuver",
            custom_id: `approve:${edit.clubSlug}:${edit.editId}`,
          },
          {
            type: 2,
            style: 4, // red
            label: "Rejeter",
            custom_id: `reject:${edit.clubSlug}:${edit.editId}`,
          },
        ],
      },
    ],
  };

  if (imageUrl) {
    payload.embeds = [{ image: { url: imageUrl } }];
  }

  return payload;
}

// Returns the posted message (so its id can be saved on the pending edit
// and used later to refresh the embed once an image link is added — see
// updateReviewMessage below), or null if posting wasn't possible/failed.
async function postToReviewChannel(payload) {
  const channelId = process.env.REVIEW_CHANNEL_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!channelId || !botToken) {
    console.error("REVIEW_CHANNEL_ID or DISCORD_BOT_TOKEN missing — cannot post review message.");
    return null;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("postToReviewChannel failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("postToReviewChannel failed:", err.message);
    return null;
  }
}

// Edits an already-posted review message in place — used once someone
// adds an image link after the fact, so the preview embed appears on the
// SAME approve/reject message instead of a confusing duplicate.
async function updateReviewMessage(messageId, payload) {
  const channelId = process.env.REVIEW_CHANNEL_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!channelId || !botToken || !messageId) return;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("updateReviewMessage failed:", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.error("updateReviewMessage failed:", err.message);
  }
}

module.exports = {
  submitEdit,
  buildReviewMessage,
  postToReviewChannel,
  updateReviewMessage,
  attachReviewMessageId,
  randomEditId,
};
