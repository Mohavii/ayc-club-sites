// api/chat.js
// Public endpoint the website's chat widget calls. Receives a visitor's
// message (and recent conversation history for context), sends it to
// Google's Gemini API along with the association's knowledge base, and
// returns the reply.
//
// This is NOT a Discord endpoint and needs no signature verification —
// it's called directly by public visitors on the website, same shape as
// api/submit-form.js.
//
// Requires one new environment variable in Vercel: GEMINI_API_KEY
// (free — get one at https://aistudio.google.com/apikey).

const { KNOWLEDGE_BASE } = require("./_lib/knowledge-base");

const GEMINI_MODEL = "gemini-2.5-flash"; // stable free-tier model
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_INSTRUCTION = `Tu es l'assistant virtuel officiel de l'Association YOUTH CLUBs (AYCs), une association tunisienne à but non lucratif pour jeunes.

Réponds aux questions UNIQUEMENT à partir des informations fournies ci-dessous. Si une question porte sur quelque chose qui n'est pas couvert par ces informations, dis-le clairement et poliment plutôt que d'inventer une réponse.

Réponds dans la même langue que la question posée (français, arabe, ou anglais). Sois clair, concis et chaleureux — tu représentes une association qui valorise l'honnêteté et l'harmonie. N'invente jamais de chiffres, de noms de personnes, ou de dates qui ne sont pas dans le texte ci-dessous.

--- INFORMATIONS SUR L'ASSOCIATION ---

${KNOWLEDGE_BASE}`;

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Basic abuse guard: cap how much conversation history and how long a
// single message can be, since this endpoint has no login and anyone
// can call it — protects the free quota from being exhausted by one
// bad actor sending huge payloads.
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 12;

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

  const { message, history } = body || {};
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Missing message" });
    return;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: "Message trop long." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set in environment variables.");
    res.status(500).json({ error: "Le chatbot n'est pas configuré. Contacte l'administrateur du site." });
    return;
  }

  // Build the conversation: prior turns (trimmed to a safe cap) + the new message.
  const trimmedHistory = Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : [];
  const contents = trimmedHistory
    .filter((turn) => turn && typeof turn.text === "string" && (turn.role === "user" || turn.role === "model"))
    .map((turn) => ({ role: turn.role, parts: [{ text: turn.text.slice(0, MAX_MESSAGE_LENGTH) }] }));
  contents.push({ role: "user", parts: [{ text: message }] });

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents,
        generationConfig: {
          temperature: 0.3, // lower temperature: favors sticking to the provided facts over creative phrasing
          maxOutputTokens: 800,
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => "");
      console.error("Gemini API error:", geminiRes.status, errText);
      if (geminiRes.status === 429) {
        res.status(503).json({ error: "Le chatbot reçoit trop de questions en ce moment. Réessaie dans une minute." });
        return;
      }
      res.status(502).json({ error: "Une erreur est survenue lors de la génération de la réponse." });
      return;
    }

    const data = await geminiRes.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) {
      console.error("Unexpected Gemini response shape:", JSON.stringify(data).slice(0, 500));
      res.status(502).json({ error: "Réponse invalide reçue. Réessaie." });
      return;
    }

    res.status(200).json({ reply });
  } catch (err) {
    console.error("chat.js error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
