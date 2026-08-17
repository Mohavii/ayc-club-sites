// api/interactions.js
// This is the single endpoint Discord calls for every slash command and
// every button click, once you set your app's "Interactions Endpoint URL"
// to https://<your-vercel-project>.vercel.app/api/interactions
//
// Deployed on Vercel, this file becomes a serverless function — no
// always-on process needed, matching the "serverless, don't babysit a
// server" hosting decision.

const { verifyKey } = require("discord-interactions");
const store = require("./_lib/store");
const { checkClubEditPermission, isNationalAdmin } = require("./_lib/permissions");
const { submitEdit, buildReviewMessage, postToReviewChannel } = require("./_lib/edits");
const { applyEdit } = require("./_lib/apply-edit");
const { slugify } = require("./_lib/slug");
const { uploadDiscordAttachment } = require("./_lib/images");

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, APPLICATION_COMMAND_AUTOCOMPLETE: 4 };
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
};

// Vercel needs the raw request body (not pre-parsed) to verify Discord's
// signature, so we turn off the default body parser for this route.
module.exports.config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function ephemeral(content) {
  return { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: 64 } };
}

function getOpt(options, name) {
  const opt = (options || []).find((o) => o.name === name);
  return opt ? opt.value : undefined;
}

// Attachment options come back as an attachment ID in the option value —
// the actual file info (including its temporary download URL) lives in
// interaction.data.resolved.attachments, keyed by that ID.
function getAttachmentUrl(interactionData, options, name) {
  const opt = (options || []).find((o) => o.name === name);
  if (!opt) return null;
  const attachmentId = opt.value;
  const attachment = interactionData.resolved?.attachments?.[attachmentId];
  return attachment ? attachment.url : null;
}

// Edits the bot's original "thinking..." reply once a deferred command
// (one involving an image upload) finishes its background work.
async function editOriginalResponse(interaction, content) {
  const appId = process.env.DISCORD_APP_ID;
  const url = `https://discord.com/api/v10/webhooks/${appId}/${interaction.token}/messages/@original`;
  await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const isValid = verifyKey(rawBody, signature, timestamp, process.env.DISCORD_PUBLIC_KEY);

  if (!isValid) {
    res.status(401).send("Bad request signature");
    return;
  }

  const interaction = JSON.parse(rawBody.toString("utf8"));

  if (interaction.type === InteractionType.PING) {
    res.status(200).json({ type: InteractionResponseType.PONG });
    return;
  }

  try {
    if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
      const result = await handleAutocomplete(interaction);
      res.status(200).json(result);
      return;
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      await handleCommand(interaction, res);
      return;
    }

    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      const result = await handleComponent(interaction);
      res.status(200).json(result);
      return;
    }

    res.status(400).send("Unhandled interaction type");
  } catch (err) {
    console.error(err);
    res.status(200).json(ephemeral(`❌ Une erreur est survenue : ${err.message}`));
  }
};

// ---------------- autocomplete (club: <autocomplete>) ----------------

async function handleAutocomplete(interaction) {
  const focused = (interaction.data.options || []).find((o) => o.focused) ||
    findFocusedNested(interaction.data.options);
  const query = (focused?.value || "").toLowerCase();

  const userId = interaction.member?.user?.id || interaction.user?.id;
  const admin = isNationalAdmin(interaction);

  const clubs = await store.listClubs();
  const visible = admin ? clubs : clubs.filter((c) => Array.isArray(c.officers) && c.officers.includes(userId));

  const choices = visible
    .filter((c) => c.name.toLowerCase().includes(query) || c.slug.includes(query))
    .slice(0, 25)
    .map((c) => ({ name: `${c.name} (${c.slug})`, value: c.slug }));

  return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
}

function findFocusedNested(options) {
  for (const o of options || []) {
    if (o.focused) return o;
    if (o.options) {
      const nested = findFocusedNested(o.options);
      if (nested) return nested;
    }
  }
  return null;
}

// Which (group, action) pairs involve a possible image attachment, and
// therefore need to ack with "thinking..." immediately (Discord requires
// a reply within 3 seconds) before doing the slower upload + write work.
function needsDefer(group, action) {
  if (group === "bel" && action === "add") return true;
  if (group === "partner" && action === "add") return true;
  if (group === "event" && action === "add") return true;
  if (group === "set-hero-image") return true;
  return false;
}

async function handleCommand(interaction, res) {
  const data = interaction.data;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const userTag = interaction.member?.user?.username || interaction.user?.username || "inconnu";

  // Discord sends two different shapes depending on whether "club" has a
  // plain subcommand (type 1, e.g. /club create) or a subcommand GROUP
  // (type 2, e.g. /club event add):
  //   plain subcommand:  options[0] = { name: "create", type: 1, options: [...args] }
  //   subcommand group:  options[0] = { name: "event", type: 2, options: [
  //                         { name: "add", type: 1, options: [...args] }
  //                       ]}
  // top.type tells us which shape we're in — type 2 means top's own
  // "options" are actually a nested subcommand, not arguments.
  const top = data.options && data.options[0];
  const isGroup = top && top.type === 2;
  const sub = isGroup ? top.options && top.options[0] : null;

  const command = data.name; // "club"
  const group = top ? top.name : null; // "event" | "bel" | "partner" | "create" | "set-about" | ...
  const action = sub ? sub.name : null; // "add" | "remove" (only for grouped subcommands)
  const opts = isGroup ? (sub ? sub.options : []) : top ? top.options : [];

  if (command !== "club") {
    res.status(200).json(ephemeral("Commande inconnue."));
    return;
  }

  if (needsDefer(group, action)) {
    // Ack immediately so Discord doesn't time out, then keep working in
    // this same function invocation — Vercel keeps a serverless function
    // alive until it actually returns, so this is safe.
    res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64 } });

    let finalMessage;
    try {
      if (group === "bel" && action === "add") {
        finalMessage = await cmdBelAdd(opts, userId, userTag, data);
      } else if (group === "partner" && action === "add") {
        finalMessage = await cmdPartnerAdd(opts, userId, userTag, data);
      } else if (group === "event" && action === "add") {
        finalMessage = await cmdEventAdd(opts, userId, userTag, data);
      } else if (group === "set-hero-image") {
        finalMessage = await cmdSetHeroImage(opts, userId, userTag, data);
      }
    } catch (err) {
      console.error(err);
      finalMessage = { content: `❌ Une erreur est survenue : ${err.message}` };
    }
    await editOriginalResponse(interaction, finalMessage.content);
    return;
  }

  let result;
  switch (group) {
    case "create":
      result = await cmdCreate(opts, userId, userTag);
      break;
    case "list":
      result = await cmdList();
      break;
    case "set-about":
      result = await cmdSetSimpleField(opts, userId, userTag, "about", "text", "À propos");
      break;
    case "set-stats":
      result = await cmdSetStats(opts, userId, userTag);
      break;
    case "publish":
      result = await cmdPublish(opts, userId, userTag);
      break;
    case "event":
      // "add" is handled above via the deferred path; only "remove" reaches here
      result = await cmdEventRemove(opts, userId, userTag);
      break;
    case "bel":
      // "add" is handled above via the deferred path; only "remove" reaches here
      result = await cmdBelRemove(opts, userId, userTag);
      break;
    case "partner":
      result = await cmdPartnerRemove(opts, userId, userTag);
      break;
    default:
      result = ephemeral("Sous-commande inconnue.");
  }
  res.status(200).json(result);
}

async function requireClubAndPermission(interaction_userId, clubSlug, interactionForRoleCheck) {
  const club = await store.getClub(clubSlug);
  if (!club) return { error: ephemeral(`❌ Aucun club trouvé avec l'identifiant \`${clubSlug}\`.`) };
  const perm = checkClubEditPermission(interactionForRoleCheck, club);
  if (!perm.allowed) return { error: ephemeral(`❌ ${perm.reason}`) };
  return { club, isAdmin: perm.isAdmin };
}

// /club create name school city founded
async function cmdCreate(opts, userId, userTag) {
  const name = getOpt(opts, "name");
  const school = getOpt(opts, "school");
  const city = getOpt(opts, "city");
  const founded = getOpt(opts, "founded");
  if (!name || !city) return ephemeral("❌ Le nom et la ville sont obligatoires.");

  const slug = slugify(school || name);
  const existing = await store.getClub(slug);
  if (existing) return ephemeral(`❌ Un club existe déjà avec l'identifiant \`${slug}\`. Choisis un autre nom ou contacte un·e admin.`);

  const newClub = {
    slug,
    status: "draft",
    name,
    city,
    founded: founded ? Number(founded) : null,
    memberCount: 0,
    about: "",
    heroImage: null,
    officers: [userId],
    events: [],
    bel: [],
    partners: [],
  };

  const edit = await submitEdit({
    clubSlug: slug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "create",
    path: "*",
    newValue: newClub,
    label: `création du club "${name}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));

  return ephemeral(
    `✅ Demande de création envoyée pour **${name}** (identifiant : \`${slug}\`).\nElle attend l'approbation d'un·e admin national·e — la page ne sera visible qu'après \`/club publish\`.`
  );
}

async function cmdList() {
  const clubs = await store.listClubs();
  if (!clubs.length) return ephemeral("Aucun club enregistré pour le moment.");
  const lines = clubs.map((c) => `• **${c.name}** — \`${c.slug}\` — ${c.status === "live" ? "🟢 en ligne" : "🟡 brouillon"}`);
  return ephemeral(lines.join("\n"));
}

async function cmdSetStats(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const members = getOpt(opts, "members");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;
  if (members === undefined) return ephemeral("❌ Précise le nombre de membres avec `members:`.");

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: "memberCount",
    oldValue: club.memberCount,
    newValue: Number(members),
    label: "Nombre de membres actifs",
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Modification envoyée en révision pour **${club.name}**.`);
}

async function cmdSetSimpleField(opts, userId, userTag, fieldPath, optName, label) {
  const clubSlug = getOpt(opts, "club");
  const value = getOpt(opts, optName);
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;
  if (value === undefined) return ephemeral("❌ Le champ texte est obligatoire.");

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: fieldPath,
    oldValue: club[fieldPath],
    newValue: value,
    label,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Modification envoyée en révision pour **${club.name}**.`);
}

async function cmdSetHeroImage(opts, userId, userTag, interactionData) {
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return { content: error.data.content };

  const attachmentUrl = getAttachmentUrl(interactionData, opts, "image");
  if (!attachmentUrl) return { content: "❌ Joins une image avec l'option `image:`." };

  let uploadedUrl;
  try {
    uploadedUrl = await uploadDiscordAttachment(attachmentUrl, { kind: "hero", folder: `ayc-clubs/${clubSlug}/hero` });
  } catch (err) {
    return { content: `❌ ${err.message}` };
  }

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: "heroImage",
    oldValue: club.heroImage,
    newValue: uploadedUrl,
    label: "Image d'en-tête du club",
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return { content: `✅ Nouvelle image d'en-tête envoyée en révision pour **${club.name}**.` };
}

async function cmdPublish(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const club = await store.getClub(clubSlug);
  if (!club) return ephemeral(`❌ Aucun club (brouillon en attente ou publié) trouvé avec \`${clubSlug}\`. Si tu viens de faire \`/club create\`, attends d'abord l'approbation admin.`);
  if (club.status === "live") return ephemeral(`ℹ️ **${club.name}** est déjà en ligne.`);
  return ephemeral(
    `ℹ️ **${club.name}** est encore en brouillon en attente d'approbation. Un·e admin national·e doit approuver la création avant publication — vérifie le salon de révision.`
  );
}

async function cmdEventAdd(opts, userId, userTag, interactionData) {
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return { content: error.data.content };

  const item = {
    id: "evt_" + Math.random().toString(36).slice(2, 8),
    title: getOpt(opts, "title"),
    date: getOpt(opts, "date"),
    location: getOpt(opts, "location"),
    description: getOpt(opts, "description"),
    axis: getOpt(opts, "axis"),
    image: null,
  };
  if (!item.title || !item.date) return { content: "❌ Le titre et la date sont obligatoires." };

  const attachmentUrl = getAttachmentUrl(interactionData, opts, "photo");
  if (attachmentUrl) {
    try {
      item.image = await uploadDiscordAttachment(attachmentUrl, { kind: "event", folder: `ayc-clubs/${clubSlug}/events` });
    } catch (err) {
      return { content: `❌ ${err.message}` };
    }
  }

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "add",
    path: "events",
    newValue: item,
    label: `Nouvel événement : ${item.title}`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return { content: `✅ Événement envoyé en révision pour **${club.name}**${item.image ? " (avec photo)" : ""}.` };
}

async function cmdEventRemove(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const eventId = getOpt(opts, "event");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "remove",
    path: "events",
    newValue: eventId,
    label: `Suppression d'un événement (id: ${eventId})`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Suppression envoyée en révision pour **${club.name}**.`);
}

async function cmdBelAdd(opts, userId, userTag, interactionData) {
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return { content: error.data.content };

  const item = {
    id: "bel_" + Math.random().toString(36).slice(2, 8),
    role: getOpt(opts, "role"),
    name: getOpt(opts, "name"),
    description: getOpt(opts, "description"),
    photo: null,
  };
  if (!item.role || !item.name) return { content: "❌ Le rôle et le nom sont obligatoires." };

  const attachmentUrl = getAttachmentUrl(interactionData, opts, "photo");
  if (attachmentUrl) {
    try {
      item.photo = await uploadDiscordAttachment(attachmentUrl, { kind: "bel", folder: `ayc-clubs/${clubSlug}/bel` });
    } catch (err) {
      return { content: `❌ ${err.message}` };
    }
  }

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "add",
    path: "bel",
    newValue: item,
    label: `Nouveau membre BEL : ${item.name} (${item.role})`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return { content: `✅ Membre BEL envoyé en révision pour **${club.name}**${item.photo ? " (avec photo)" : ""}.` };
}

async function cmdBelRemove(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const memberId = getOpt(opts, "member");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "remove",
    path: "bel",
    newValue: memberId,
    label: `Suppression d'un membre BEL (id: ${memberId})`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Suppression envoyée en révision pour **${club.name}**.`);
}

async function cmdPartnerAdd(opts, userId, userTag, interactionData) {
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return { content: error.data.content };

  const item = {
    id: "ptn_" + Math.random().toString(36).slice(2, 8),
    name: getOpt(opts, "name"),
    description: getOpt(opts, "description"),
    logo: null,
  };
  if (!item.name) return { content: "❌ Le nom du partenaire est obligatoire." };

  const attachmentUrl = getAttachmentUrl(interactionData, opts, "logo");
  if (attachmentUrl) {
    try {
      item.logo = await uploadDiscordAttachment(attachmentUrl, { kind: "partner", folder: `ayc-clubs/${clubSlug}/partners` });
    } catch (err) {
      return { content: `❌ ${err.message}` };
    }
  }

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "add",
    path: "partners",
    newValue: item,
    label: `Nouveau partenaire : ${item.name}`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return { content: `✅ Partenaire envoyé en révision pour **${club.name}**${item.logo ? " (avec logo)" : ""}.` };
}

async function cmdPartnerRemove(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const partnerId = getOpt(opts, "partner");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "remove",
    path: "partners",
    newValue: partnerId,
    label: `Suppression d'un partenaire (id: ${partnerId})`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Suppression envoyée en révision pour **${club.name}**.`);
}

// ---------------- button clicks (Approve / Reject) ----------------

async function handleComponent(interaction) {
  const customId = interaction.data.custom_id; // "approve:<slug>:<editId>" | "reject:<slug>:<editId>"
  const [action, clubSlug, editId] = customId.split(":");

  if (!isNationalAdmin(interaction)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Seul·e un·e admin national·e peut approuver ou rejeter une modification.", flags: 64 },
    };
  }

  const { data: edit, sha } = await store.getPendingEdit(clubSlug, editId);
  if (!edit) {
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: "⚠️ Cette modification n'existe plus (déjà traitée ?).", components: [] },
    };
  }

  const reviewerId = interaction.member?.user?.id || interaction.user?.id;

  if (action === "approve") {
    const club = await applyEdit(edit);
    await store.deletePendingEdit(clubSlug, editId, sha, `approved by ${reviewerId}`);
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content: `✅ **Approuvé** par <@${reviewerId}>\n${edit.label || edit.path} — **${club.name}**\n\n_Le site se met à jour automatiquement (1 à 2 minutes)._`,
        components: [],
      },
    };
  }

  if (action === "reject") {
    await store.deletePendingEdit(clubSlug, editId, sha, `rejected by ${reviewerId}`);
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content: `❌ **Rejeté** par <@${reviewerId}>\n${edit.label || edit.path} — proposé par <@${edit.submittedBy}>`,
        components: [],
      },
    };
  }

  return ephemeral("Action inconnue.");
}
