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

// type: "update" (single field) | "add" (push to a list) | "remove" (delete from a list) | "create" (whole new club)
async function submitEdit({ clubSlug, submittedBy, submittedByTag, type, path, oldValue, newValue, label }) {
  const edit = {
    editId: randomEditId(),
    clubSlug,
    submittedBy,
    submittedByTag,
    submittedAt: new Date().toISOString(),
    type,
    path,
    oldValue: oldValue === undefined ? null : oldValue,
    newValue,
    label, // human-readable one-liner for the review message
    status: "pending",
  };
  await store.savePendingEdit(edit);
  return edit;
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
  return typeof v === "string" && /^https?:\/\/.*\.(png|jpe?g|webp|gif)(\?|$)/i.test(v);
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
      : edit.type === "add"
      ? `➕ Ajout — **${edit.clubSlug}** / ${edit.label || edit.path}`
      : edit.type === "remove"
      ? `➖ Suppression — **${edit.clubSlug}** / ${edit.label || edit.path}`
      : `✏️ Modification — **${edit.clubSlug}** / ${edit.label || edit.path}`;

  const lines = [
    title,
    `Proposé par <@${edit.submittedBy}>`,
  ];
  if (edit.type === "update") {
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

async function postToReviewChannel(payload) {
  const channelId = process.env.REVIEW_CHANNEL_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!channelId || !botToken) {
    console.error("REVIEW_CHANNEL_ID or DISCORD_BOT_TOKEN missing — cannot post review message.");
    return;
  }
  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

module.exports = { submitEdit, buildReviewMessage, postToReviewChannel, randomEditId };
