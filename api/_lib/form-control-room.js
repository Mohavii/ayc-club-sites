// form-control-room.js
// Powers the interactive "control room" form builder — the /form command
// posts one embed with a dropdown (pick which form) and buttons (add
// question / remove question / toggle / list), and adding a question
// opens a real Discord modal instead of a slash command with many
// options. This is a friendlier alternative to /club form add-field,
// which still exists and still works — this is an additional, easier
// path, not a replacement.

const store = require("./store");
const { checkClubEditPermission } = require("./permissions");
const { submitEdit, buildReviewMessage, postToReviewChannel } = require("./edits");

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
  checkbox_group: "Cases à cocher",
  drive_link: "Lien Google Drive",
};

function ensureForms(club) {
  if (!club.forms) {
    club.forms = {};
    for (const id of FORM_IDS) club.forms[id] = { enabled: false, title: FORM_LABELS[id], fields: [] };
  }
  // Older clubs may be missing a form that was added to the product after
  // they were created — fill in any gaps rather than crash on a lookup.
  for (const id of FORM_IDS) {
    if (!club.forms[id]) club.forms[id] = { enabled: false, title: FORM_LABELS[id], fields: [] };
  }
  return club.forms;
}

// ---------------- the main control-room embed ----------------

// Posted fresh by /form. Shows a dropdown to pick a form; nothing else
// happens until a form is picked (see handleFormSelect below).
function buildFormRootMessage(clubSlug) {
  return {
    embeds: [
      {
        title: "🛠️ Constructeur de formulaires",
        description: "Choisis un formulaire à modifier dans le menu ci-dessous.",
        color: 0x273263,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 3, // string select
            custom_id: `formctl:select:${clubSlug}`,
            placeholder: "Choisir un formulaire...",
            options: FORM_IDS.map((id) => ({ label: FORM_LABELS[id], value: id })),
          },
        ],
      },
    ],
  };
}

// Shown after a form is picked — the actual control panel for that one
// form: current question list + action buttons. Rebuilt and re-shown
// (via UPDATE_MESSAGE) after every action, so it always reflects the
// latest state without ever needing a new message.
function buildFormPanel(club, formId) {
  const forms = ensureForms(club);
  const form = forms[formId];

  const questionLines = form.fields.length
    ? form.fields
        .map((f, i) => {
          const typeLabel = FIELD_TYPE_LABELS[f.type] || f.type;
          const reqLabel = f.required ? " *(obligatoire)*" : "";
          const optionsLabel =
            f.type === "checkbox_group" && Array.isArray(f.options)
              ? ` — options : ${f.options.join(", ")} (${f.multiSelect ? "choix multiple" : "choix unique"})`
              : "";
          return `${i + 1}. **${f.label}** — ${typeLabel}${reqLabel}${optionsLabel}`;
        })
        .join("\n")
    : "*Aucune question pour le moment.*";

  return {
    embeds: [
      {
        title: `🛠️ ${FORM_LABELS[formId]}`,
        description: `Statut : ${form.enabled ? "🟢 activé" : "⚪ désactivé"}\n\n**Questions :**\n${questionLines}`,
        color: 0x273263,
        footer: { text: club.name },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Ajouter une question", custom_id: `formctl:addfield:${club.slug}:${formId}` },
          { type: 2, style: 4, label: "Retirer une question", custom_id: `formctl:removefield:${club.slug}:${formId}`, disabled: form.fields.length === 0 },
        ],
      },
      {
        type: 1,
        components: [
          form.enabled
            ? { type: 2, style: 2, label: "Désactiver", custom_id: `formctl:toggle:${club.slug}:${formId}:off` }
            : { type: 2, style: 3, label: "Activer", custom_id: `formctl:toggle:${club.slug}:${formId}:on`, disabled: form.fields.length === 0 },
          { type: 2, style: 2, label: "◀ Retour", custom_id: `formctl:back:${club.slug}` },
        ],
      },
    ],
  };
}

async function requirePermission(clubSlug, interaction) {
  const club = await store.getClub(clubSlug);
  if (!club) return { error: { content: `❌ Club \`${clubSlug}\` introuvable.`, flags: 64 } };
  const perm = checkClubEditPermission(interaction, club);
  if (!perm.allowed) return { error: { content: `❌ ${perm.reason}`, flags: 64 } };
  return { club };
}

// ---------------- /form command entry point ----------------

async function cmdFormRoot(clubSlug, interaction) {
  const { error, club } = await requirePermission(clubSlug, interaction);
  if (error) return { type: 4, data: error };
  const msg = buildFormRootMessage(clubSlug);
  return { type: 4, data: { ...msg, flags: 64 } };
}

// ---------------- button/select-menu handling ----------------

// customId shapes:
//   formctl:select:<slug>                         (dropdown choice arrives in interaction.data.values[0])
//   formctl:back:<slug>
//   formctl:addfield:<slug>:<formId>               -> opens a modal
//   formctl:removefield:<slug>:<formId>            -> opens a select-to-remove menu
//   formctl:removeconfirm:<slug>:<formId>          (select menu submission, value = field id)
//   formctl:toggle:<slug>:<formId>:on|off
//   formctl:typeselect:<slug>:<formId>             (modal follow-up type picker, select menu)
async function handleFormControlComponent(interaction) {
  const parts = interaction.data.custom_id.split(":");
  const [, action, clubSlug, formId, extra] = parts;

  if (action === "addfield") {
    // No permission check here on purpose — showing an empty popup form
    // is harmless, and the check itself (a network round-trip) was
    // pushing modal responses past Discord's strict 3-second window,
    // which modals can't recover from (no deferring possible for them).
    // handleFieldModalSubmit below still fully checks permission before
    // anything is actually written.
    return { type: 9, data: buildAddFieldModal(clubSlug, formId) };
  }

  const { error, club } = await requirePermission(clubSlug, interaction);
  if (error) return { type: 7, data: error };

  if (action === "select") {
    const chosenFormId = interaction.data.values[0];
    return { type: 7, data: buildFormPanel(club, chosenFormId) };
  }

  if (action === "back") {
    return { type: 7, data: { ...buildFormRootMessage(clubSlug), flags: 64 } };
  }

  if (action === "toggle") {
    const enabled = extra === "on";
    const forms = ensureForms(club);
    const form = forms[formId];
    if (enabled && form.fields.length === 0) {
      return { type: 7, data: buildFormPanel(club, formId) }; // no-op, button is already disabled for this case
    }
    forms[formId] = { ...form, enabled };
    await store.saveClub({ ...club, forms }, `${enabled ? "Activation" : "Désactivation"} du formulaire ${formId} — ${clubSlug}`);
    const freshClub = await store.getClub(clubSlug);
    return { type: 7, data: buildFormPanel(freshClub, formId) };
  }

  if (action === "removefield") {
    const forms = ensureForms(club);
    const form = forms[formId];
    return {
      type: 7,
      data: {
        embeds: [{ title: `Retirer une question — ${FORM_LABELS[formId]}`, color: 0x273263 }],
        components: [
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: `formctl:removeconfirm:${clubSlug}:${formId}`,
                placeholder: "Choisir la question à retirer...",
                options: form.fields.slice(0, 25).map((f) => ({ label: f.label.slice(0, 100), value: f.id })),
              },
            ],
          },
        ],
      },
    };
  }

  if (action === "removeconfirm") {
    const fieldId = interaction.data.values[0];
    const forms = ensureForms(club);
    const form = forms[formId];
    const target = form.fields.find((f) => f.id === fieldId);
    if (!target) return { type: 7, data: buildFormPanel(club, formId) };

    const userId = interaction.member?.user?.id || interaction.user?.id;
    const userTag = interaction.member?.user?.username || "inconnu";
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
    return {
      type: 7,
      data: {
        embeds: [{ title: "✅ Envoyé en révision", description: `Retrait de "${target.label}" en attente d'approbation.`, color: 0x22c55e }],
        components: [],
      },
    };
  }

  return { type: 7, data: { content: "Action inconnue.", components: [] } };
}

// ---------------- modals ----------------

function buildAddFieldModal(clubSlug, formId) {
  return {
    // custom_id carries clubSlug+formId through to the submit handler,
    // since modals don't have easy access back to the triggering message.
    custom_id: `formctl:submitfield:${clubSlug}:${formId}`,
    title: `Nouvelle question — ${FORM_LABELS[formId]}`.slice(0, 45),
    components: [
      {
        type: 1,
        components: [{ type: 4, custom_id: "label", style: 1, label: "Texte de la question", required: true, max_length: 200 }],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "type",
            style: 1,
            label: "Type de question",
            placeholder: "short_text / date / checkbox_group / drive_link",
            required: true,
            max_length: 20,
          },
        ],
      },
      {
        type: 1,
        components: [{ type: 4, custom_id: "required", style: 1, label: "Obligatoire ? (oui / non)", required: true, max_length: 4 }],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "checkbox_options",
            style: 2,
            label: "Options (séparées par des virgules)",
            required: false,
            max_length: 500,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "checkbox_mode",
            style: 1,
            label: "Si cases à cocher : unique ou multiple ?",
            required: false,
            max_length: 10,
          },
        ],
      },
    ],
  };
}

function getModalValue(interaction, customId) {
  for (const row of interaction.data.components) {
    for (const comp of row.components) {
      if (comp.custom_id === customId) return comp.value;
    }
  }
  return undefined;
}

const VALID_TYPES = ["short_text", "date", "checkbox_group", "drive_link"];

async function handleFieldModalSubmit(interaction) {
  const [, , clubSlug, formId] = interaction.data.custom_id.split(":");
  const { error, club } = await requirePermission(clubSlug, interaction);
  if (error) return { type: 4, data: error };

  const label = (getModalValue(interaction, "label") || "").trim();
  const typeRaw = (getModalValue(interaction, "type") || "").trim().toLowerCase();
  const requiredRaw = (getModalValue(interaction, "required") || "").trim().toLowerCase();
  const checkboxOptionsRaw = (getModalValue(interaction, "checkbox_options") || "").trim();
  const checkboxModeRaw = (getModalValue(interaction, "checkbox_mode") || "").trim().toLowerCase();

  if (!VALID_TYPES.includes(typeRaw)) {
    return {
      type: 4,
      data: { content: `❌ Type invalide : "${typeRaw}". Utilise l'un de : ${VALID_TYPES.join(", ")}.`, flags: 64 },
    };
  }
  const required = requiredRaw === "oui" || requiredRaw === "yes" || requiredRaw === "true";

  const newField = {
    id: "fld_" + Math.random().toString(36).slice(2, 8),
    type: typeRaw,
    label,
    required,
  };

  if (typeRaw === "checkbox_group") {
    const options = checkboxOptionsRaw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (options.length < 2) {
      return {
        type: 4,
        data: { content: "❌ Pour des cases à cocher, indique au moins 2 options séparées par des virgules.", flags: 64 },
      };
    }
    newField.options = options;
    newField.multiSelect = checkboxModeRaw === "multiple" || checkboxModeRaw === "multi";
  }

  const forms = ensureForms(club);
  const form = forms[formId];
  const updatedForm = { ...form, fields: [...form.fields, newField] };

  const userId = interaction.member?.user?.id || interaction.user?.id;
  const userTag = interaction.member?.user?.username || "inconnu";
  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: `forms.${formId}`,
    oldValue: form,
    newValue: updatedForm,
    label: `Nouvelle question (${FORM_LABELS[formId]}) : "${label}" [${FIELD_TYPE_LABELS[typeRaw] || typeRaw}]`,
  });
  await postToReviewChannel(buildReviewMessage(edit));

  return {
    type: 4,
    data: {
      embeds: [{ title: "✅ Envoyé en révision", description: `Question "${label}" en attente d'approbation.`, color: 0x22c55e }],
      flags: 64,
    },
  };
}

module.exports = {
  cmdFormRoot,
  handleFormControlComponent,
  handleFieldModalSubmit,
  FORM_IDS,
  FORM_LABELS,
};
