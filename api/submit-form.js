// api/submit-form.js
// Public endpoint that club websites POST to when someone submits a join
// or team-application form. Unlike api/interactions.js, this is NOT a
// Discord endpoint — it's called directly by the public-facing form page
// (see renderFormPage in scripts/render-club.js), so it needs its own
// CORS handling and does not use Discord's signature verification.
//
// Delivery: if the club has a Discord webhook URL configured for this
// form (club.formWebhooks.<formId>), the submission is posted straight
// into that private Discord channel. If not configured yet, the
// submission is still safely saved to data/submissions/... via the
// GitHub API, so nothing is lost — it just isn't in Discord yet.

const store = require("./_lib/store");

function setCorsHeaders(res) {
  // Public form pages are static HTML served from GitHub Pages, a
  // different origin than this API (Vercel) — CORS must allow that.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const FORM_LABELS = {
  join: "Rejoindre le club",
  team_communication: "Équipe Communication",
  team_logistique: "Équipe Logistique",
  team_sponsoring: "Équipe Sponsoring",
};

function formatAnswersForDiscord(club, form, answers) {
  const lines = [`📋 **Nouvelle candidature — ${FORM_LABELS[form.formId] || form.formId}**`, `Club : **${club.name}**`, ""];
  for (const field of form.fields) {
    const raw = answers[field.id];
    let displayValue;
    if (field.type === "checkbox") displayValue = raw ? "✅ Oui" : "❌ Non";
    else if (field.type === "checkbox_group") {
      const selected = Array.isArray(raw) ? raw.filter(Boolean) : raw ? [raw] : [];
      displayValue = selected.length ? selected.join(", ") : "*(vide)*";
    } else if (raw === undefined || raw === null || raw === "") displayValue = "*(vide)*";
    else displayValue = String(raw);
    lines.push(`**${field.label}** : ${displayValue}`);
  }
  return lines.join("\n").slice(0, 1900); // Discord message length safety margin
}

async function postToWebhook(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`Webhook post failed with status ${res.status}`);
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (err) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const { clubSlug, formId, answers } = body || {};
  if (!clubSlug || !formId || !answers || typeof answers !== "object") {
    res.status(400).json({ error: "Missing clubSlug, formId, or answers" });
    return;
  }

  try {
    const club = await store.getClub(clubSlug);
    if (!club) {
      res.status(404).json({ error: "Club introuvable." });
      return;
    }

    const form = club.forms && club.forms[formId];
    if (!form || !form.enabled) {
      res.status(403).json({ error: "Ce formulaire n'est pas ouvert actuellement." });
      return;
    }

    // Validate required fields are actually present (defense against a
    // tampered client-side request bypassing the "required" HTML attribute).
    for (const field of form.fields) {
      if (!field.required) continue;
      const val = answers[field.id];
      const missing =
        field.type === "checkbox"
          ? !val
          : field.type === "checkbox_group"
          ? !(Array.isArray(val) ? val.filter(Boolean).length : val)
          : val === undefined || val === null || String(val).trim() === "";
      if (missing) {
        res.status(400).json({ error: `Le champ "${field.label}" est obligatoire.` });
        return;
      }
    }

    const submissionId = "sub_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const submission = {
      id: submissionId,
      clubSlug,
      formId,
      answers,
      submittedAt: new Date().toISOString(),
    };

    // Always save a durable copy via GitHub — this is the safety net if
    // the webhook isn't configured yet, or if Discord delivery ever fails.
    await store.writeJsonFile(
      `data/submissions/${clubSlug}/${formId}/${submissionId}.json`,
      submission,
      `New form submission: ${clubSlug} / ${formId}`
    );

    // If this club has a webhook configured for this form, deliver it to
    // Discord immediately too. Configured later via the role/channel
    // automation — safe to be absent right now.
    const webhookUrl = club.formWebhooks && club.formWebhooks[formId];
    if (webhookUrl) {
      try {
        await postToWebhook(webhookUrl, formatAnswersForDiscord(club, { ...form, formId }, answers));
      } catch (err) {
        // Don't fail the whole request just because Discord delivery
        // failed — the submission is already safely saved above.
        console.error("Webhook delivery failed:", err);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("submit-form error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
