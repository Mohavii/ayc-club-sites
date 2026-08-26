// mailer.js
//
// Uses Resend (free tier: 3,000 emails/month) — a couple of lines to send
// mail with no SMTP server to run or babysit. If you'd rather use
// something else, this is the only file that needs to change.
//
// Env vars:
//   RESEND_API_KEY
//   PORTAL_FROM_EMAIL — SINGLE config value for the "from" address, per
//                       the spec: currently no-reply@associationyouthclubs.org,
//                       will change to no-reply@ayc.tn later. Every email
//                       this file sends reads from here — nowhere else in
//                       the codebase should hardcode a from-address.

const DEFAULT_FROM = "no-reply@associationyouthclubs.org";

function fromAddress() {
  return process.env.PORTAL_FROM_EMAIL || DEFAULT_FROM;
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Fail loudly in logs but don't crash the calling request — a missing
    // mail provider shouldn't block an approval/rejection from taking
    // effect in the database.
    console.error("RESEND_API_KEY not set — email not sent:", { to, subject });
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Association YOUTH CLUBs <${fromAddress()}>`,
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("Resend send failed:", res.status, text);
  }
}

async function sendApprovalEmail(member) {
  await sendEmail({
    to: member.email,
    subject: "Ta demande d'adhésion a été approuvée",
    html: `
      <p>Bonjour ${escapeHtml(member.display_name)},</p>
      <p>Ta demande d'adhésion au portail YOUTHCLUBber a été <strong>approuvée</strong>.</p>
      <p>Tu peux maintenant te connecter au portail avec ton compte Google.</p>
      <p>— Association YOUTH CLUBs</p>
    `,
  });
}

async function sendRejectionEmail(member) {
  await sendEmail({
    to: member.email,
    subject: "Ta demande d'adhésion n'a pas été approuvée",
    html: `
      <p>Bonjour ${escapeHtml(member.display_name)},</p>
      <p>Ta demande d'adhésion au portail YOUTHCLUBber n'a pas été approuvée${
        member.rejection_note ? " : " + escapeHtml(member.rejection_note) : "."
      }</p>
      <p>Si tu penses qu'il s'agit d'une erreur, contacte ton club.</p>
      <p>— Association YOUTH CLUBs</p>
    `,
  });
}

async function sendNewRequestNotice(toEmails, member, schoolName) {
  await Promise.all(
    toEmails.map((to) =>
      sendEmail({
        to,
        subject: `Nouvelle demande d'adhésion — ${member.display_name}`,
        html: `
          <p>${escapeHtml(member.display_name)} (@${escapeHtml(member.username)}) a demandé à rejoindre
          le portail pour <strong>${escapeHtml(schoolName || "un club")}</strong>.</p>
          <p>Connecte-toi au portail pour approuver ou refuser cette demande.</p>
        `,
      })
    )
  );
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

module.exports = { sendApprovalEmail, sendRejectionEmail, sendNewRequestNotice, fromAddress };
