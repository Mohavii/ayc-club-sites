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
const { waitUntil } = require("@vercel/functions");
const formControlRoom = require("./_lib/form-control-room");
const controlPanel = require("./_lib/control-panel");

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, APPLICATION_COMMAND_AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 };
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
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

    if (interaction.type === InteractionType.MODAL_SUBMIT) {
      const result = await handleModalSubmit(interaction);
      res.status(200).json(result);
      return;
    }

    res.status(400).send("Unhandled interaction type");
  } catch (err) {
    console.error(err);
    res.status(200).json(ephemeral(`❌ Une erreur est survenue : ${err.message}`));
  }
};

// ---------------- autocomplete (club: <autocomplete>, and item pickers) ----------------

async function handleAutocomplete(interaction) {
  const data = interaction.data;
  const top = data.options && data.options[0];
  // "top" is only a subcommand/group wrapper if its type says so (1 or 2).
  // A flat command like /form has its real options directly on data.options
  // instead — top would actually BE one of those options (e.g. type 3 for
  // a string), not a subcommand wrapper, so treat that case as "no group,
  // no subcommand, options are data.options itself."
  const topIsSubcommandLayer = top && (top.type === 1 || top.type === 2);
  const isGroup = top && top.type === 2;
  const sub = isGroup ? top.options && top.options[0] : null;
  const opts = !topIsSubcommandLayer ? data.options : isGroup ? (sub ? sub.options : []) : top ? top.options : [];

  const focused = findFocusedNested(data.options);
  const focusedName = focused ? focused.name : null;
  const query = (focused?.value || "").toLowerCase();

  const userId = interaction.member?.user?.id || interaction.user?.id;
  const admin = isNationalAdmin(interaction);

  // The "club" field itself — list clubs the person can act on.
  if (focusedName === "club") {
    const memberRoles = interaction.member && interaction.member.roles;
    const hasRole = (c) => Array.isArray(memberRoles) && c.vpcRoleId && memberRoles.includes(c.vpcRoleId);
    const isOfficer = (c) => Array.isArray(c.officers) && c.officers.includes(userId);
    const clubs = await store.listClubs();
    const visible = admin ? clubs : clubs.filter((c) => hasRole(c) || isOfficer(c));
    const choices = visible
      .filter((c) => c.name.toLowerCase().includes(query) || c.slug.includes(query))
      .slice(0, 25)
      .map((c) => ({ name: `${c.name} (${c.slug})`, value: c.slug }));
    return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
  }

  // Item pickers: "event", "member", "partner" — these list the ALREADY
  // selected club's real items by name, so the person picks from a list
  // instead of copy-pasting a raw id out of a JSON file.
  if (["event", "member", "partner"].includes(focusedName)) {
    const clubSlug = getOpt(opts, "club");
    if (!clubSlug) {
      return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } };
    }
    const club = await store.getClub(clubSlug);
    if (!club) {
      return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } };
    }
    const listKey = focusedName === "event" ? "events" : focusedName === "member" ? "bel" : "partners";
    const items = Array.isArray(club[listKey]) ? club[listKey] : [];
    const labelFor = (item) =>
      focusedName === "event"
        ? `${item.title}${item.date ? " — " + item.date : ""}`
        : focusedName === "member"
        ? `${item.name} (${item.role})`
        : item.name;

    const choices = items
      .filter((item) => labelFor(item).toLowerCase().includes(query))
      .slice(0, 25)
      .map((item) => ({ name: labelFor(item).slice(0, 100), value: item.id }));
    return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
  }

  // "field" picker for /club form remove-field — depends on BOTH the
  // already-selected club AND the already-selected form.
  if (focusedName === "field") {
    const clubSlug = getOpt(opts, "club");
    const formId = getOpt(opts, "form");
    if (!clubSlug || !formId) {
      return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } };
    }
    const club = await store.getClub(clubSlug);
    const form = club && club.forms && club.forms[formId];
    const fields = form && Array.isArray(form.fields) ? form.fields : [];
    const choices = fields
      .filter((f) => f.label.toLowerCase().includes(query))
      .slice(0, 25)
      .map((f) => ({ name: f.label.slice(0, 100), value: f.id }));
    return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
  }

  return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } };
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
  if (group === "bel" && (action === "add" || action === "set-photo")) return true;
  if (group === "partner" && (action === "add" || action === "set-logo")) return true;
  if (group === "event" && (action === "add" || action === "set-photo")) return true;
  if (group === "set-hero-image") return true;
  if (group === "set-logo") return true;
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

  if (command === "form") {
    const clubSlug = getOpt(data.options, "club");
    const result = await formControlRoom.cmdFormRoot(clubSlug, interaction);
    res.status(200).json(result);
    return;
  }

  if (command === "panel") {
    const clubSlug = getOpt(data.options, "club");
    const result = await controlPanel.cmdPanelRoot(clubSlug, interaction);
    res.status(200).json(result);
    return;
  }

  if (command !== "club") {
    res.status(200).json(ephemeral("Commande inconnue."));
    return;
  }

  if (needsDefer(group, action)) {
    // Ack immediately so Discord doesn't time out (it requires a reply
    // within 3 seconds). The actual upload + write work happens after
    // that, registered via waitUntil so Vercel's runtime guarantees it
    // actually finishes instead of possibly being cut off right after
    // the response is sent.
    res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64 } });

    const backgroundWork = (async () => {
      let finalMessage;
      try {
        if (group === "bel" && action === "add") {
          finalMessage = await cmdBelAdd(opts, userTag, interaction);
        } else if (group === "bel" && action === "set-photo") {
          finalMessage = await cmdBelSetPhoto(opts, userTag, interaction);
        } else if (group === "partner" && action === "add") {
          finalMessage = await cmdPartnerAdd(opts, userTag, interaction);
        } else if (group === "partner" && action === "set-logo") {
          finalMessage = await cmdPartnerSetLogo(opts, userTag, interaction);
        } else if (group === "event" && action === "add") {
          finalMessage = await cmdEventAdd(opts, userTag, interaction);
        } else if (group === "event" && action === "set-photo") {
          finalMessage = await cmdEventSetPhoto(opts, userTag, interaction);
        } else if (group === "set-hero-image") {
          finalMessage = await cmdSetHeroImage(opts, userTag, interaction);
        } else if (group === "set-logo") {
          finalMessage = await cmdSetLogo(opts, userTag, interaction);
        }
      } catch (err) {
        console.error("Background command work failed:", err);
        finalMessage = { content: `❌ Une erreur est survenue : ${err.message}` };
      }
      try {
        await editOriginalResponse(interaction, finalMessage.content);
      } catch (err) {
        console.error("Failed to edit original Discord response:", err);
      }
    })();

    waitUntil(backgroundWork);
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
    case "delete":
      result = await cmdDelete(opts, userTag, interaction);
      break;
    case "set-about":
      result = await cmdSetSimpleField(opts, userTag, interaction, "about", "text", "À propos");
      break;
    case "set-stats":
      result = await cmdSetStats(opts, userTag, interaction);
      break;
    case "remove-hero-image":
      result = await cmdRemoveHeroImage(opts, userTag, interaction);
      break;
    case "publish":
      result = await cmdPublish(opts, userId, userTag);
      break;
    case "event":
      // "add" is handled above via the deferred path
      result =
        action === "remove-photo"
          ? await cmdEventRemovePhoto(opts, userTag, interaction)
          : await cmdEventRemove(opts, userTag, interaction);
      break;
    case "bel":
      // "add" is handled above via the deferred path
      result =
        action === "remove-photo"
          ? await cmdBelRemovePhoto(opts, userTag, interaction)
          : await cmdBelRemove(opts, userTag, interaction);
      break;
    case "partner":
      result =
        action === "remove-logo"
          ? await cmdPartnerRemoveLogo(opts, userTag, interaction)
          : await cmdPartnerRemove(opts, userTag, interaction);
      break;
    case "form":
      if (action === "add-field") result = await cmdFormAddField(opts, userTag, interaction);
      else if (action === "remove-field") result = await cmdFormRemoveField(opts, userTag, interaction);
      else if (action === "toggle") result = await cmdFormToggle(opts, userTag, interaction);
      else if (action === "list") result = await cmdFormList(opts, userId, userTag);
      else result = ephemeral("Sous-commande de formulaire inconnue.");
      break;
    default:
      result = ephemeral("Sous-commande inconnue.");
  }
  res.status(200).json(result);
}

async function requireClubAndPermission(clubSlug, interaction) {
  const club = await store.getClub(clubSlug);
  if (!club) return { error: ephemeral(`❌ Aucun club trouvé avec l'identifiant \`${clubSlug}\`.`) };
  const perm = checkClubEditPermission(interaction, club);
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
    logo: null,
    officers: [userId],
    events: [],
    bel: [],
    partners: [],
    forms: {
      join: { enabled: false, title: "Rejoindre le club", fields: [] },
      team_communication: { enabled: false, title: "Équipe Communication", fields: [] },
      team_logistique: { enabled: false, title: "Équipe Logistique", fields: [] },
      team_sponsoring: { enabled: false, title: "Équipe Sponsoring", fields: [] },
    },
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

async function cmdSetStats(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const members = getOpt(opts, "members");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
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

async function cmdSetSimpleField(opts, userTag, interaction, fieldPath, optName, label) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const value = getOpt(opts, optName);
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
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

async function cmdSetHeroImage(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return { content: error.data.content };

  const attachmentUrl = getAttachmentUrl(interaction.data, opts, "image");
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

async function cmdDelete(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const confirmText = getOpt(opts, "confirm");

  // Deletion is admin-only — a VPC being able to delete their own club's
  // entire page (even after review) is a much bigger foot-gun than any
  // other edit, so this deliberately does NOT use the normal VPC-allowed
  // requireClubAndPermission check.
  if (!isNationalAdmin(interaction)) {
    return ephemeral("❌ Seul·e un·e admin national·e peut supprimer un club.");
  }

  const club = await store.getClub(clubSlug);
  if (!club) return ephemeral(`❌ Aucun club trouvé avec l'identifiant \`${clubSlug}\`.`);

  if (confirmText !== club.name) {
    return ephemeral(
      `❌ Le texte de confirmation ne correspond pas exactement au nom du club. Retape exactement : \`${club.name}\``
    );
  }

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "delete-club",
    path: "*",
    newValue: null,
    label: `Suppression du club "${club.name}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(
    `⚠️ Demande de suppression envoyée en révision pour **${club.name}**. Elle est irréversible une fois approuvée.`
  );
}

async function cmdRemoveHeroImage(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return error;

  if (!club.heroImage) return ephemeral(`ℹ️ **${club.name}** n'a pas d'image d'en-tête à retirer.`);

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: "heroImage",
    oldValue: club.heroImage,
    newValue: null,
    label: "Retrait de l'image d'en-tête",
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Retrait de l'image d'en-tête envoyé en révision pour **${club.name}**.`);
}

async function cmdEventRemovePhoto(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const eventId = getOpt(opts, "event");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return error;

  const evt = (club.events || []).find((e) => e.id === eventId);
  if (!evt) return ephemeral("❌ Événement introuvable.");
  if (!evt.image) return ephemeral("ℹ️ Cet événement n'a pas de photo à retirer.");

  const updatedEvt = { ...evt, image: null };
  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update-item",
    path: "events",
    itemId: eventId,
    oldValue: evt,
    newValue: updatedEvt,
    label: `Retrait de la photo de l'événement "${evt.title}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Retrait de la photo envoyé en révision pour **${club.name}**.`);
}

async function cmdEventSetPhoto(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const eventId = getOpt(opts, "event");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return { content: error.data.content };

  const evt = (club.events || []).find((e) => e.id === eventId);
  if (!evt) return { content: "❌ Événement introuvable." };

  const attachmentUrl = getAttachmentUrl(interaction.data, opts, "photo");
  if (!attachmentUrl) return { content: "❌ Joins une image avec l'option `photo:`." };

  let uploadedUrl;
  try {
    uploadedUrl = await uploadDiscordAttachment(attachmentUrl, { kind: "event", folder: `ayc-clubs/${clubSlug}/events` });
  } catch (err) {
    return { content: `❌ ${err.message}` };
  }

  const updatedEvt = { ...evt, image: uploadedUrl };
  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update-item",
    path: "events",
    itemId: eventId,
    oldValue: evt,
    newValue: updatedEvt,
    label: `Nouvelle photo pour l'événement "${evt.title}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return { content: `✅ Photo envoyée en révision pour **${club.name}**.` };
}

async function cmdBelRemovePhoto(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const memberId = getOpt(opts, "member");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return error;

  const member = (club.bel || []).find((m) => m.id === memberId);
  if (!member) return ephemeral("❌ Membre introuvable.");
  if (!member.photo) return ephemeral("ℹ️ Ce membre n'a pas de photo à retirer.");

  const updatedMember = { ...member, photo: null };
  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update-item",
    path: "bel",
    itemId: memberId,
    oldValue: member,
    newValue: updatedMember,
    label: `Retrait de la photo de "${member.name}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Retrait de la photo envoyé en révision pour **${club.name}**.`);
}

async function cmdBelSetPhoto(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const memberId = getOpt(opts, "member");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return { content: error.data.content };

  const member = (club.bel || []).find((m) => m.id === memberId);
  if (!member) return { content: "❌ Membre introuvable." };

  const attachmentUrl = getAttachmentUrl(interaction.data, opts, "photo");
  if (!attachmentUrl) return { content: "❌ Joins une image avec l'option `photo:`." };

  let uploadedUrl;
  try {
    uploadedUrl = await uploadDiscordAttachment(attachmentUrl, { kind: "bel", folder: `ayc-clubs/${clubSlug}/bel` });
  } catch (err) {
    return { content: `❌ ${err.message}` };
  }

  const updatedMember = { ...member, photo: uploadedUrl };
  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update-item",
    path: "bel",
    itemId: memberId,
    oldValue: member,
    newValue: updatedMember,
    label: `Nouvelle photo pour "${member.name}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return { content: `✅ Photo envoyée en révision pour **${club.name}**.` };
}

async function cmdPartnerRemoveLogo(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const partnerId = getOpt(opts, "partner");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return error;

  const partner = (club.partners || []).find((p) => p.id === partnerId);
  if (!partner) return ephemeral("❌ Partenaire introuvable.");
  if (!partner.logo) return ephemeral("ℹ️ Ce partenaire n'a pas de logo à retirer.");

  const updatedPartner = { ...partner, logo: null };
  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update-item",
    path: "partners",
    itemId: partnerId,
    oldValue: partner,
    newValue: updatedPartner,
    label: `Retrait du logo de "${partner.name}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Retrait du logo envoyé en révision pour **${club.name}**.`);
}

async function cmdPartnerSetLogo(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const partnerId = getOpt(opts, "partner");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return { content: error.data.content };

  const partner = (club.partners || []).find((p) => p.id === partnerId);
  if (!partner) return { content: "❌ Partenaire introuvable." };

  const attachmentUrl = getAttachmentUrl(interaction.data, opts, "logo");
  if (!attachmentUrl) return { content: "❌ Joins une image avec l'option `logo:`." };

  let uploadedUrl;
  try {
    uploadedUrl = await uploadDiscordAttachment(attachmentUrl, { kind: "partner", folder: `ayc-clubs/${clubSlug}/partners` });
  } catch (err) {
    return { content: `❌ ${err.message}` };
  }

  const updatedPartner = { ...partner, logo: uploadedUrl };
  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update-item",
    path: "partners",
    itemId: partnerId,
    oldValue: partner,
    newValue: updatedPartner,
    label: `Nouveau logo pour "${partner.name}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return { content: `✅ Logo envoyé en révision pour **${club.name}**.` };
}

async function cmdSetLogo(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return { content: error.data.content };

  const attachmentUrl = getAttachmentUrl(interaction.data, opts, "image");
  if (!attachmentUrl) return { content: "❌ Joins une image avec l'option `image:`." };

  let uploadedUrl;
  try {
    uploadedUrl = await uploadDiscordAttachment(attachmentUrl, { kind: "partner", folder: `ayc-clubs/${clubSlug}/logo` });
  } catch (err) {
    return { content: `❌ ${err.message}` };
  }

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: "logo",
    oldValue: club.logo,
    newValue: uploadedUrl,
    label: "Logo du club",
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return { content: `✅ Nouveau logo envoyé en révision pour **${club.name}**.` };
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

async function cmdEventAdd(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
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
  if (!item.title) return { content: "❌ Le titre est obligatoire." };

  const attachmentUrl = getAttachmentUrl(interaction.data, opts, "photo");
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

async function cmdEventRemove(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const eventId = getOpt(opts, "event");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
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

async function cmdBelAdd(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return { content: error.data.content };

  const item = {
    id: "bel_" + Math.random().toString(36).slice(2, 8),
    role: getOpt(opts, "role"),
    name: getOpt(opts, "name"),
    description: getOpt(opts, "description"),
    photo: null,
  };
  if (!item.role || !item.name) return { content: "❌ Le rôle et le nom sont obligatoires." };

  const attachmentUrl = getAttachmentUrl(interaction.data, opts, "photo");
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

async function cmdBelRemove(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const memberId = getOpt(opts, "member");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
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

async function cmdPartnerAdd(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return { content: error.data.content };

  const item = {
    id: "ptn_" + Math.random().toString(36).slice(2, 8),
    name: getOpt(opts, "name"),
    description: getOpt(opts, "description"),
    logo: null,
  };
  if (!item.name) return { content: "❌ Le nom du partenaire est obligatoire." };

  const attachmentUrl = getAttachmentUrl(interaction.data, opts, "logo");
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

async function cmdPartnerRemove(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const partnerId = getOpt(opts, "partner");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
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

// ---------------- form builder commands ----------------

const FORM_IDS = ["join", "team_communication", "team_logistique", "team_sponsoring"];
const FORM_LABELS = {
  join: "Rejoindre le club",
  team_communication: "Équipe Communication",
  team_logistique: "Équipe Logistique",
  team_sponsoring: "Équipe Sponsoring",
};
const FIELD_TYPE_LABELS = {
  short_text: "Texte court",
  date: "Date",
  checkbox: "Case à cocher",
  drive_link: "Lien Google Drive",
};

function ensureForms(club) {
  // Defensive: clubs created before the forms feature existed won't have
  // this object yet — fill in a safe empty default rather than crash.
  if (!club.forms) {
    club.forms = {};
    for (const id of FORM_IDS) club.forms[id] = { enabled: false, title: FORM_LABELS[id], fields: [] };
  }
  return club.forms;
}

async function cmdFormAddField(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const formId = getOpt(opts, "form");
  const type = getOpt(opts, "type");
  const label = getOpt(opts, "label");
  const required = getOpt(opts, "required");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return error;

  const forms = ensureForms(club);
  const form = forms[formId];
  if (!form) return ephemeral("❌ Formulaire inconnu.");

  const newField = { id: "fld_" + Math.random().toString(36).slice(2, 8), type, label, required: !!required };
  const updatedForm = { ...form, fields: [...form.fields, newField] };

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: `forms.${formId}`,
    oldValue: form,
    newValue: updatedForm,
    label: `Nouvelle question (${FORM_LABELS[formId]}) : "${label}" [${FIELD_TYPE_LABELS[type] || type}]`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Question envoyée en révision pour **${club.name}** — ${FORM_LABELS[formId]}.`);
}

async function cmdFormRemoveField(opts, userTag, interaction) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const clubSlug = getOpt(opts, "club");
  const formId = getOpt(opts, "form");
  const fieldId = getOpt(opts, "field");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return error;

  const forms = ensureForms(club);
  const form = forms[formId];
  if (!form) return ephemeral("❌ Formulaire inconnu.");

  const target = form.fields.find((f) => f.id === fieldId);
  if (!target) return ephemeral("❌ Question introuvable.");

  const updatedForm = { ...form, fields: form.fields.filter((f) => f.id !== fieldId) };

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: `forms.${formId}`,
    oldValue: form,
    newValue: updatedForm,
    label: `Retrait d'une question (${FORM_LABELS[formId]}) : "${target.label}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Retrait envoyé en révision pour **${club.name}** — ${FORM_LABELS[formId]}.`);
}

// Toggling a form on/off is reversible and low-risk (unlike adding/removing
// questions, which changes what data gets collected), so this applies
// immediately — no review queue — matching "each VPC can enable or
// disable a form" from the brief.
async function cmdFormToggle(opts, userTag, interaction) {
  const clubSlug = getOpt(opts, "club");
  const formId = getOpt(opts, "form");
  const enabled = getOpt(opts, "enabled");
  const { error, club } = await requireClubAndPermission(clubSlug, interaction);
  if (error) return error;

  const forms = ensureForms(club);
  const form = forms[formId];
  if (!form) return ephemeral("❌ Formulaire inconnu.");

  if (form.fields.length === 0 && enabled) {
    return ephemeral(
      `❌ Impossible d'activer **${FORM_LABELS[formId]}** : ce formulaire n'a encore aucune question. Ajoute-en avec \`/club form add-field\` d'abord.`
    );
  }

  const updatedForm = { ...form, enabled: !!enabled };
  const updatedClub = { ...club, forms: { ...forms, [formId]: updatedForm } };
  await store.saveClub(updatedClub, `${enabled ? "Activation" : "Désactivation"} du formulaire ${formId} — ${clubSlug}`);

  return ephemeral(`✅ **${FORM_LABELS[formId]}** est maintenant ${enabled ? "**activé**" : "**désactivé**"} pour **${club.name}**.`);
}

async function cmdFormList(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const club = await store.getClub(clubSlug);
  if (!club) return ephemeral(`❌ Aucun club trouvé avec l'identifiant \`${clubSlug}\`.`);

  const forms = ensureForms(club);
  const lines = [`**Formulaires — ${club.name}**`];
  for (const id of FORM_IDS) {
    const form = forms[id];
    lines.push(`\n**${FORM_LABELS[id]}** — ${form.enabled ? "🟢 activé" : "⚪ désactivé"} (${form.fields.length} question${form.fields.length === 1 ? "" : "s"})`);
    for (const f of form.fields) {
      lines.push(`• ${f.label} — ${FIELD_TYPE_LABELS[f.type] || f.type}${f.required ? " (obligatoire)" : ""}`);
    }
  }
  return ephemeral(lines.join("\n"));
}

async function handleComponent(interaction) {
  const customId = interaction.data.custom_id; // "approve:<slug>:<editId>" | "reject:<slug>:<editId>" | "formctl:..."

  if (customId.startsWith("formctl:")) {
    return formControlRoom.handleFormControlComponent(interaction);
  }

  if (customId.startsWith("panel:")) {
    return controlPanel.handlePanelComponent(interaction);
  }

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
    const clubLabel = club ? `**${club.name}**` : `\`${clubSlug}\` (club supprimé)`;
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content: `✅ **Approuvé** par <@${reviewerId}>\n${edit.label || edit.path} — ${clubLabel}\n\n_Le site se met à jour automatiquement (1 à 2 minutes)._`,
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

// ---------------- modal submissions ----------------

async function handleModalSubmit(interaction) {
  const customId = interaction.data.custom_id; // "formctl:submitfield:<slug>:<formId>" | "panel:submitadd:..." | "panel:submitinfo:..."
  if (customId.startsWith("formctl:submitfield:")) {
    return formControlRoom.handleFieldModalSubmit(interaction);
  }
  if (customId.startsWith("panel:")) {
    return controlPanel.handlePanelModalSubmit(interaction);
  }
  return ephemeral("Formulaire inconnu.");
}
