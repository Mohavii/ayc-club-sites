// control-panel.js
// The main button-driven control panel — posted once in each club's
// #control-room-<slug> channel. Lets a VPC manage events, BEL members,
// and partners entirely through buttons + popup forms (modals), no
// slash-command syntax required. The /club ... commands still work too
// (kept as the power-user backup, per the brief) — this is a second,
// friendlier way to do the same things.
//
// Design note: everything here uses UPDATE_MESSAGE to replace the panel
// in place, and modal submissions reply ephemerally, so the channel
// never fills up with clutter — no message-deletion permission needed.

const store = require("./store");
const { checkClubEditPermission } = require("./permissions");
const { submitEdit, buildReviewMessage, postToReviewChannel } = require("./edits");
const { uploadDiscordAttachment } = require("./images");

const AXIS_CHOICES = ["Citoyenneté", "Santé", "Scolarité", "Éducation formelle", "Vie active"];
const BEL_ROLES = [
  "Président",
  "Trésorier",
  "Secrétaire",
  "Vice-Président Internes",
  "Vice-Président Externes",
  "Vice-Président Communication",
];
// Short forms shown in the modal's placeholder (which has a 100-char
// limit, too tight for the full role names) — accepted as equivalent
// input so what the placeholder suggests actually works when typed.
const BEL_ROLE_ALIASES = {
  "vp int.": "Vice-Président Internes",
  "vp interne": "Vice-Président Internes",
  "vp internes": "Vice-Président Internes",
  "vp ext.": "Vice-Président Externes",
  "vp externe": "Vice-Président Externes",
  "vp externes": "Vice-Président Externes",
  "vp comm.": "Vice-Président Communication",
  "vp communication": "Vice-Président Communication",
};

function normalizeBelRole(input) {
  const trimmed = input.trim();
  if (BEL_ROLES.includes(trimmed)) return trimmed;
  const alias = BEL_ROLE_ALIASES[trimmed.toLowerCase()];
  return alias || null;
}

async function requirePermission(clubSlug, interaction) {
  const club = await store.getClub(clubSlug);
  if (!club) return { error: { content: `❌ Club \`${clubSlug}\` introuvable.`, flags: 64 } };
  const perm = checkClubEditPermission(interaction, club);
  if (!perm.allowed) return { error: { content: `❌ ${perm.reason}`, flags: 64 } };
  return { club };
}

function userInfo(interaction) {
  return {
    userId: interaction.member?.user?.id || interaction.user?.id,
    userTag: interaction.member?.user?.username || interaction.user?.username || "inconnu",
  };
}

// ---------------- root panel ----------------

function buildRootPanel(club) {
  return {
    embeds: [
      {
        title: `🎛️ Panneau de contrôle — ${club.name}`,
        description: "Choisis une section à gérer.",
        color: 0x273263,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Événements", custom_id: `panel:events:${club.slug}` },
          { type: 2, style: 1, label: "BEL", custom_id: `panel:bel:${club.slug}` },
          { type: 2, style: 1, label: "Partenaires", custom_id: `panel:partners:${club.slug}` },
        ],
      },
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Infos du club", custom_id: `panel:info:${club.slug}` },
          { type: 2, style: 2, label: "Formulaires (/form)", custom_id: `panel:noop`, disabled: true },
        ],
      },
    ],
  };
}

async function cmdPanelRoot(clubSlug, interaction) {
  const { error, club } = await requirePermission(clubSlug, interaction);
  if (error) return { type: 4, data: error };
  return { type: 4, data: { ...buildRootPanel(club), flags: 64 } };
}

// ---------------- section sub-panels (events / bel / partners) ----------------

const SECTION_LABELS = { events: "Événements", bel: "BEL", partners: "Partenaires" };

function buildSectionPanel(club, section) {
  const items = club[section] || [];
  const itemLines = items.length
    ? items.map((it, i) => `${i + 1}. ${itemSummary(section, it)}`).join("\n")
    : "*Aucun élément pour le moment.*";

  return {
    embeds: [
      {
        title: `🎛️ ${SECTION_LABELS[section]} — ${club.name}`,
        description: itemLines,
        color: 0x273263,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Ajouter", custom_id: `panel:add:${section}:${club.slug}` },
          { type: 2, style: 4, label: "Retirer", custom_id: `panel:remove:${section}:${club.slug}`, disabled: items.length === 0 },
        ],
      },
      { type: 1, components: [{ type: 2, style: 2, label: "◀ Retour", custom_id: `panel:back:${club.slug}` }] },
    ],
  };
}

function itemSummary(section, item) {
  if (section === "events") return `**${item.title}**${item.date ? " — " + item.date : ""}`;
  if (section === "bel") return `**${item.name}** (${item.role})`;
  if (section === "partners") return `**${item.name}**`;
  return item.id;
}

// ---------------- add modals ----------------

function buildAddModal(section, clubSlug) {
  if (section === "events") {
    return {
      custom_id: `panel:submitadd:events:${clubSlug}`,
      title: "Nouvel événement",
      components: [
        { type: 1, components: [{ type: 4, custom_id: "title", style: 1, label: "Titre", required: true, max_length: 100 }] },
        { type: 1, components: [{ type: 4, custom_id: "date", style: 1, label: "Date (AAAA-MM-JJ) — optionnel", required: false, max_length: 10 }] },
        { type: 1, components: [{ type: 4, custom_id: "location", style: 1, label: "Lieu", required: false, max_length: 100 }] },
        { type: 1, components: [{ type: 4, custom_id: "description", style: 2, label: "Description", required: false, max_length: 500 }] },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "axis",
              style: 1,
              label: "Axe stratégique",
              placeholder: AXIS_CHOICES.join(" / ").slice(0, 100),
              required: false,
              max_length: 30,
            },
          ],
        },
      ],
    };
  }
  if (section === "bel") {
    return {
      custom_id: `panel:submitadd:bel:${clubSlug}`,
      title: "Nouveau membre BEL",
      components: [
        { type: 1, components: [{ type: 4, custom_id: "name", style: 1, label: "Nom complet", required: true, max_length: 100 }] },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "role",
              style: 1,
              label: "Rôle",
              placeholder: "Président / Trésorier / Secrétaire / VP Int. / VP Ext. / VP Comm.",
              required: true,
              max_length: 40,
            },
          ],
        },
        { type: 1, components: [{ type: 4, custom_id: "description", style: 2, label: "Description", required: false, max_length: 300 }] },
      ],
    };
  }
  if (section === "partners") {
    return {
      custom_id: `panel:submitadd:partners:${clubSlug}`,
      title: "Nouveau partenaire",
      components: [
        { type: 1, components: [{ type: 4, custom_id: "name", style: 1, label: "Nom du partenaire", required: true, max_length: 100 }] },
        { type: 1, components: [{ type: 4, custom_id: "description", style: 2, label: "Nature du soutien", required: false, max_length: 300 }] },
      ],
    };
  }
  return null;
}

function getModalValue(interaction, customId) {
  for (const row of interaction.data.components) {
    for (const comp of row.components) {
      if (comp.custom_id === customId) return comp.value;
    }
  }
  return undefined;
}

async function handleAddModalSubmit(section, clubSlug, interaction) {
  const { error, club } = await requirePermission(clubSlug, interaction);
  if (error) return { type: 4, data: error };
  const { userId, userTag } = userInfo(interaction);

  let item, label;
  if (section === "events") {
    const title = (getModalValue(interaction, "title") || "").trim();
    if (!title) return { type: 4, data: { content: "❌ Le titre est obligatoire.", flags: 64 } };
    item = {
      id: "evt_" + Math.random().toString(36).slice(2, 8),
      title,
      date: (getModalValue(interaction, "date") || "").trim() || null,
      location: (getModalValue(interaction, "location") || "").trim(),
      description: (getModalValue(interaction, "description") || "").trim(),
      axis: (getModalValue(interaction, "axis") || "").trim(),
      image: null,
    };
    label = `Nouvel événement : ${item.title}`;
  } else if (section === "bel") {
    const name = (getModalValue(interaction, "name") || "").trim();
    const roleRaw = (getModalValue(interaction, "role") || "").trim();
    if (!name || !roleRaw) return { type: 4, data: { content: "❌ Le nom et le rôle sont obligatoires.", flags: 64 } };
    const role = normalizeBelRole(roleRaw);
    if (!role) {
      return {
        type: 4,
        data: { content: `❌ Rôle invalide. Utilise exactement l'un de : ${BEL_ROLES.join(", ")}.`, flags: 64 },
      };
    }
    item = {
      id: "bel_" + Math.random().toString(36).slice(2, 8),
      name,
      role,
      description: (getModalValue(interaction, "description") || "").trim(),
      photo: null,
    };
    label = `Nouveau membre BEL : ${item.name} (${item.role})`;
  } else if (section === "partners") {
    const name = (getModalValue(interaction, "name") || "").trim();
    if (!name) return { type: 4, data: { content: "❌ Le nom est obligatoire.", flags: 64 } };
    item = {
      id: "ptn_" + Math.random().toString(36).slice(2, 8),
      name,
      description: (getModalValue(interaction, "description") || "").trim(),
      logo: null,
    };
    label = `Nouveau partenaire : ${item.name}`;
  } else {
    return { type: 4, data: { content: "Section inconnue.", flags: 64 } };
  }

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "add",
    path: section,
    newValue: item,
    label,
  });
  await postToReviewChannel(buildReviewMessage(edit));

  return {
    type: 4,
    data: {
      embeds: [{ title: "✅ Envoyé en révision", description: label, color: 0x22c55e }],
      flags: 64,
    },
  };
}

// ---------------- remove flow (select menu) ----------------

function buildRemoveSelect(club, section) {
  const items = club[section] || [];
  return {
    embeds: [{ title: `Retirer — ${SECTION_LABELS[section]}`, color: 0x273263 }],
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `panel:removeconfirm:${section}:${club.slug}`,
            placeholder: "Choisir l'élément à retirer...",
            options: items.slice(0, 25).map((it) => ({ label: itemSummary(section, it).replace(/\*\*/g, "").slice(0, 100), value: it.id })),
          },
        ],
      },
    ],
  };
}

async function handleRemoveConfirm(section, clubSlug, interaction) {
  const { error, club } = await requirePermission(clubSlug, interaction);
  if (error) return { type: 7, data: error };
  const { userId, userTag } = userInfo(interaction);

  const itemId = interaction.data.values[0];
  const items = club[section] || [];
  const target = items.find((it) => it.id === itemId);
  if (!target) return { type: 7, data: buildSectionPanel(club, section) };

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "remove",
    path: section,
    newValue: itemId,
    label: `Suppression — ${SECTION_LABELS[section]} : ${itemSummary(section, target).replace(/\*\*/g, "")}`,
  });
  await postToReviewChannel(buildReviewMessage(edit));

  return {
    type: 7,
    data: {
      embeds: [{ title: "✅ Envoyé en révision", description: edit.label, color: 0x22c55e }],
      components: [],
    },
  };
}

// ---------------- component (button/select) dispatch ----------------

// customId shapes:
//   panel:events|bel|partners|info:<slug>
//   panel:back:<slug>
//   panel:add:<section>:<slug>              -> opens modal
//   panel:remove:<section>:<slug>           -> shows select menu
//   panel:removeconfirm:<section>:<slug>    (select submission)
async function handlePanelComponent(interaction) {
  const parts = interaction.data.custom_id.split(":");
  const action = parts[1];

  if (action === "noop") return { type: 6 }; // deferred update, no-op — disabled button safety net

  if (action === "events" || action === "bel" || action === "partners") {
    const clubSlug = parts[2];
    const { error, club } = await requirePermission(clubSlug, interaction);
    if (error) return { type: 7, data: error };
    return { type: 7, data: buildSectionPanel(club, action) };
  }

  if (action === "back") {
    const clubSlug = parts[2];
    const { error, club } = await requirePermission(clubSlug, interaction);
    if (error) return { type: 7, data: error };
    return { type: 7, data: buildRootPanel(club) };
  }

  if (action === "add") {
    const [, , section, clubSlug] = parts;
    // No permission check here on purpose — showing an empty popup form
    // is harmless, and checking it here (a network round-trip) was
    // pushing modal responses past Discord's strict 3-second window for
    // this specific response type (modals can't be deferred at all).
    // handleAddModalSubmit below still fully checks permission before
    // anything is actually written.
    return { type: 9, data: buildAddModal(section, clubSlug) };
  }

  if (action === "remove") {
    const [, , section, clubSlug] = parts;
    const { error, club } = await requirePermission(clubSlug, interaction);
    if (error) return { type: 7, data: error };
    return { type: 7, data: buildRemoveSelect(club, section) };
  }

  if (action === "removeconfirm") {
    const [, , section, clubSlug] = parts;
    return handleRemoveConfirm(section, clubSlug, interaction);
  }

  if (action === "info") {
    const clubSlug = parts[2];
    const { error, club } = await requirePermission(clubSlug, interaction);
    if (error) return { type: 7, data: error };
    return { type: 7, data: buildInfoPanel(club) };
  }

  if (action === "editfield") {
    const [, , field, clubSlug] = parts;
    // Same reasoning as "add" above — no permission check before showing
    // the modal, to stay well under Discord's strict timing for modals.
    // handleInfoModalSubmit checks permission before writing anything.
    return { type: 9, data: buildInfoModal(field, clubSlug) };
  }

  return { type: 7, data: { content: "Action inconnue.", components: [] } };
}

// ---------------- club info sub-panel (about / stats / logo / hero) ----------------

function buildInfoPanel(club) {
  return {
    embeds: [
      {
        title: `🎛️ Infos du club — ${club.name}`,
        description: `**Membres actifs :** ${club.memberCount ?? "—"}\n**À propos :** ${club.about || "*(vide)*"}`,
        color: 0x273263,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Modifier le nombre de membres", custom_id: `panel:editfield:stats:${club.slug}` },
          { type: 2, style: 1, label: "Modifier le texte À propos", custom_id: `panel:editfield:about:${club.slug}` },
        ],
      },
      { type: 1, components: [{ type: 2, style: 2, label: "◀ Retour", custom_id: `panel:back:${club.slug}` }] },
    ],
  };
}

function buildInfoModal(field, clubSlug) {
  if (field === "stats") {
    return {
      custom_id: `panel:submitinfo:stats:${clubSlug}`,
      title: "Nombre de membres actifs",
      components: [
        { type: 1, components: [{ type: 4, custom_id: "members", style: 1, label: "Nombre de membres", required: true, max_length: 6 }] },
      ],
    };
  }
  if (field === "about") {
    return {
      custom_id: `panel:submitinfo:about:${clubSlug}`,
      title: "Texte À propos",
      components: [
        { type: 1, components: [{ type: 4, custom_id: "about", style: 2, label: "Texte", required: true, max_length: 1000 }] },
      ],
    };
  }
  return null;
}

async function handleInfoModalSubmit(field, clubSlug, interaction) {
  const { error, club } = await requirePermission(clubSlug, interaction);
  if (error) return { type: 4, data: error };
  const { userId, userTag } = userInfo(interaction);

  let path, newValue, label;
  if (field === "stats") {
    const raw = (getModalValue(interaction, "members") || "").trim();
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) {
      return { type: 4, data: { content: "❌ Entre un nombre valide.", flags: 64 } };
    }
    path = "memberCount";
    newValue = num;
    label = "Nombre de membres actifs";
  } else if (field === "about") {
    newValue = (getModalValue(interaction, "about") || "").trim();
    path = "about";
    label = "À propos";
  } else {
    return { type: 4, data: { content: "Champ inconnu.", flags: 64 } };
  }

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path,
    oldValue: club[path],
    newValue,
    label,
  });
  await postToReviewChannel(buildReviewMessage(edit));

  return {
    type: 4,
    data: { embeds: [{ title: "✅ Envoyé en révision", description: label, color: 0x22c55e }], flags: 64 },
  };
}

// ---------------- modal submit dispatch ----------------

async function handlePanelModalSubmit(interaction) {
  const customId = interaction.data.custom_id;
  const parts = customId.split(":");
  if (parts[1] === "submitadd") {
    const [, , section, clubSlug] = parts;
    return handleAddModalSubmit(section, clubSlug, interaction);
  }
  if (parts[1] === "submitinfo") {
    const [, , field, clubSlug] = parts;
    return handleInfoModalSubmit(field, clubSlug, interaction);
  }
  return { type: 4, data: { content: "Formulaire inconnu.", flags: 64 } };
}

module.exports = {
  cmdPanelRoot,
  buildRootPanel,
  handlePanelComponent,
  handlePanelModalSubmit,
};
