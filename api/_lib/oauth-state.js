// oauth-state.js
//
// Standard OAuth CSRF defense: before redirecting to Google we mint a
// random `state` value, store it (with a short expiry), and require the
// callback to hand back that exact value. This stops an attacker from
// tricking someone into completing an OAuth flow whose result gets
// attributed to a session the attacker controls.

const { sql } = require("./db");
const { randomToken } = require("./tokens");

const STATE_TTL_MINUTES = 10;

async function createState() {
  const state = randomToken(24);
  const db = sql();
  await db`
    insert into portal_oauth_states (state, expires_at)
    values (${state}, now() + (${STATE_TTL_MINUTES} || ' minutes')::interval)
  `;
  return state;
}

// Single-use: consuming a state deletes it, so a replayed callback with
// the same state fails the second time.
async function consumeState(state) {
  if (!state) return false;
  const db = sql();
  const rows = await db`
    delete from portal_oauth_states
    where state = ${state} and expires_at > now()
    returning state
  `;
  return rows.length > 0;
}

module.exports = { createState, consumeState };
