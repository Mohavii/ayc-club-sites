// Consolidated YOUTHCLUBber portal API.
// This route uses only the portal Neon database and portal session/role model.
const { sql } = require("./_lib/db");
const { put, get } = require("@vercel/blob");
const { requireActiveMember } = require("./_lib/sessions");
const {
  getMemberRoleHistory,
  getMemberCapabilities,
  getMemberStatusHistory,
  getCurrentDisplayRole,
  getMemberPortalAccess,
  BEL_ROLES,
  hasCapability,
  hasNationalCapability,
  hasNationalRole,
  getEpnMembers,
  requireCapability,
  getBenRoster,
  getMemberRoleLabel,
  BEN_ROSTER_ROLES,
  EPN_ROLES,
  EPN_ROLE_LABELS,
  EPL_ROLES,
  EPL_ROLE_LABELS,
  hasEplRole,
  getEplMembers,
} = require("./_lib/roles");

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body); } catch { return null; }
}

function json(res, status, value) {
  res.status(status).json(value);
}

function clip(value, max) {
  return value == null ? null : String(value).slice(0, max);
}

function nowText() {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

async function normalizeRawBody(req) {
  const raw = req.body;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw && raw.type === "Buffer" && Array.isArray(raw.data)) return Buffer.from(raw.data);
  if (req && typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return chunks.length ? Buffer.concat(chunks) : null;
  }
  return null;
}

function safeFilename(value) {
  return String(value || "document").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "document";
}

function jsonArrayInput(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean).slice(0, 20);
  if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean).slice(0, 20);
  return [];
}

const MEETING_TYPES = ["reunion_locale", "reunion_nationale", "reunion", "assemblee_locale", "assemblee_generale"];
const MEMBER_TRAINING_CATEGORIES = [
  "niveau_youthclubeur",
  "coordination_strategique",
  "relations_externes",
  "ressources_humaines",
  "tresorerie",
  "secretariat",
  "communication",
];
  const MEMBER_TRAINING_LABELS = {
  niveau_youthclubeur: "Niveau YOUTHCLUBeur",
  coordination_strategique: "Coordination Stratégique",
  relations_externes: "Relations Externes",
  ressources_humaines: "Ressources Humaines",
  tresorerie: "Trésorerie",
  secretariat: "Secrétariat",
  communication: "Communication",
};

function schoolScope(member, requested) {
  const id = Number(requested || member.school_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function requireClubCapability(req, res, member, capability, schoolId) {
  const guard = requireCapability(capability);
  return guard(req, res, member, schoolId);
}

// PV editing for a NATIONAL assembly is opened up to whoever holds the
// 'secretaire_national' title — les secrétaires write the AG's PV as
// part of that role, without needing the pv_editor capability, which
// stays a local-club-only permission. Local assemblies are unaffected
// and keep going through requireClubCapability("pv_editor", schoolId).
async function requirePvEditorForAssembly(req, res, member, assembly) {
  if (member.is_national_admin) return true;
  if (assembly.scope === "national") {
    if (await hasNationalRole(member.id, "secretaire_national")) return true;
    if (await hasCapability(member.id, assembly.school_id, "pv_editor")) return true;
    res.status(403).json({ error: "Réservé au/à la Secrétaire National(e) ou aux personnes disposant de la permission Éditeur de PV." });
    return false;
  }
  return requireClubCapability(req, res, member, "pv_editor", assembly.school_id);
}

async function profile(member) {
  const db = sql();
  const rows = await db`
    select m.id, m.email, m.username, m.display_name, m.profile_picture_url,
           m.cover_photo_url, m.phone, m.education_level, m.formateur_track,
           m.bio, m.status, m.membership_status, m.is_national_admin, m.school_id,
           s.name as school_name, s.slug as school_slug
    from portal_members m left join portal_schools s on s.id = m.school_id
    where m.id = ${member.id}
  `;
  const [trainerRows, awards, documents] = await Promise.all([
    db`select * from portal_trainer_profiles where member_id = ${member.id}`,
    db`select id, title, issuer, awarded_on, value_tag, description, visibility, created_at from portal_member_awards where member_id = ${member.id} and (visibility = 'active_members' or visibility = 'owner_admins') order by awarded_on desc nulls last, created_at desc`,
    db`select id, member_id, document_type, title, description, original_filename, mime_type, size_bytes, visibility, status, created_at from portal_member_documents where (member_id = ${member.id} or visibility = 'active_members') and status <> 'archived' order by created_at desc`,
  ]);
  return {
    member: rows[0] || member,
    roles: await getMemberRoleHistory(member.id),
    capabilities: await getMemberCapabilities(member.id),
    statusHistory: await getMemberStatusHistory(member.id),
    trainerProfile: trainerRows[0] || null,
    awards,
    documents: documents.map(doc => ({ ...doc, downloadAction: `document_download&id=${encodeURIComponent(doc.id)}` })),
  };
}

async function updateProfile(req, res, member, body) {
  if (req.method !== "POST") return json(res, 405, { error: "Méthode non autorisée." });
  const phone = String(body.phone || "").trim().slice(0, 80) || null;
  const educationLevel = String(body.educationLevel || "").trim().slice(0, 160) || null;
  const bio = String(body.bio || "").trim().slice(0, 2000) || null;
  let coverPhotoUrl = String(body.coverPhotoUrl || "").trim().slice(0, 1000) || null;
  if (coverPhotoUrl) {
    try {
      const parsed = new URL(coverPhotoUrl);
      if (parsed.protocol !== "https:") throw new Error("https required");
    } catch {
      return json(res, 400, { error: "Le lien de couverture doit être une URL HTTPS valide." });
    }
  }
  const db = sql();
  const rows = await db`
    update portal_members
    set phone = ${phone}, education_level = ${educationLevel}, bio = ${bio}, cover_photo_url = ${coverPhotoUrl}
    where id = ${member.id}
    returning id, email, username, display_name, profile_picture_url, cover_photo_url,
              phone, education_level, bio, status, membership_status, school_id
  `;
  return json(res, 200, { member: rows[0] });
}

async function dashboard(member) {
  const db = sql();
  const schoolId = member.school_id;
  const [counts, meetings, projects, tasks] = await Promise.all([
    db`
      select
        count(*) filter (where status = 'submitted')::int as awaiting_validation,
        count(*) filter (where status = 'draft')::int as drafts,
        count(*)::int as total
      from portal_reports where submitted_by = ${member.id}
    `,
    db`
      select id, title, meeting_type, starts_at, ends_at, format, location
      from portal_meetings
      where school_id = ${schoolId} and starts_at >= now()
      order by starts_at asc limit 6
    `,
    db`
      select id, title, project_type, starts_at, ends_at, status
      from portal_projects
      where school_id = ${schoolId} and status <> 'cancelled'
      order by coalesce(starts_at, created_at) asc limit 6
    `,
    db`
      select id, title, priority, deadline, status, project_id
      from portal_tasks where assigned_to = ${member.id}
      order by deadline nulls last, assigned_at desc limit 8
    `,
  ]);
  return { counts: counts[0], meetings, projects, tasks };
}

async function listMeetings(member, query) {
  const db = sql();
  const schoolId = schoolScope(member, query.schoolId);
  if (!schoolId) return [];
  return db`
    select m.*, s.name as school_name,
      chair.display_name as chair_name, secretary.display_name as secretary_name,
      (((m.starts_at at time zone 'Africa/Tunis')::date < (now() at time zone 'Africa/Tunis')::date)) as is_archived,
      (select count(*)::int from portal_meeting_attendees a where a.meeting_id = m.id) as attendee_count,
      (select coalesce(json_agg(json_build_object('id', i.id, 'position', i.position, 'title', i.title, 'durationMinutes', i.duration_minutes, 'notes', i.notes) order by i.position), '[]'::json)
         from portal_meeting_agenda_items i where i.meeting_id = m.id) as agenda_items
    from portal_meetings m
      join portal_schools s on s.id = m.school_id
      left join portal_members chair on chair.id = m.chair_id
      left join portal_members secretary on secretary.id = m.secretary_id
    where m.school_id = ${schoolId}
       or m.meeting_type in ('reunion_nationale', 'assemblee_generale')
    order by m.starts_at desc
  `;
}

function normalizeAgendaItems(body) {
  if (Array.isArray(body.agendaItems)) {
    return body.agendaItems.map((item, index) => ({
      position: index,
      title: String(item.title || '').trim(),
      durationMinutes: item.durationMinutes ? Number(item.durationMinutes) : null,
      notes: item.notes ? String(item.notes).trim() : null,
    })).filter(item => item.title).slice(0, 30);
  }
  return (Array.isArray(body.agenda) ? body.agenda : [])
    .map((title, index) => ({ position: index, title: String(title || '').trim(), durationMinutes: null, notes: null }))
    .filter(item => item.title).slice(0, 30);
}

async function createMeeting(req, res, member, body) {
  const schoolId = schoolScope(member, body.schoolId);
  if (!schoolId) return json(res, 400, { error: "Club invalide." });
  if (!(await requireClubCapability(req, res, member, "meeting_organizer", schoolId))) return;
  const nationalTypes = ["reunion_nationale", "assemblee_generale"];
  if (nationalTypes.includes(body.meetingType) && !member.is_national_admin) {
    return json(res, 403, { error: "Seul un administrateur national peut créer ce type de réunion." });
  }
  const title = String(body.title || "").trim();
  const startsAt = String(body.startsAt || "").trim();
  const allowedTypes = MEETING_TYPES;
  const allowedFormats = ["presentiel", "en_ligne", "hybride"];
  const allowedStatuses = ["planned", "live", "completed", "cancelled"];
  const format = allowedFormats.includes(body.format) ? body.format : "presentiel";
  const status = allowedStatuses.includes(body.status) ? body.status : "planned";
  const agendaItems = normalizeAgendaItems(body);
  if (!title || !startsAt || !allowedTypes.includes(body.meetingType)) {
    return json(res, 400, { error: "Titre, type et date requis." });
  }
  const db = sql();
  const meetingResult = await db`
    insert into portal_meetings
      (school_id, created_by, title, meeting_type, starts_at, ends_at, format, location, maps_url, comments, agenda, attachments, status, chair_id, secretary_id)
    values
      (${schoolId}, ${member.id}, ${title}, ${body.meetingType}, ${startsAt}, ${body.endsAt || null},
       ${format}, ${body.location || null}, ${body.mapsUrl || null}, ${body.comments || null},
       ${JSON.stringify(agendaItems)}::jsonb, ${JSON.stringify(Array.isArray(body.attachments) ? body.attachments : [])}::jsonb,
       ${status}, ${body.chairId || null}, ${body.secretaryId || null})
    returning *
  `;
  const meeting = meetingResult[0];
  if (agendaItems.length) {
    await db.transaction(agendaItems.map(item => db`
      insert into portal_meeting_agenda_items (meeting_id, position, title, duration_minutes, notes, created_by)
      values (${meeting.id}, ${item.position}, ${item.title}, ${item.durationMinutes}, ${item.notes}, ${member.id})
    `));
  }
  return json(res, 201, { meeting });
}

async function meetingDetail(req, res, member, body) {
  const id = String(body.meetingId || req.query?.meetingId || "");
  if (!id) return json(res, 400, { error: "Réunion introuvable." });
  const db = sql();
  const rows = await db`select * from portal_meetings where id = ${id}`;
  const meeting = rows[0];
  const isNationalMeeting = ["reunion_nationale", "assemblee_generale"].includes(meeting?.meeting_type);
  if (!meeting || (!member.is_national_admin && !isNationalMeeting && meeting.school_id !== member.school_id)) {
    return json(res, 404, { error: "Réunion introuvable." });
  }
  const isArchived = await db`select (((starts_at at time zone 'Africa/Tunis')::date < (now() at time zone 'Africa/Tunis')::date)) as archived from portal_meetings where id=${id}`.then(rows => Boolean(rows[0]?.archived));
  const access = await getMemberPortalAccess(member);
  const canEditPV = Boolean(member.is_national_admin || access.canEditPV);
  if (isArchived) {
    const archivedMinutes = await db`select * from portal_minutes where meeting_id=${id} and status in ('sent','validated')`;
    let structured = { attendance: [], agendaBlocks: [], motions: [] };
    if (archivedMinutes[0]) {
      const [attendance, agendaBlocks, motions] = await Promise.all([
        db`select a.*, m.display_name, m.username from portal_minutes_attendance a join portal_members m on m.id=a.member_id where a.minutes_id=${archivedMinutes[0].id} order by m.display_name`,
        db`select * from portal_minutes_agenda_blocks where minutes_id=${archivedMinutes[0].id} order by position`,
        db`select * from portal_minutes_motions where minutes_id=${archivedMinutes[0].id} order by position`,
      ]);
      structured = { attendance, agendaBlocks, motions };
    }
    return json(res, 200, { meeting: { ...meeting, is_archived: true }, agendaItems: [], attendees: [], roster: [], nationalClubs: [], eplMembers: [], minutes: archivedMinutes[0] || null, structured, archived: true, readOnly: true });
  }
  const [agendaItems, attendees, minutes, roster, nationalClubs, eplMembers] = await Promise.all([
    db`select * from portal_meeting_agenda_items where meeting_id = ${id} order by position`,
    db`
      select a.*, m.display_name, m.username, m.profile_picture_url, m.membership_status
      from portal_meeting_attendees a join portal_members m on m.id = a.member_id
      where a.meeting_id = ${id} order by m.display_name
    `,
    canEditPV
      ? db`select * from portal_minutes where meeting_id = ${id}`
      : db`select * from portal_minutes where meeting_id = ${id} and status in ('sent', 'validated')`,
    isNationalMeeting
      ? db`
          select distinct m.id, m.display_name, m.username, m.membership_status
          from portal_club_display_roles r
          join portal_members m on m.id = r.member_id
          where r.role in ('president', 'tresorier', 'secretaire', 'vpi', 'vpe', 'vpc')
            and r.ended_at is null and m.status = 'active'
          order by m.display_name
        `
      : db`select id, display_name, username, membership_status from portal_members where school_id = ${meeting.school_id} and status = 'active' order by display_name`,
    isNationalMeeting
      ? db`
          select s.id as school_id, s.name as school_name,
            coalesce((
              select json_agg(json_build_object('id', m.id, 'displayName', m.display_name, 'username', m.username, 'role', r.role) order by r.role, m.display_name)
              from portal_club_display_roles r
              join portal_members m on m.id = r.member_id
              where r.school_id = s.id and r.role in ('president', 'tresorier', 'secretaire', 'vpi', 'vpe', 'vpc')
                and r.ended_at is null and m.status = 'active'
            ), '[]'::json) as representatives
          from portal_schools s
          where s.is_active = true
          order by s.name
        `
      : Promise.resolve([]),
    // The Équipe Plénière Locale is used to auto-fill "Rédigé par" on a
    // local meeting's PV — nobody has to pick a preparer by hand anymore,
    // it defaults to whoever is currently seated on the club's EPL.
    !isNationalMeeting ? getEplMembers(meeting.school_id) : Promise.resolve([]),
  ]);
  let structured = { attendance: [], agendaBlocks: [], motions: [] };
  if (minutes[0]) {
    const [attendance, agendaBlocks, motions] = await Promise.all([
      db`select a.*, m.display_name, m.username from portal_minutes_attendance a join portal_members m on m.id = a.member_id where a.minutes_id = ${minutes[0].id} order by m.display_name`,
      db`select * from portal_minutes_agenda_blocks where minutes_id = ${minutes[0].id} order by position`,
      db`select * from portal_minutes_motions where minutes_id = ${minutes[0].id} order by position`,
    ]);
    structured = { attendance, agendaBlocks, motions };
  }
  if (req.method === "GET" || body.action === "meeting") return json(res, 200, { meeting, agendaItems, attendees, roster, nationalClubs, eplMembers, minutes: minutes[0] || null, structured, canEditPV });
  if (body.action === "rsvp") {
    const rsvp = ["pending", "present", "absent"].includes(body.rsvp) ? body.rsvp : "pending";
    const result = await db`
      insert into portal_meeting_attendees (meeting_id, member_id, rsvp)
      values (${id}, ${member.id}, ${rsvp})
      on conflict (meeting_id, member_id) do update set rsvp = excluded.rsvp
      returning *
    `;
    return json(res, 200, { attendee: result[0] });
  }
  if (body.action === "save_minutes") {
    if (!(await requireClubCapability(req, res, member, "pv_editor", meeting.school_id))) return;
    const mode = body.mode === "assemblee_generale" ? body.mode : "standard";
    const status = ["draft", "sent", "validated"].includes(body.status) ? body.status : "draft";
    const attendance = Array.isArray(body.attendance) ? body.attendance.slice(0, 300) : [];
    const agendaBlocks = Array.isArray(body.agendaBlocks) ? body.agendaBlocks.slice(0, 50) : [];
    const motions = Array.isArray(body.motions) ? body.motions.slice(0, 100) : [];
    const activeIds = new Set(roster.map(row => String(row.id)));
    const normalizedAttendance = isNationalMeeting ? [] : attendance.filter(row => activeIds.has(String(row.memberId))).map((row, index) => {
      const member = roster.find(candidate => String(candidate.id) === String(row.memberId));
      const canVoteLocally = member?.membership_status !== 'nouveau_adherent';
      return {
        memberId: row.memberId,
        attendanceStatus: ["present", "absent", "excused", "late"].includes(row.attendanceStatus) ? row.attendanceStatus : "present",
        votingRights: canVoteLocally,
        memberRole: row.memberRole ? String(row.memberRole).slice(0, 160) : null,
        note: row.note ? String(row.note).slice(0, 500) : null,
        position: index,
      };
    });
    const clubPresence = [];
    if (isNationalMeeting) {
      const clubMap = new Map(nationalClubs.map(club => [String(club.school_id), club]));
      const seenClubs = new Set();
      for (const row of (Array.isArray(body.clubPresence) ? body.clubPresence : []).slice(0, 100)) {
        const schoolId = String(Number(row.schoolId));
        const club = clubMap.get(schoolId);
        const representativeId = String(row.representativeId || '');
        const representative = club?.representatives?.find(candidate => String(candidate.id) === representativeId);
        if (!club || seenClubs.has(schoolId)) continue;
        if (!representative || !BEL_ROLES.includes(representative.role)) {
          return json(res, 400, { error: `Le représentant du club ${club.school_name} doit être un membre BEL actif.` });
        }
        seenClubs.add(schoolId);
        clubPresence.push({ schoolId: Number(schoolId), schoolName: club.school_name, representativeId: representative.id, representativeName: representative.displayName, representativeRole: representative.role });
        activeIds.add(String(representative.id));
      }
    }
    const savedMinutes = await db`
      insert into portal_minutes
        (meeting_id, mode, mandate, organizer, drafted_at, sent_at, closing_at, duration_minutes, redactors, attendance, agenda_blocks, motions, club_presence, status, created_by)
      values (${id}, ${mode}, ${body.mandate || null}, ${body.organizer || null}, ${body.draftedAt || null}, ${body.sentAt || null},
        ${body.closingAt || null}, ${body.durationMinutes ? Number(body.durationMinutes) : null},
        ${JSON.stringify(body.redactors || [])}::jsonb, ${JSON.stringify(normalizedAttendance)}::jsonb,
        ${JSON.stringify(agendaBlocks)}::jsonb, ${JSON.stringify(motions)}::jsonb, ${JSON.stringify(clubPresence)}::jsonb, ${status}, ${member.id})
      on conflict (meeting_id) do update set
        mode = excluded.mode, mandate = excluded.mandate, organizer = excluded.organizer,
        drafted_at = excluded.drafted_at, sent_at = excluded.sent_at, closing_at = excluded.closing_at,
        duration_minutes = excluded.duration_minutes, redactors = excluded.redactors, attendance = excluded.attendance,
        agenda_blocks = excluded.agenda_blocks, motions = excluded.motions, club_presence = excluded.club_presence, status = excluded.status, updated_at = now()
      returning *
    `;
    const minutesId = savedMinutes[0].id;
    const statements = [
      db`delete from portal_minutes_attendance where minutes_id = ${minutesId}`,
      db`delete from portal_minutes_agenda_blocks where minutes_id = ${minutesId}`,
      db`delete from portal_minutes_motions where minutes_id = ${minutesId}`,
    ];
    const structuredResult = await db.transaction(async tx => {
      await tx`delete from portal_minutes_attendance where minutes_id = ${minutesId}`;
      await tx`delete from portal_minutes_agenda_blocks where minutes_id = ${minutesId}`;
      await tx`delete from portal_minutes_motions where minutes_id = ${minutesId}`;
      for (const row of normalizedAttendance) await tx`
        insert into portal_minutes_attendance (minutes_id, member_id, attendance_status, voting_rights, member_role, note)
        values (${minutesId}, ${row.memberId}, ${row.attendanceStatus}, ${row.votingRights}, ${row.memberRole}, ${row.note})
      `;
      for (const [position, block] of agendaBlocks.entries()) await tx`
        insert into portal_minutes_agenda_blocks (minutes_id, position, title, discussion, decision, duration_minutes, actual_duration_minutes, next_steps, attachments)
        values (${minutesId}, ${position}, ${String(block.title || 'Point').slice(0, 300)}, ${block.discussion || null}, ${block.decision || null}, ${block.durationMinutes ? Number(block.durationMinutes) : null}, ${block.actualDurationMinutes ? Number(block.actualDurationMinutes) : null}, ${block.nextSteps || null}, ${JSON.stringify(Array.isArray(block.attachments) ? block.attachments.slice(0, 20) : [])}::jsonb)
      `;
      for (const [position, motion] of motions.entries()) await tx`
        insert into portal_minutes_motions (minutes_id, position, motion_type, title, proposer_id, seconder_id, amendment, direct_negative, majority_type, votes_for, votes_against, abstentions, result, consequence)
        values (${minutesId}, ${position}, ${String(motion.motionType || 'decision').slice(0, 80)}, ${String(motion.title || 'Motion').slice(0, 300)},
          ${activeIds.has(motion.proposerId) ? motion.proposerId : null}, ${activeIds.has(motion.seconderId) ? motion.seconderId : null},
          ${motion.amendment || null}, ${motion.directNegative || null}, ${motion.majorityType || null},
          ${Number(motion.votesFor || 0)}, ${Number(motion.votesAgainst || 0)}, ${Number(motion.abstentions || 0)}, ${motion.result || null}, ${motion.consequence || null})
      `;
      return true;
    });
    return json(res, 200, { minutes: savedMinutes[0], structuredSaved: structuredResult });
  }
  return json(res, 400, { error: "Action de réunion inconnue." });
}

async function strategicAxes(req, res) {
  const db = sql();
  const axes = await db`
    select a.slug, a.name, a.description, a.sort_order,
      coalesce(json_agg(json_build_object('slug', s.slug, 'name', s.name, 'description', s.description) order by s.sort_order, s.name) filter (where s.slug is not null), '[]'::json) as sub_axes
    from portal_strategic_axes a
    left join portal_strategic_sub_axes s on s.axis_slug = a.slug
    group by a.slug order by a.sort_order, a.name
  `;
  return json(res, 200, { axes });
}

async function reportTemplates(req, res) {
  const db = sql();
  const templates = await db`select * from portal_report_templates order by name`;
  return json(res, 200, { templates });
}

async function projectRoster(db, project) {
  const memberScope = project.scope === 'national'
    ? db`select id, display_name, username, school_id from portal_members where status = 'active' order by display_name`
    : db`select id, display_name, username, school_id from portal_members where status = 'active' and school_id = ${project.school_id} order by display_name`;
  return memberScope;
}

async function getProjectForMember(db, member, projectId) {
  const rows = await db`select p.*, s.name as school_name,
    president.display_name as president_name,
    creator.display_name as creator_name
    from portal_projects p
    left join portal_schools s on s.id = p.school_id
    left join portal_members president on president.id = p.president_id
    left join portal_members creator on creator.id = p.created_by
    where p.id = ${projectId} and p.status <> 'cancelled'
      and (p.scope = 'national' or p.school_id = ${member.school_id} or p.created_by = ${member.id})`;
  return rows[0] || null;
}

async function projectTeams(db, projectId) {
  const teams = await db`
    select t.*, supervisor.display_name as supervisor_name,
      (select count(*)::int from portal_project_team_members tm where tm.team_id = t.id) as member_count
    from portal_project_teams t
    left join portal_members supervisor on supervisor.id = t.supervisor_id
    where t.project_id = ${projectId}
    order by t.created_at asc
  `;
  for (const team of teams) {
    team.members = await db`
      select m.id, m.display_name, m.username, m.school_id
      from portal_project_team_members tm
      join portal_members m on m.id = tm.member_id
      where tm.team_id = ${team.id}
      order by m.display_name
    `;
  }
  return teams;
}

async function canManageProject(db, member, project) {
  if (!project) return false;
  if (member.is_national_admin || project.president_id === member.id) return true;
  if (project.scope === 'national') return hasNationalCapability(member.id, 'national_projects');
  return hasCapability(member.id, project.school_id, 'project_manager');
}

async function projects(req, res, member, body) {
  const db = sql();
  if (req.method === 'GET') {
    const requestedProjectId = String(req.query?.projectId || '').trim();
    if (requestedProjectId) {
      const project = await getProjectForMember(db, member, requestedProjectId);
      if (!project) return json(res, 404, { error: 'Projet introuvable.' });
      const teams = await projectTeams(db, project.id);
      return json(res, 200, {
        project,
        teams,
        roster: await projectRoster(db, project),
        canManage: await canManageProject(db, member, project),
        isPresident: project.president_id === member.id || Boolean(member.is_national_admin),
      });
    }
    const rows = await db`
      select p.*, a.name as axis_name, sa.name as sub_axis_name,
        s.name as school_name, president.display_name as president_name,
        (select count(*)::int from portal_project_teams t where t.project_id = p.id) as team_count,
        (select count(*)::int from portal_project_team_members tm join portal_project_teams t on t.id = tm.team_id where t.project_id = p.id) as member_count,
        (select count(*)::int from portal_reports r where r.project_id = p.id) as report_count
      from portal_projects p
      left join portal_schools s on s.id = p.school_id
      left join portal_members president on president.id = p.president_id
      left join portal_strategic_axes a on a.slug = p.axis_slug
      left join portal_strategic_sub_axes sa on sa.slug = p.sub_axis_slug
      where p.status <> 'cancelled'
        and (p.scope = 'national' or p.school_id = ${member.school_id})
      order by case when p.scope = 'national' then 0 else 1 end, coalesce(p.starts_at, p.created_at) desc
    `;
    return json(res, 200, { projects: rows });
  }

  const action = String(body.action || 'create');

  if (action === 'create') {
    const scope = body.scope === 'national' ? 'national' : 'local';
    const requestedSchoolId = schoolScope(member, body.schoolId);
    const schoolId = requestedSchoolId || null;
    if (scope === 'local' && !schoolId) return json(res, 400, { error: 'Club invalide.' });
    if (scope === 'national') {
      if (!(member.is_national_admin || await hasNationalCapability(member.id, 'national_projects'))) {
        return json(res, 403, { error: 'La permission national_projects est requise pour créer un projet national.' });
      }
    } else if (!(await requireClubCapability(req, res, member, 'project_manager', schoolId))) {
      return;
    }
    const title = String(body.title || '').trim().slice(0, 200);
    if (!title) return json(res, 400, { error: 'Titre du projet requis.' });
    const axisSlug = body.axisSlug ? String(body.axisSlug).trim() : null;
    if (axisSlug) {
      const axis = await db`select slug from portal_strategic_axes where slug = ${axisSlug}`;
      if (!axis[0]) return json(res, 400, { error: 'Axe stratégique invalide.' });
    }
    const result = await db`
      insert into portal_projects
        (school_id, created_by, president_id, scope, title, description, project_type, starts_at, ends_at, status, axis_slug, sub_axis_slug, objectives, expected_results, evaluation_method, stakeholders, indicators)
      values
        (${schoolId}, ${member.id}, ${member.id}, ${scope}, ${title}, ${body.description || null}, ${String(body.projectType || 'projet').slice(0,80)},
         ${body.startsAt || null}, ${body.endsAt || null},
         ${['draft','in_progress','completed','cancelled'].includes(body.status) ? body.status : 'in_progress'},
         ${axisSlug}, ${body.subAxisSlug || null}, ${body.objectives || null}, ${body.expectedResults || null}, ${body.evaluationMethod || null},
         ${JSON.stringify(Array.isArray(body.stakeholders) ? body.stakeholders : [])}::jsonb,
         ${JSON.stringify(Array.isArray(body.indicators) ? body.indicators : [])}::jsonb)
      returning *
    `;
    await recordAudit(db, { actorId: member.id, action: 'project.created', entityType: 'project', entityId: result[0].id, afterData: result[0] });
    return json(res, 201, { project: result[0] });
  }

  const project = await getProjectForMember(db, member, body.projectId);
  if (!project) return json(res, 404, { error: 'Projet introuvable.' });

  if (action === 'create_team') {
    if (!(await canManageProject(db, member, project)) || (project.president_id !== member.id && !member.is_national_admin)) {
      return json(res, 403, { error: 'Seul le Président du projet peut créer et gérer les équipes.' });
    }
    const name = String(body.name || '').trim().slice(0, 150);
    if (!name) return json(res, 400, { error: "Nom de l'équipe requis." });
    const supervisorId = body.supervisorId ? String(body.supervisorId) : null;
    if (!supervisorId) return json(res, 400, { error: 'Un superviseur doit être désigné pour cette équipe.' });
    if (supervisorId) {
      const supervisors = await db`select id from portal_members where id = ${supervisorId} and status = 'active'`;
      if (!supervisors[0]) return json(res, 400, { error: 'Superviseur invalide.' });
      if (project.scope === 'local' && !await db`select 1 from portal_members where id=${supervisorId} and school_id=${project.school_id}`.then(r => r.length)) {
        return json(res, 400, { error: 'Le superviseur doit appartenir au club du projet local.' });
      }
    }
    const rows = await db`insert into portal_project_teams (project_id, name, supervisor_id, created_by) values (${project.id}, ${name}, ${supervisorId}, ${member.id}) returning *`;
    await recordAudit(db, { actorId: member.id, action: 'project.team_created', entityType: 'project_team', entityId: rows[0].id, afterData: rows[0] });
    return json(res, 201, { team: rows[0] });
  }

  const teamRows = await db`select * from portal_project_teams where id=${body.teamId} and project_id=${project.id}`;
  const team = teamRows[0];
  if (!team) return json(res, 404, { error: 'Équipe introuvable.' });

  if (action === 'assign_supervisor') {
    if (!(project.president_id === member.id || member.is_national_admin)) return json(res, 403, { error: 'Seul le Président du projet peut désigner un superviseur.' });
    const supervisorId = body.supervisorId ? String(body.supervisorId) : null;
    if (supervisorId) {
      const rows = await db`select id from portal_members where id=${supervisorId} and status='active'`;
      if (!rows[0]) return json(res, 400, { error: 'Superviseur invalide.' });
      if (project.scope === 'local') {
        const localRows = await db`select id from portal_members where id=${supervisorId} and status='active' and school_id=${project.school_id}`;
        if (!localRows[0]) return json(res, 400, { error: 'Le superviseur doit appartenir au club du projet local.' });
      }
    }
    const rows = await db`update portal_project_teams set supervisor_id=${supervisorId}, updated_at=now() where id=${team.id} returning *`;
    return json(res, 200, { team: rows[0] });
  }

  if (action === 'assign_member' || action === 'remove_member') {
    if (team.supervisor_id !== member.id && project.president_id !== member.id && !member.is_national_admin) {
      return json(res, 403, { error: 'Cette équipe est gérée par son superviseur.' });
    }
    const memberId = String(body.memberId || '');
    if (!memberId) return json(res, 400, { error: 'Membre requis.' });
    if (action === 'assign_member') {
      const rows = await db`select id from portal_members where id=${memberId} and status='active'`;
      if (!rows[0]) return json(res, 400, { error: 'Membre invalide.' });
      if (project.scope === 'local') {
        const localRows = await db`select id from portal_members where id=${memberId} and status='active' and school_id=${project.school_id}`;
        if (!localRows[0]) return json(res, 400, { error: 'Le membre doit appartenir au club du projet local.' });
      }
      await db`insert into portal_project_team_members (team_id, member_id, assigned_by) values (${team.id}, ${memberId}, ${member.id}) on conflict (team_id, member_id) do nothing`;
      return json(res, 200, { ok: true });
    }
    await db`delete from portal_project_team_members where team_id=${team.id} and member_id=${memberId}`;
    return json(res, 200, { ok: true });
  }

  return json(res, 400, { error: 'Action projet inconnue.' });
}

function reportDeadlineStatus(report) {
  if (!report.due_at) return null;
  if (["validated", "invalidated"].includes(report.status)) return report.status === "validated" ? "completed" : "blocked";
  return new Date(report.due_at).getTime() < Date.now() ? "late" : "upcoming";
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseOptionalDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function deadlineRowStatus(report, dueAt) {
  if (report.status === "validated") return "completed";
  if (report.status === "invalidated") return "escalated";
  return dueAt.getTime() < Date.now() ? "late" : "upcoming";
}

async function syncReportDeadline(db, report) {
  if (!report.due_at) {
    await db`update portal_report_deadlines set status = 'cancelled' where report_id = ${report.id} and status not in ('completed', 'cancelled')`;
    return;
  }
  const dueAt = new Date(report.due_at);
  if (Number.isNaN(dueAt.getTime())) return;
  const status = deadlineRowStatus(report, dueAt);
  const reminderAt = new Date(dueAt.getTime() - (48 * 60 * 60 * 1000));
  const updated = await db`
    update portal_report_deadlines
    set template_slug = ${report.template_slug}, school_id = ${report.school_id}, project_id = ${report.project_id || null},
        due_at = ${dueAt}, status = ${status}, reminder_at = ${reminderAt}
    where report_id = ${report.id}
    returning id
  `;
  if (!updated[0]) {
    await db`
      insert into portal_report_deadlines
        (template_slug, school_id, project_id, report_id, due_at, status, reminder_at)
      values (${report.template_slug}, ${report.school_id}, ${report.project_id || null}, ${report.id}, ${dueAt}, ${status}, ${reminderAt})
    `;
  }
}

async function reports(req, res, member, body) {
  const db = sql();
  const canCreateReport = async (schoolId) => {
    if (member.is_national_admin) return true;
    const role = await getCurrentDisplayRole(member.id, schoolId);
    return Boolean(role || await hasCapability(member.id, schoolId, "supervision_editor"));
  };
  if (req.method === "GET") {
    const schoolId = schoolScope(member, req.query?.schoolId);
    if (!schoolId) return json(res, 200, { reports: [] });
    const rows = await db`
      select r.*, m.display_name as submitter_name, p.title as project_title,
        a.name as axis_name, t.name as template_name, t.required_sections, t.validator_departments,
        coalesce(json_agg(json_build_object('department', rv.department, 'status', rv.status, 'comment', rv.comment, 'reviewedAt', rv.reviewed_at) order by rv.department) filter (where rv.report_id is not null), '[]'::json) as reviews
      from portal_reports r
      join portal_members m on m.id = r.submitted_by
      left join portal_projects p on p.id = r.project_id
      left join portal_strategic_axes a on a.slug = r.axis_slug
      left join portal_report_templates t on t.slug = r.template_slug
      left join portal_report_reviews rv on rv.report_id = r.id
      where r.school_id = ${schoolId}
      group by r.id, m.display_name, p.title, a.name, t.name, t.required_sections, t.validator_departments
      order by coalesce(r.due_at, r.created_at) asc, r.created_at desc
    `;
    return json(res, 200, { reports: rows.map(row => ({ ...row, deadline_status: reportDeadlineStatus(row) })) });
  }
  if (body.action === "review") {
    const reportRows = await db`select school_id from portal_reports where id = ${body.reportId}`;
    const report = reportRows[0];
    if (!report) return json(res, 404, { error: "Rapport introuvable." });
    if (!(await requireClubCapability(req, res, member, "report_validator", report.school_id))) return;
    const templateRows = await db`
      select t.validator_departments, r.template_slug
      from portal_reports r left join portal_report_templates t on t.slug = r.template_slug
      where r.id = ${body.reportId}
    `;
    const requiredDepartments = jsonArray(templateRows[0]?.validator_departments).map(value => String(value));
    const status = ["pending", "valid", "invalid"].includes(body.status) ? body.status : "pending";
    const department = String(body.department || "").trim().slice(0, 100);
    if (!department || !requiredDepartments.includes(department)) {
      return json(res, 400, { error: "Ce département ne fait pas partie de la matrice de validation du modèle." });
    }
    const result = await db`
      insert into portal_report_reviews (report_id, department, status, comment, reviewer_id, reviewed_at)
      values (${body.reportId}, ${department}, ${status}, ${body.comment || null}, ${member.id}, now())
      on conflict (report_id, department) do update set status=excluded.status, comment=excluded.comment, reviewer_id=excluded.reviewer_id, reviewed_at=now()
      returning *
    `;
    const reviewRows = await db`select department, status from portal_report_reviews where report_id = ${body.reportId}`;
    const reviewMap = new Map(reviewRows.map(row => [row.department, row.status]));
    const nextStatus = reviewRows.some(row => row.status === "invalid")
      ? "invalidated"
      : (requiredDepartments.length > 0 && requiredDepartments.every(required => reviewMap.get(required) === "valid") ? "validated" : "submitted");
    const reportAfterReview = await db`update portal_reports set status = ${nextStatus}, updated_at = now() where id = ${body.reportId} returning *`;
    if (reportAfterReview[0]) await syncReportDeadline(db, reportAfterReview[0]);
    return json(res, 200, { review: result[0], reportStatus: nextStatus });
  }
  if (body.action === "update" && body.reportId) {
    const existing = await db`select school_id from portal_reports where id = ${body.reportId} and submitted_by = ${member.id}`;
    if (!existing[0]) return json(res, 404, { error: "Rapport introuvable." });
    const schoolId = existing[0].school_id;
    if (!(await canCreateReport(schoolId))) return json(res, 403, { error: "La rédaction de rapports est réservée aux responsables du club ou aux personnes mandatées." });
    const templateSlug = String(body.templateSlug || body.reportType || "proces_verbal");
    const template = await db`select slug from portal_report_templates where slug = ${templateSlug} and active = true`;
    if (!template[0]) return json(res, 400, { error: "Modèle de rapport invalide." });
    const axisSlug = body.axisSlug ? String(body.axisSlug).trim() : null;
    if (axisSlug) {
      const axis = await db`select slug from portal_strategic_axes where slug = ${axisSlug}`;
      if (!axis[0]) return json(res, 400, { error: "Axe stratégique invalide." });
    }
    const projectId = body.projectId || null;
    if (projectId) {
      const project = await db`select id from portal_projects where id = ${projectId} and school_id = ${schoolId}`;
      if (!project[0]) return json(res, 400, { error: "Projet invalide pour ce club." });
    }
    const status = body.status === "draft" ? "draft" : "submitted";
    const dueAt = parseOptionalDate(body.dueAt);
    if (body.dueAt && !dueAt) return json(res, 400, { error: "Échéance invalide." });
    const result = await db`
      update portal_reports
      set project_id = ${projectId}, template_slug = ${templateSlug}, report_type = ${body.reportType || templateSlug},
          title = ${String(body.title || "Rapport").trim()}, recipient = ${body.recipient || null}, axis_slug = ${axisSlug},
          sub_axis_slug = ${body.subAxisSlug || null}, description = ${body.description || null}, event_date = ${body.eventDate || null},
          due_at = ${dueAt}, payload = ${JSON.stringify(body.payload || {})}::jsonb, status = ${status}, updated_at = now(),
          submitted_at = case when ${status} = 'submitted' then coalesce(submitted_at, now()) else submitted_at end
      where id = ${body.reportId} and submitted_by = ${member.id}
      returning *
    `;
    if (result[0]) await syncReportDeadline(db, result[0]);
    return json(res, result[0] ? 200 : 404, result[0] ? { report: result[0] } : { error: "Rapport introuvable." });
  }
  const schoolId = schoolScope(member, body.schoolId);
  const allowedTypes = ["pre_projet", "post_projet", "proces_verbal", "collaboration", "mise_a_jour", "supervision", "investigation"];
  if (!schoolId || !body.title || !allowedTypes.includes(body.reportType)) return json(res, 400, { error: "Type, club et titre requis." });
  if (!(await canCreateReport(schoolId))) return json(res, 403, { error: "La rédaction de rapports est réservée aux responsables du club ou aux personnes mandatées." });
  const templateSlug = String(body.templateSlug || body.reportType);
  const template = await db`select slug, validator_departments from portal_report_templates where slug = ${templateSlug} and active = true`;
  if (!template[0]) return json(res, 400, { error: "Modèle de rapport invalide." });
  const dueAt = parseOptionalDate(body.dueAt);
  if (body.dueAt && !dueAt) return json(res, 400, { error: "Échéance invalide." });
  const axisSlug = body.axisSlug ? String(body.axisSlug).trim() : null;
  if (axisSlug) {
    const axis = await db`select slug from portal_strategic_axes where slug = ${axisSlug}`;
    if (!axis[0]) return json(res, 400, { error: "Axe stratégique invalide." });
  }
  const projectId = body.projectId || null;
  if (projectId) {
    const project = await db`select id from portal_projects where id = ${projectId} and school_id = ${schoolId}`;
    if (!project[0]) return json(res, 400, { error: "Projet invalide pour ce club." });
  }
  const status = body.status === "draft" ? "draft" : "submitted";
  const result = await db`
    insert into portal_reports (school_id, submitted_by, project_id, template_slug, report_type, title, recipient, axis_slug, sub_axis_slug, event_date, due_at, submitted_at, description, payload, status)
    values (${schoolId}, ${member.id}, ${projectId}, ${templateSlug}, ${body.reportType}, ${String(body.title).trim()}, ${body.recipient || null}, ${axisSlug}, ${body.subAxisSlug || null}, ${body.eventDate || null}, ${dueAt}, ${status === "submitted" ? new Date() : null}, ${body.description || null}, ${JSON.stringify(body.payload || {})}::jsonb, ${status})
    returning *
  `;
  if (result[0]) await syncReportDeadline(db, result[0]);
  return json(res, 201, { report: result[0] });
}

async function visibleDocuments(db, member) {
  return db`
    select id, member_id, document_type, title, description, original_filename, mime_type, size_bytes, visibility, status, created_at
    from portal_member_documents
    where (member_id = ${member.id} or (visibility = 'active_members' and ${member.status} = 'active'))
      and status <> 'archived'
    order by created_at desc
  `;
}

async function documentUpload(req, res, member) {
  if (req.method !== "POST") return json(res, 405, { error: "Méthode non autorisée." });
  const contentType = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
  const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  if (!allowedTypes.includes(contentType)) return json(res, 400, { error: "Format non supporté. Utilise PDF, DOCX, JPEG, PNG ou WEBP." });
  const body = await normalizeRawBody(req);
  const maxBytes = 12 * 1024 * 1024;
  if (!body || !body.length) return json(res, 400, { error: "Fichier vide ou illisible." });
  if (body.length > maxBytes) return json(res, 400, { error: "Fichier trop lourd (12 Mo maximum)." });
  const documentType = String(req.query?.documentType || "other");
  const allowedDocumentTypes = ["candidature", "training_evidence", "trainer_certificate", "award_evidence", "other"];
  if (!allowedDocumentTypes.includes(documentType)) return json(res, 400, { error: "Type de document invalide." });
  const title = String(req.query?.title || req.query?.filename || "Document").trim().slice(0, 200);
  if (!title) return json(res, 400, { error: "Titre du document requis." });
  const filename = safeFilename(req.query?.filename || title);
  const visibility = documentType === "candidature" ? "active_members" : "owner_admins";
  const pathname = `portal-documents/${member.id}/${Date.now()}-${filename}`;
  const blob = await put(pathname, body, { access: "private", contentType, addRandomSuffix: true });
  const db = sql();
  const rows = await db`
    insert into portal_member_documents
      (member_id, uploaded_by, document_type, title, storage_key, storage_url, original_filename, mime_type, size_bytes, visibility, status)
    values
      (${member.id}, ${member.id}, ${documentType}, ${title}, ${blob.pathname || pathname}, ${blob.url || null}, ${filename}, ${contentType}, ${body.length}, ${visibility}, 'pending')
    returning id, document_type, title, visibility, status, created_at
  `;
  return json(res, 201, { document: rows[0] });
}

async function documentDownload(req, res, member) {
  if (req.method !== "GET") return json(res, 405, { error: "Méthode non autorisée." });
  const id = String(req.query?.id || "");
  if (!id) return json(res, 400, { error: "Document introuvable." });
  const db = sql();
  const rows = await db`
    select id, member_id, storage_key, original_filename, mime_type
    from portal_member_documents
    where id = ${id}
      and status <> 'archived'
      and (member_id = ${member.id} or (visibility = 'active_members' and ${member.status} = 'active'))
  `;
  if (!rows[0]) return json(res, 404, { error: "Document introuvable ou non autorisé." });
  const blob = await get(rows[0].storage_key, { access: "private" });
  if (!blob) return json(res, 404, { error: "Fichier indisponible." });
  const buffer = Buffer.from(await new Response(blob.stream).arrayBuffer());
  res.statusCode = 200;
  res.setHeader("Content-Type", rows[0].mime_type || "application/octet-stream");
  res.setHeader("Content-Length", String(buffer.length));
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(rows[0].original_filename || "document")}"`);
  return res.end(buffer);
}

async function training(req, res, member, body) {
  const db = sql();
  const access = await getMemberPortalAccess(member);
  const isSimpleMember = !member.is_national_admin && !access.isVerifiedTrainer && (access.isOrdinaryMember || access.isNewAdherent);
  if (req.method === "GET") {
    const [entries, trainerRows, awards, documents] = await Promise.all([
      isSimpleMember
        ? db`select * from portal_training_entries where member_id = ${member.id} and validation_status = 'validated' order by held_on desc nulls last, created_at desc`
        : db`select * from portal_training_entries where member_id = ${member.id} order by held_on desc nulls last, created_at desc`,
      db`select * from portal_trainer_profiles where member_id = ${member.id}`,
      isSimpleMember
        ? Promise.resolve([])
        : db`select id, title, issuer, awarded_on, value_tag, description, visibility, created_at from portal_member_awards where member_id = ${member.id} and visibility = 'active_members' order by awarded_on desc nulls last, created_at desc`,
      visibleDocuments(db, member),
    ]);
    const totals = { hours: 0, declaredHours: 0, validatedHours: 0 };
    const isVerifiedTrainer = trainerRows[0]?.certification_status === "verified" || member.is_national_admin;
    const visibleEntries = isVerifiedTrainer ? entries : entries.filter(entry => MEMBER_TRAINING_CATEGORIES.includes(entry.category));
    const trainingRequests = isVerifiedTrainer
      ? await db`
          select e.*, m.display_name as member_name, m.username as member_username, s.name as school_name
          from portal_training_entries e
          join portal_members m on m.id = e.member_id
          left join portal_schools s on s.id = m.school_id
          where e.validation_status = 'pending'
            and (${member.is_national_admin} or m.school_id = ${member.school_id})
          order by e.created_at asc
        `
      : [];
    for (const entry of visibleEntries) {
      const hours = Number(entry.hours || 0);
      totals.declaredHours += hours;
      if (entry.validation_status === "validated") totals.validatedHours += hours;
    }
    totals.hours = totals.validatedHours;
    return json(res, 200, {
      entries: visibleEntries,
      trainerProfile: trainerRows[0] || null,
      awards,
      documents,
      totals,
      trainingRequests,
      access: { isVerifiedTrainer, isSimpleMember },
      categoryLabels: isSimpleMember ? {} : MEMBER_TRAINING_LABELS,
    });
  }
  const trainerRows = await db`select certification_status from portal_trainer_profiles where member_id = ${member.id} limit 1`;
  const canEditOfficialTraining = member.is_national_admin || trainerRows[0]?.certification_status === "verified";
  if (body.action === "training_decision") {
    if (!canEditOfficialTraining) return json(res, 403, { error: "Validation réservée aux formateurs homologués et à l’administration." });
    const entryId = String(body.entryId || "");
    const decision = body.decision === "reject" ? "rejected" : "validated";
    const hours = body.hours === "" || body.hours == null ? null : Number(body.hours);
    if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 10000)) return json(res, 400, { error: "Nombre d'heures invalide." });
    const rows = await db`
      select e.*, m.school_id
      from portal_training_entries e
      join portal_members m on m.id = e.member_id
      where e.id = ${entryId}
    `;
    const entry = rows[0];
    if (!entry || (!member.is_national_admin && entry.school_id !== member.school_id)) return json(res, 404, { error: "Formation introuvable." });
    const updated = await db`
      update portal_training_entries
      set validation_status = ${decision},
          hours = ${decision === "validated" ? hours : entry.hours},
          validated_by = ${decision === "validated" ? member.id : null},
          validated_at = ${decision === "validated" ? new Date() : null},
          updated_at = now()
      where id = ${entryId}
      returning *
    `;
    return json(res, 200, { entry: updated[0] });
  }
  if (body.action === "trainer_profile") {
    const canEditTrainerProfile = member.is_national_admin || trainerRows[0]?.certification_status === "verified";
    if (!canEditTrainerProfile) return json(res, 403, { error: "La fiche Formateur est réservée aux formateurs homologués et aux responsables de formation." });
    const domains = jsonArrayInput(body.expertiseDomains);
    const oathText = String(body.oathText || "").trim().slice(0, 3000) || null;
    const otherActivity = String(body.otherActivity || "").trim().slice(0, 2000) || null;
    const rows = await db`
      insert into portal_trainer_profiles (member_id, expertise_domains, oath_text, other_activity)
      values (${member.id}, ${JSON.stringify(domains)}::jsonb, ${oathText}, ${otherActivity})
      on conflict (member_id) do update set expertise_domains = excluded.expertise_domains, oath_text = excluded.oath_text, other_activity = excluded.other_activity, updated_at = now()
      returning *
    `;
    await db`update portal_members set formateur_track = true where id = ${member.id}`;
    return json(res, 200, { trainerProfile: rows[0] });
  }
  if (body.action === "award") {
    const canEditAwards = member.is_national_admin || trainerRows[0]?.certification_status === "verified";
    if (!canEditAwards) return json(res, 403, { error: "Les distinctions sont ajoutées par le parcours de validation prévu par l’association." });
    const title = String(body.title || "").trim().slice(0, 200);
    if (!title) return json(res, 400, { error: "Intitulé de distinction requis." });
    let evidenceId = body.evidenceDocumentId ? String(body.evidenceDocumentId) : null;
    if (evidenceId) {
      const evidence = await db`select id from portal_member_documents where id = ${evidenceId} and member_id = ${member.id}`;
      if (!evidence[0]) return json(res, 400, { error: "Justificatif invalide." });
    }
    const rows = await db`
      insert into portal_member_awards (member_id, title, issuer, awarded_on, value_tag, description, evidence_document_id, visibility)
      values (${member.id}, ${title}, ${body.issuer || null}, ${body.awardedOn || null}, ${body.valueTag || null}, ${body.description || null}, ${evidenceId}, 'active_members')
      returning *
    `;
    return json(res, 201, { award: rows[0] });
  }
  if (!body.title) return json(res, 400, { error: "Catégorie et titre requis." });
  const category = String(body.category || "").trim();
  if (!canEditOfficialTraining && !MEMBER_TRAINING_CATEGORIES.includes(category)) return json(res, 400, { error: "Choisis une des sept formations officielles du parcours YOUTHCLUBber." });
  if (!canEditOfficialTraining && body.hours !== "" && body.hours != null) return json(res, 403, { error: "Une participation membre est enregistrée sans heures officielles. Les heures sont saisies et validées par le responsable de formation." });
  const hours = canEditOfficialTraining && body.hours !== "" && body.hours != null ? Number(body.hours) : null;
  if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 10000)) return json(res, 400, { error: "Nombre d'heures invalide." });
  let evidenceId = body.evidenceDocumentId ? String(body.evidenceDocumentId) : null;
  if (evidenceId) {
    const evidence = await db`select id from portal_member_documents where id = ${evidenceId} and member_id = ${member.id}`;
    if (!evidence[0]) return json(res, 400, { error: "Justificatif invalide." });
  }
  const rows = await db`
    insert into portal_training_entries (member_id, category, title, host, held_on, location, booklet_url, hours, notes, evidence_document_id)
    values (${member.id}, ${category}, ${String(body.title).trim()}, ${body.host || null}, ${body.heldOn || null}, ${body.location || null}, ${body.bookletUrl || null}, ${hours}, ${body.notes || null}, ${evidenceId})
    returning *
  `;
  return json(res, 201, { entry: rows[0] });
}

const FORMATION_CATEGORIES = ["niveau_youthclubeur"];
const FORMATION_CATEGORY_LABELS = { niveau_youthclubeur: "Niveau YOUTHCLUBeur" };

// VPI schedules a formation session (category dropdown, currently just
// "Niveau YOUTHCLUBeur" — FORMATION_CATEGORIES is the single source of
// truth so adding more official formations later is a one-line change) ->
// every verified formateur sees it as a pending request -> whichever one
// accepts first claims it and the session opens up to club members for
// sign-up, capped at session.capacity. The accepting formateur can also
// save their own phase breakdown for how they'll run that session.
async function formationSessions(req, res, member, body) {
  const db = sql();
  const access = await getMemberPortalAccess(member);
  const trainerRows = await db`select certification_status from portal_trainer_profiles where member_id = ${member.id} limit 1`;
  const isVerifiedTrainer = member.is_national_admin || trainerRows[0]?.certification_status === "verified";

  if (req.method === "GET") {
    const schoolId = schoolScope(member, req.query?.schoolId);
    const [mySchoolSessions, pendingForTrainers, myAcceptedSessions] = await Promise.all([
      // Sessions for the member's own club, at whatever stage they're in —
      // this is what a VPI or a regular member browsing sign-ups sees.
      schoolId
        ? db`
            select s.*, sc.name as school_name, req.display_name as requested_by_name, acc.display_name as accepted_by_name,
              (select count(*)::int from portal_formation_signups sg where sg.session_id = s.id) as signup_count,
              exists(select 1 from portal_formation_signups sg where sg.session_id = s.id and sg.member_id = ${member.id}) as is_signed_up
            from portal_formation_sessions s
            join portal_schools sc on sc.id = s.school_id
            join portal_members req on req.id = s.requested_by
            left join portal_members acc on acc.id = s.accepted_by
            where s.school_id = ${schoolId} and s.status != 'cancelled'
            order by s.created_at desc
          `
        : [],
      // Every still-'requested' session across all clubs, visible to any
      // verified formateur who hasn't already declined it — this is the
      // "request sent to all formateurs" inbox.
      isVerifiedTrainer
        ? db`
            select s.*, sc.name as school_name, req.display_name as requested_by_name
            from portal_formation_sessions s
            join portal_schools sc on sc.id = s.school_id
            join portal_members req on req.id = s.requested_by
            where s.status = 'requested'
              and not exists(select 1 from portal_formation_session_declines d where d.session_id = s.id and d.member_id = ${member.id})
            order by s.created_at asc
          `
        : [],
      // Sessions this formateur personally accepted, wherever the club —
      // this is where they manage phases regardless of their own club_id.
      isVerifiedTrainer
        ? db`
            select s.*, sc.name as school_name,
              (select count(*)::int from portal_formation_signups sg where sg.session_id = s.id) as signup_count
            from portal_formation_sessions s
            join portal_schools sc on sc.id = s.school_id
            where s.accepted_by = ${member.id} and s.status in ('open', 'completed')
            order by s.proposed_date asc
          `
        : [],
    ]);
    let phasesBySession = {};
    let signupsBySession = {};
    const sessionIds = [...new Set([...mySchoolSessions, ...myAcceptedSessions].map(s => s.id))];
    if (sessionIds.length) {
      const phaseRows = await db`select * from portal_formation_phases where session_id = any(${sessionIds}) order by session_id, position`;
      for (const row of phaseRows) (phasesBySession[row.session_id] ||= []).push(row);
      // Signup rosters are only worth returning to whoever can act on them
      // (the accepting formateur, or a club officer / national admin) —
      // members browsing just need signup_count, already selected above.
      const canSeeRosters = isVerifiedTrainer || member.is_national_admin || Boolean(await getCurrentDisplayRole(member.id, member.school_id));
      if (canSeeRosters) {
        const signupRows = await db`
          select sg.*, m.display_name, m.username
          from portal_formation_signups sg join portal_members m on m.id = sg.member_id
          where sg.session_id = any(${sessionIds})
          order by sg.signed_up_at asc
        `;
        for (const row of signupRows) (signupsBySession[row.session_id] ||= []).push(row);
      }
    }
    return json(res, 200, {
      categories: FORMATION_CATEGORIES.map(value => ({ value, label: FORMATION_CATEGORY_LABELS[value] })),
      mySchoolSessions,
      pendingForTrainers,
      myAcceptedSessions,
      phasesBySession,
      signupsBySession,
      access: { isVerifiedTrainer },
    });
  }

  if (body.action === "schedule") {
    // VPI (or national admin) picks a category + date; the request starts
    // life visible to every verified formateur, not assigned to anyone yet.
    const schoolId = schoolScope(member, body.schoolId);
    if (!schoolId) return json(res, 400, { error: "Club invalide." });
    const role = member.is_national_admin ? null : await getCurrentDisplayRole(member.id, schoolId);
    if (!member.is_national_admin && role?.role !== "vpi") return json(res, 403, { error: "Réservé au VPI du club (ou à l'administration nationale)." });
    const category = FORMATION_CATEGORIES.includes(body.category) ? body.category : null;
    if (!category) return json(res, 400, { error: "Choisis une formation officielle dans la liste." });
    const proposedDate = String(body.proposedDate || "").trim();
    if (!proposedDate) return json(res, 400, { error: "Date proposée requise." });
    const capacity = Number.isFinite(Number(body.capacity)) && Number(body.capacity) > 0 ? Math.min(500, Math.floor(Number(body.capacity))) : 20;
    const rows = await db`
      insert into portal_formation_sessions (school_id, category, requested_by, proposed_date, location, notes, capacity)
      values (${schoolId}, ${category}, ${member.id}, ${proposedDate}, ${clip(body.location, 200)}, ${clip(body.notes, 2000)}, ${capacity})
      returning *
    `;
    await recordAudit(db, { actorId: member.id, action: "formation.session.scheduled", entityType: "formation_session", entityId: rows[0].id, afterData: rows[0] });
    return json(res, 201, { session: rows[0] });
  }

  if (body.action === "accept") {
    // First formateur to accept claims it; a second acceptance attempt
    // fails cleanly once status has moved off 'requested'.
    if (!isVerifiedTrainer) return json(res, 403, { error: "Réservé aux formateurs homologués." });
    const rows = await db`
      update portal_formation_sessions
      set status = 'open', accepted_by = ${member.id}, accepted_at = now(), updated_at = now()
      where id = ${body.sessionId} and status = 'requested'
      returning *
    `;
    if (!rows[0]) return json(res, 409, { error: "Cette session a déjà été acceptée, annulée ou n'existe plus." });
    await recordAudit(db, { actorId: member.id, action: "formation.session.accepted", entityType: "formation_session", entityId: rows[0].id, afterData: rows[0] });
    return json(res, 200, { session: rows[0] });
  }

  if (body.action === "decline") {
    if (!isVerifiedTrainer) return json(res, 403, { error: "Réservé aux formateurs homologués." });
    await db`insert into portal_formation_session_declines (session_id, member_id) values (${body.sessionId}, ${member.id}) on conflict do nothing`;
    return json(res, 200, { ok: true });
  }

  if (body.action === "cancel") {
    const rows = await db`select * from portal_formation_sessions where id = ${body.sessionId}`;
    const session = rows[0];
    if (!session) return json(res, 404, { error: "Session introuvable." });
    const role = member.is_national_admin ? null : await getCurrentDisplayRole(member.id, session.school_id);
    const allowed = member.is_national_admin || session.requested_by === member.id || session.accepted_by === member.id || role?.role === "vpi";
    if (!allowed) return json(res, 403, { error: "Vous n'avez pas la permission d'annuler cette session." });
    const updated = await db`update portal_formation_sessions set status = 'cancelled', updated_at = now() where id = ${body.sessionId} returning *`;
    await recordAudit(db, { actorId: member.id, action: "formation.session.cancelled", entityType: "formation_session", entityId: body.sessionId, beforeData: session });
    return json(res, 200, { session: updated[0] });
  }

  if (body.action === "signup") {
    // Open to any active member for the session's own club; capacity is
    // enforced here since Postgres has no built-in "max N rows" constraint.
    const rows = await db`select * from portal_formation_sessions where id = ${body.sessionId}`;
    const session = rows[0];
    if (!session || session.status !== "open") return json(res, 400, { error: "Cette session n'est pas ouverte aux inscriptions." });
    if (!member.is_national_admin && member.school_id !== session.school_id) return json(res, 403, { error: "Cette session est réservée aux membres du club organisateur." });
    const countRows = await db`select count(*)::int as n from portal_formation_signups where session_id = ${body.sessionId}`;
    if (countRows[0].n >= session.capacity) return json(res, 400, { error: "Cette session a atteint sa capacité maximale." });
    const inserted = await db`
      insert into portal_formation_signups (session_id, member_id) values (${body.sessionId}, ${member.id})
      on conflict (session_id, member_id) do nothing
      returning *
    `;
    if (!inserted[0]) return json(res, 200, { alreadySignedUp: true });
    return json(res, 201, { signup: inserted[0] });
  }

  if (body.action === "cancel_signup") {
    await db`delete from portal_formation_signups where session_id = ${body.sessionId} and member_id = ${member.id}`;
    return json(res, 200, { ok: true });
  }

  if (body.action === "phases") {
    // Only the formateur who actually accepted this session may save its
    // phase breakdown — everyone presents the same official formation
    // differently, so this is intentionally per-session, not shared.
    const rows = await db`select * from portal_formation_sessions where id = ${body.sessionId}`;
    const session = rows[0];
    if (!session) return json(res, 404, { error: "Session introuvable." });
    if (!member.is_national_admin && session.accepted_by !== member.id) return json(res, 403, { error: "Seul le formateur qui a accepté cette session peut en modifier les phases." });
    const phases = Array.isArray(body.phases) ? body.phases : [];
    await db`delete from portal_formation_phases where session_id = ${body.sessionId}`;
    const saved = [];
    for (const [index, phase] of phases.entries()) {
      const title = String(phase?.title || "").trim().slice(0, 200);
      if (!title) continue;
      const inserted = await db`
        insert into portal_formation_phases (session_id, position, title, body, duration_text, created_by)
        values (${body.sessionId}, ${index}, ${title}, ${clip(phase?.body, 4000)}, ${clip(phase?.durationText, 60)}, ${member.id})
        returning *
      `;
      saved.push(inserted[0]);
    }
    return json(res, 200, { phases: saved });
  }

  if (body.action === "complete") {
    // Closing a session is also where "validating each member's formation"
    // actually happens: every member who signed up gets a validated
    // portal_training_entries row for this exact session (real category,
    // date, host = accepting formateur), which is what the certificate
    // generator on the Formation page reads from — instead of a formateur
    // hand-typing a duplicate "training" entry disconnected from who
    // actually attended.
    const rows = await db`select * from portal_formation_sessions where id = ${body.sessionId}`;
    const session = rows[0];
    if (!session) return json(res, 404, { error: "Session introuvable." });
    if (!member.is_national_admin && session.accepted_by !== member.id) return json(res, 403, { error: "Seul le formateur qui a accepté cette session peut la clôturer." });
    const formateurRows = await db`select display_name from portal_members where id = ${session.accepted_by}`;
    const signups = await db`select member_id, attendance_status from portal_formation_signups where session_id = ${body.sessionId}`;
    const attendedMemberIds = new Set((Array.isArray(body.attendedMemberIds) ? body.attendedMemberIds : signups.map(s => s.member_id)).map(String));
    for (const signup of signups) {
      const attended = attendedMemberIds.has(String(signup.member_id));
      await db`update portal_formation_signups set attendance_status = ${attended ? "attended" : "no_show"} where session_id = ${body.sessionId} and member_id = ${signup.member_id}`;
      if (!attended) continue;
      await db`
        insert into portal_training_entries (member_id, category, title, host, held_on, location, hours, validation_status, validated_by, validated_at, notes)
        values (${signup.member_id}, ${session.category}, ${FORMATION_CATEGORY_LABELS[session.category] || session.category}, ${formateurRows[0]?.display_name || null}, ${session.proposed_date}, ${session.location}, null, 'validated', ${session.accepted_by}, now(), ${'Session de formation #' + session.id})
      `;
    }
    const updated = await db`update portal_formation_sessions set status = 'completed', updated_at = now() where id = ${body.sessionId} returning *`;
    return json(res, 200, { session: updated[0] });
  }

  return json(res, 400, { error: "Action de formation inconnue." });
}

async function tasks(req, res, member, body) {
  const db = sql();
  if (req.method === 'GET') {
    if (req.query?.scope === 'club') {
      const schoolId = schoolScope(member, req.query?.schoolId);
      if (!schoolId) return json(res, 200, { tasks: [] });
      if (!(await requireClubCapability(req, res, member, 'project_manager', schoolId))) return;
      const rows = await db`select t.*, p.title as project_title, m.display_name as assignee_name
        from portal_tasks t
        left join portal_projects p on p.id=t.project_id
        left join portal_members m on m.id=t.assigned_to
        where t.school_id=${schoolId}
        order by t.deadline nulls last, t.assigned_at desc`;
      return json(res, 200, { tasks: rows });
    }
    const rows = await db`select t.*, p.title as project_title, s.name as school_name
      from portal_tasks t
      left join portal_projects p on p.id=t.project_id
      left join portal_schools s on s.id=t.school_id
      where t.assigned_to=${member.id}
      order by t.deadline nulls last, t.assigned_at desc`;
    return json(res, 200, { tasks: rows });
  }

  if (body.action === 'status') {
    const status = ['a_faire', 'soumis', 'executee', 'hors_delai'].includes(body.status) ? body.status : 'a_faire';
    const rows = await db`update portal_tasks set status=${status}, submission_note=${body.submissionNote || null}, updated_at=now() where id=${body.taskId} and assigned_to=${member.id} returning *`;
    return json(res, rows[0] ? 200 : 404, rows[0] ? { task: rows[0] } : { error: 'Tâche introuvable.' });
  }

  if (!body.title) return json(res, 400, { error: 'Titre requis.' });
  const schoolId = schoolScope(member, body.schoolId);
  if (!schoolId) return json(res, 400, { error: 'Club invalide.' });
  const assignedTo = String(body.assignedTo || member.id);
  const projectId = body.projectId || null;
  if (!projectId) return json(res, 400, { error: 'Une tâche de projet doit être rattachée à un projet.' });
  const project = await getProjectForMember(db, member, projectId);
  if (!project) return json(res, 404, { error: 'Projet introuvable.' });

  // Supervisors assign tasks to members of their own team; the project
  // president may also manage the project. National project membership is
  // intentionally cross-club, while local projects stay club-scoped.
  const teamRows = await db`select t.id, t.supervisor_id
    from portal_project_teams t
    join portal_project_team_members tm on tm.team_id=t.id
    where t.project_id=${project.id} and tm.member_id=${assignedTo}`;
  if (!teamRows.length) return json(res, 400, { error: 'Le membre assigné doit appartenir à une équipe de ce projet.' });
  if (member.is_national_admin || project.president_id === member.id) {
    // allowed
  } else if (!teamRows.some(team => team.supervisor_id === member.id)) {
    return json(res, 403, { error: 'Seul le superviseur de l’équipe peut assigner une tâche à ce membre.' });
  }
  if (project.scope === 'local') {
    const assigneeRows = await db`select id from portal_members where id=${assignedTo} and status='active' and school_id=${project.school_id}`;
    if (!assigneeRows[0]) return json(res, 400, { error: 'Membre assigné invalide pour ce projet local.' });
  } else {
    const assigneeRows = await db`select id from portal_members where id=${assignedTo} and status='active'`;
    if (!assigneeRows[0]) return json(res, 400, { error: 'Membre assigné invalide.' });
  }
  const priority = ['basse','normale','haute','urgente'].includes(body.priority) ? body.priority : 'normale';
  const rows = await db`insert into portal_tasks (school_id, assigned_to, project_id, title, description, priority, deadline, comments, created_by)
    values (${project.school_id}, ${assignedTo}, ${project.id}, ${String(body.title).trim()}, ${body.description || null}, ${priority}, ${body.deadline || null}, ${body.comments || null}, ${member.id})
    returning *`;
  await recordAudit(db, { actorId: member.id, action: 'task.created', entityType: 'task', entityId: rows[0].id, afterData: rows[0] });
  return json(res, 201, { task: rows[0] });
}

async function responsibilities(req, res, member, body) {
  const db = sql();
  if (req.method === "GET") return json(res, 200, { responsibilities: await db`select r.*, s.name as school_name from portal_responsibilities r left join portal_schools s on s.id=r.school_id where r.member_id=${member.id} order by r.held_on desc nulls last, r.created_at desc` });
  const role = member.school_id ? await getCurrentDisplayRole(member.id, member.school_id) : null;
  const canProposeResponsibility = Boolean(member.is_national_admin || role || await hasCapability(member.id, member.school_id, "project_manager"));
  if (!canProposeResponsibility) return json(res, 403, { error: "Les responsabilités officielles sont proposées par les responsables désignés." });
  if (!body.title) return json(res, 400, { error: "Titre requis." });
  const rows = await db`insert into portal_responsibilities (member_id, school_id, title, description, project_url, database_url, held_on, status) values (${member.id}, ${member.school_id}, ${String(body.title).trim()}, ${body.description || null}, ${body.projectUrl || null}, ${body.databaseUrl || null}, ${body.heldOn || null}, 'proposed') returning *`;
  return json(res, 201, { responsibility: rows[0] });
}

const ASSEMBLY_TYPES = ["alofm", "ale", "aloe", "agomm", "agofm", "age"];
const ASSEMBLY_LABELS = { alofm: "ALOFM", ale: "ALE", aloe: "ALOE", agomm: "AGOMM", agofm: "AGOFM", age: "AGE" };
const NATIONAL_ASSEMBLY_TYPES = new Set(["agomm", "agofm", "age"]);
const ELIGIBLE_MEMBER_STATUSES = new Set(["adherent", "responsable"]);

function majorityOutcome(forVotes, againstVotes, abstentions, majorityType) {
  const yes = Math.max(0, Number(forVotes) || 0);
  const no = Math.max(0, Number(againstVotes) || 0);
  const abstain = Math.max(0, Number(abstentions) || 0);
  if (yes === no && yes > 0) return "tie";
  if (majorityType === "absolute") return yes > (yes + no + abstain) / 2 ? "adopted" : "rejected";
  if (majorityType === "two_thirds") return yes >= (2 * no) && yes > 0 ? "adopted" : "rejected";
  if (majorityType === "relative") return yes > no ? "adopted" : "rejected";
  return yes > no ? "adopted" : "rejected";
}

async function recordAudit(db, { actorId, action, entityType, entityId, beforeData, afterData }) {
  await db`
    insert into portal_audit_events (actor_id, action, entity_type, entity_id, before_data, after_data)
    values (${actorId || null}, ${action}, ${entityType}, ${entityId || null}, ${beforeData ? JSON.stringify(beforeData) : null}::jsonb, ${afterData ? JSON.stringify(afterData) : null}::jsonb)
  `;
}

function assemblyMotionSeed(assemblyType) {
  const opening = [
    "Présentation du rapport préliminaire du CSCY",
    "Adoption du rapport préliminaire du CSCY",
    "Présentation de l’agenda",
    "Adoption de l’agenda",
    "Adoption du PV de la dernière Assemblée",
  ];
  const closing = [
    "Présentation du rapport final du CSCY",
    "Adoption du rapport final du CSCY",
    "Clôture de l’Assemblée",
  ];
  return [...opening, `Délibérations de l’${ASSEMBLY_LABELS[assemblyType] || "assemblée"}`, ...closing];
}

async function assemblies(req, res, member, body) {
  const db = sql();
  if (req.method === "GET") {
    const requested = req.query?.schoolId;
    const schoolId = schoolScope(member, requested);
    const rows = member.is_national_admin && !requested
      ? await db`
          select a.*, m.title, m.starts_at, m.ends_at, m.format, m.location, s.name as school_name,
            coalesce((select json_agg(json_build_object('memberId', ar.member_id, 'role', ar.role)) from portal_assembly_roles ar where ar.assembly_id = a.id), '[]'::json) as roles,
            (select count(*)::int from portal_assembly_attendance aa where aa.assembly_id = a.id and aa.attendance_status in ('present','late')) as present_count
          from portal_assemblies a join portal_meetings m on m.id = a.meeting_id left join portal_schools s on s.id = a.school_id
          order by m.starts_at desc
        `
      : !schoolId ? [] : await db`
          select a.*, m.title, m.starts_at, m.ends_at, m.format, m.location, s.name as school_name,
            coalesce((select json_agg(json_build_object('memberId', ar.member_id, 'role', ar.role)) from portal_assembly_roles ar where ar.assembly_id = a.id), '[]'::json) as roles,
            (select count(*)::int from portal_assembly_attendance aa where aa.assembly_id = a.id and aa.attendance_status in ('present','late')) as present_count
          from portal_assemblies a join portal_meetings m on m.id = a.meeting_id left join portal_schools s on s.id = a.school_id
          where a.school_id = ${schoolId}
          order by m.starts_at desc
        `;
    return json(res, 200, { assemblies: rows.map(row => ({ ...row, assembly_label: ASSEMBLY_LABELS[row.assembly_type] || row.assembly_type })) });
  }
  if (body.action !== "create") return json(res, 400, { error: "Action d’assemblée inconnue." });
  const schoolId = schoolScope(member, body.schoolId);
  if (!schoolId) return json(res, 400, { error: "Club invalide." });
  if (!(await requireClubCapability(req, res, member, "meeting_organizer", schoolId))) return;
  const assemblyType = String(body.assemblyType || "");
  if (!ASSEMBLY_TYPES.includes(assemblyType)) return json(res, 400, { error: "Type d’assemblée invalide." });
  // A club's "Organisateur de réunions" (meeting_organizer capability)
  // only ever acts within their own club, so they can only ever prepare
  // local assemblies (ALOFM/ALE/ALOE) — never a national AGOMM/AGOFM/AGE.
  // Only national admins can create those. This is enforced here rather
  // than just hidden in the <select>, since the option list is
  // client-side and this endpoint is the actual authority boundary.
  if (NATIONAL_ASSEMBLY_TYPES.has(assemblyType) && !member.is_national_admin) {
    return json(res, 403, { error: "Seule l’administration nationale peut préparer une assemblée générale nationale (AGOMM/AGOFM/AGE)." });
  }
  const title = String(body.title || ASSEMBLY_LABELS[assemblyType]).trim();
  const startsAt = String(body.startsAt || "").trim();
  if (!title || !startsAt) return json(res, 400, { error: "Titre et date requis." });
  const scope = NATIONAL_ASSEMBLY_TYPES.has(assemblyType) ? "national" : "local";
  const meetingType = scope === "national" ? "assemblee_generale" : "assemblee_locale";
  const memberRows = scope === "local"
    ? await db`select id, display_name, username, membership_status from portal_members where school_id = ${schoolId} and status = 'active' order by display_name`
    : await db`select id, display_name, username, membership_status from portal_members where status = 'active' order by display_name`;
  const eligible = memberRows.filter(row => ELIGIBLE_MEMBER_STATUSES.has(row.membership_status));
  const memberSnapshot = memberRows.map(row => ({ memberId: row.id, displayName: row.display_name, username: row.username, membershipStatus: row.membership_status, votingRights: ELIGIBLE_MEMBER_STATUSES.has(row.membership_status) }));
  const quorumRequired = scope === "local" ? Math.max(1, Math.ceil(memberRows.length / 3)) : 0;
  const meetingRows = await db`
    insert into portal_meetings (school_id, created_by, title, meeting_type, starts_at, ends_at, format, location, maps_url, comments, agenda, status)
    values (${schoolId}, ${member.id}, ${title}, ${meetingType}, ${startsAt}, ${body.endsAt || null}, ${["presentiel", "en_ligne", "hybride"].includes(body.format) ? body.format : "presentiel"}, ${body.location || null}, ${body.mapsUrl || null}, ${body.comments || null}, ${JSON.stringify(assemblyMotionSeed(assemblyType).map((item, position) => ({ position, title: item })))}::jsonb, 'planned')
    returning *
  `;
  const meeting = meetingRows[0];
  const editors = Array.isArray(body.editors)
    ? body.editors.filter(e => e && String(e.name || "").trim()).map(e => ({ name: String(e.name).trim().slice(0, 200), club: String(e.club || "").trim().slice(0, 200) }))
    : [];
  const assemblyRows = await db`
    insert into portal_assemblies (meeting_id, school_id, assembly_type, scope, status, member_snapshot_count, quorum_required, eligible_voter_count, voter_snapshot, project_url, database_url, created_by, adoption_state, editors)
    values (${meeting.id}, ${schoolId}, ${assemblyType}, ${scope}, 'planned', ${memberRows.length}, ${quorumRequired}, ${eligible.length}, ${JSON.stringify(memberSnapshot)}::jsonb, ${body.projectUrl || null}, ${body.databaseUrl || null}, ${member.id}, 'draft', ${JSON.stringify(editors)}::jsonb)
    returning *
  `;
  const assembly = assemblyRows[0];
  const motionSeed = assemblyMotionSeed(assemblyType);
  const seedStatements = [
    ...memberRows.map(row => db`insert into portal_assembly_attendance (assembly_id, member_id, attendance_status, voting_rights, eligibility_basis, assigned_by) values (${assembly.id}, ${row.id}, 'invited', ${ELIGIBLE_MEMBER_STATUSES.has(row.membership_status)}, ${row.membership_status}, ${member.id}) on conflict (assembly_id, member_id) do nothing`),
    ...motionSeed.map((motionTitle, position) => db`insert into portal_assembly_motions (assembly_id, position, motion_type, title, majority_type, required_motion) values (${assembly.id}, ${position}, ${position < 5 || position >= motionSeed.length - 3 ? "procedural" : "decision"}, ${motionTitle}, 'simple', ${position < 5 || position >= motionSeed.length - 3})`),
  ];
  if (seedStatements.length) await db.transaction(seedStatements);
  // National AGs list every active CLUB as an attendee row (Présent/Absent
  // + Votant/Non votant, defaulting to Absent/Non votant), matching the
  // paper attendance sheet — separate from the per-member roster above,
  // which still covers the EPN/BEN individuals.
  if (scope === "national") {
    const allSchools = await db`select id from portal_schools where is_active = true`;
    const clubStatements = [
      ...allSchools.map(school => db`insert into portal_assembly_club_attendance (assembly_id, school_id, attendance_status, voting_status, assigned_by) values (${assembly.id}, ${school.id}, 'absent', 'non_votant', ${member.id}) on conflict (assembly_id, school_id) do nothing`),
      // National AGs run across several plénières on the paper PV ("La
      // première plénière", "Plénière 2", ...) — seed the first one so
      // there's somewhere for the opening motions to attach right away.
      db`insert into portal_assembly_plenaries (assembly_id, position, label) values (${assembly.id}, 0, 'Plénière 1') on conflict (assembly_id, position) do nothing`,
    ];
    await db.transaction(clubStatements);
  }
  await recordAudit(db, { actorId: member.id, action: "assembly.created", entityType: "assembly", entityId: assembly.id, afterData: { assemblyType, scope, memberSnapshotCount: memberRows.length, quorumRequired } });
  return json(res, 201, { assembly, meeting });
}

async function assemblyDetail(req, res, member, body) {
  const id = String(body.assemblyId || req.query?.assemblyId || "");
  if (!id) return json(res, 400, { error: "Assemblée introuvable." });
  const db = sql();
  const assemblyRows = await db`select a.*, m.title, m.starts_at, m.ends_at, m.format, m.location, m.comments, s.name as school_name from portal_assemblies a join portal_meetings m on m.id = a.meeting_id left join portal_schools s on s.id = a.school_id where a.id = ${id}`;
  const assembly = assemblyRows[0];
  if (!assembly || (!member.is_national_admin && assembly.school_id !== member.school_id)) return json(res, 404, { error: "Assemblée introuvable." });
  const access = await getMemberPortalAccess(member);
  const isEplSecretaryLive = assembly.scope === "local" && (member.is_national_admin || await hasEplRole(member.id, assembly.school_id, "epl_secretaire"));
  const canEditPV = Boolean(member.is_national_admin || access.canEditPV || (assembly.scope === "national" && access.isNationalSecretary) || isEplSecretaryLive);
  // Backfill club-attendance rows for national AGs created before this
  // feature existed, or for clubs added after the AG was created — keeps
  // "always show all active clubs" true without a one-off migration.
  if (assembly.scope === "national") {
    await db`
      insert into portal_assembly_club_attendance (assembly_id, school_id, attendance_status, voting_status, assigned_by)
      select ${id}, s.id, 'absent', 'non_votant', ${member.id}
      from portal_schools s
      where s.is_active = true
      on conflict (assembly_id, school_id) do nothing
    `;
    // Same backfill idea for the BEN·SupCo / CNS / formateurs / membres
    // nationaux rosters — each gets its own Présent/Absent (and, except
    // formateurs, Votant/Non votant) row scoped to this assembly.
    await db`
      insert into portal_assembly_roster_presence (assembly_id, member_id, roster, attendance_status, voting_status, assigned_by)
      select ${id}, r.member_id, 'ben', 'absent', 'non_votant', ${member.id}
      from portal_national_roles r
      where r.role = any(${BEN_ROSTER_ROLES}) and r.ended_at is null
      on conflict (assembly_id, member_id, roster) do nothing
    `;
    await db`
      insert into portal_assembly_roster_presence (assembly_id, member_id, roster, attendance_status, voting_status, assigned_by)
      select ${id}, m.id, 'cns', 'absent', 'non_votant', ${member.id}
      from portal_members m
      where m.status = 'active' and m.membership_status = 'senior'
      on conflict (assembly_id, member_id, roster) do nothing
    `;
    await db`
      insert into portal_assembly_roster_presence (assembly_id, member_id, roster, attendance_status, voting_status, assigned_by)
      select ${id}, m.id, 'formateurs', 'absent', 'non_votant', ${member.id}
      from portal_members m join portal_trainer_profiles t on t.member_id = m.id
      where m.status = 'active' and t.certification_status = 'verified'
      on conflict (assembly_id, member_id, roster) do nothing
    `;
    await db`
      insert into portal_assembly_roster_presence (assembly_id, member_id, roster, attendance_status, voting_status, assigned_by)
      select ${id}, m.id, 'membres_nationaux', 'absent', 'non_votant', ${member.id}
      from portal_members m
      where m.status = 'active' and m.membership_status = 'membre_national'
      on conflict (assembly_id, member_id, roster) do nothing
    `;
  }
  const [attendance, roles, motions, elections, minutes, clubAttendance, epnMembers, eplMembers, plenaries, piBoxes, groundRulesRows, movements, benRoster, cnsMembers, formateurs, membresNationaux, rosterPresenceRows] = await Promise.all([
    db`select a.*, m.display_name, m.username, m.membership_status from portal_assembly_attendance a join portal_members m on m.id = a.member_id where a.assembly_id = ${id} order by m.display_name`,
    db`select ar.*, m.display_name, m.username from portal_assembly_roles ar join portal_members m on m.id = ar.member_id where ar.assembly_id = ${id} order by m.display_name`,
    db`select * from portal_assembly_motions where assembly_id = ${id} order by position`,
    db`select * from portal_elections where assembly_id = ${id} order by created_at`,
    canEditPV
      ? db`select * from portal_minutes where meeting_id = ${assembly.meeting_id}`
      : db`select * from portal_minutes where meeting_id = ${assembly.meeting_id} and status in ('sent', 'validated')`,
    assembly.scope === "national"
      ? db`select ca.*, s.name as school_name, s.slug as school_slug, s.club_status from portal_assembly_club_attendance ca join portal_schools s on s.id = ca.school_id where ca.assembly_id = ${id} order by s.name asc`
      : Promise.resolve([]),
    assembly.scope === "national"
      ? db`
          select m.id, m.display_name, m.username, m.profile_picture_url,
            array_agg(r.role order by r.started_at asc) as epn_roles,
            coalesce((select r2.role from portal_national_roles r2 where r2.member_id = m.id and r2.role = 'secretaire_national' and r2.ended_at is null limit 1) is not null, false) as is_national_secretary
          from portal_national_roles r
          join portal_members m on m.id = r.member_id
          where r.role = any(${EPN_ROLES}) and r.ended_at is null and m.status = 'active'
          group by m.id, m.display_name, m.username, m.profile_picture_url
          order by m.display_name asc
        `
      : Promise.resolve([]),
    // Équipe Plénière Locale — the presiding team for THIS club's local
    // assembly, drawn from members of OTHER clubs (see setEplMember).
    // Mirrors the EPN query above, just scoped to assembly.school_id.
    assembly.scope === "local"
      ? db`
          select m.id, m.display_name, m.username, m.profile_picture_url, s.name as home_school_name,
            array_agg(r.role order by r.started_at asc) as epl_roles,
            coalesce((select r2.role from portal_epl_roles r2 where r2.member_id = m.id and r2.school_id = ${assembly.school_id} and r2.role = 'epl_secretaire' and r2.ended_at is null limit 1) is not null, false) as is_epl_secretaire
          from portal_epl_roles r
          join portal_members m on m.id = r.member_id
          left join portal_schools s on s.id = m.school_id
          where r.school_id = ${assembly.school_id} and r.role = any(${EPL_ROLES}) and r.ended_at is null and m.status = 'active'
          group by m.id, m.display_name, m.username, m.profile_picture_url, s.name
          order by m.display_name asc
        `
      : Promise.resolve([]),
    db`select * from portal_assembly_plenaries where assembly_id = ${id} order by position`,
    db`select * from portal_assembly_pi where assembly_id = ${id} order by position, created_at`,
    db`select * from portal_assembly_ground_rules where assembly_id = ${id}`,
    db`select mv.*, s.name as school_name from portal_assembly_movements mv left join portal_schools s on s.id = mv.school_id where mv.assembly_id = ${id} order by mv.created_at`,
    assembly.scope === "national" ? getBenRoster() : Promise.resolve([]),
    assembly.scope === "national"
      ? db`select id, display_name, username from portal_members where status = 'active' and membership_status = 'senior' order by display_name asc`
      : Promise.resolve([]),
    assembly.scope === "national"
      ? db`select m.id, m.display_name, m.username from portal_members m join portal_trainer_profiles t on t.member_id = m.id where m.status = 'active' and t.certification_status = 'verified' order by m.display_name asc`
      : Promise.resolve([]),
    assembly.scope === "national"
      ? db`select id, display_name, username from portal_members where status = 'active' and membership_status = 'membre_national' order by display_name asc`
      : Promise.resolve([]),
    assembly.scope === "national"
      ? db`select * from portal_assembly_roster_presence where assembly_id = ${id}`
      : Promise.resolve([]),
  ]);
  // Fold assembly-scoped presence/vote onto each roster's member rows so
  // the frontend gets one flat object per person, same shape as clubAttendance.
  const rosterPresenceByMember = new Map(rosterPresenceRows.map(row => [`${row.roster}:${row.member_id}`, row]));
  const withRosterPresence = (members, rosterKey) => (members || []).map(m => {
    const presence = rosterPresenceByMember.get(`${rosterKey}:${m.id}`);
    return { ...m, attendance_status: presence?.attendance_status || "absent", voting_status: presence?.voting_status || "non_votant" };
  });
  const benRosterWithPresence = (benRoster || []).map(row => {
    if (!row.holder) return row;
    const presence = rosterPresenceByMember.get(`ben:${row.holder.id}`);
    return { ...row, holder: { ...row.holder, attendance_status: presence?.attendance_status || "absent" } };
  });
  const cnsMembersWithPresence = withRosterPresence(cnsMembers, "cns");
  const formateursWithPresence = withRosterPresence(formateurs, "formateurs");
  const membresNationauxWithPresence = withRosterPresence(membresNationaux, "membres_nationaux");
  const groundRules = groundRulesRows[0] || { intro: "", rules: [] };
  let minutesStructured = { attendance: [], agendaBlocks: [], motions: [] };
  if (minutes[0]) {
    const [minutesAttendance, agendaBlocks, minutesMotions] = await Promise.all([
      db`select a.*, m.display_name, m.username from portal_minutes_attendance a join portal_members m on m.id = a.member_id where a.minutes_id = ${minutes[0].id} order by m.display_name`,
      db`select * from portal_minutes_agenda_blocks where minutes_id = ${minutes[0].id} order by position`,
      db`select * from portal_minutes_motions where minutes_id = ${minutes[0].id} order by position`,
    ]);
    minutesStructured = { attendance: minutesAttendance, agendaBlocks, motions: minutesMotions };
  }
  const presentCount = attendance.filter(row => ["present", "late"].includes(row.attendance_status)).length;
  const quorumMet = assembly.scope === "local" ? presentCount >= assembly.quorum_required : null;
  const epnMembersWithLabels = epnMembers.map(m => ({
    ...m,
    epn_role_labels: (m.epn_roles || []).map(role => EPN_ROLE_LABELS[role] || role),
  }));
  const eplMembersWithLabels = eplMembers.map(m => ({
    ...m,
    epl_role_labels: (m.epl_roles || []).map(role => EPL_ROLE_LABELS[role] || role),
  }));
  if (req.method === "GET" || body.action === "assembly") return json(res, 200, { assembly: { ...assembly, assembly_label: ASSEMBLY_LABELS[assembly.assembly_type] || assembly.assembly_type, present_count: presentCount, quorum_met_live: quorumMet }, attendance, roles, motions, elections, minutes: minutes[0] || null, minutesStructured, clubAttendance, epnMembers: epnMembersWithLabels, eplMembers: eplMembersWithLabels, plenaries, piBoxes, groundRules, movements, benRoster: benRosterWithPresence, cnsMembers: cnsMembersWithPresence, formateurs: formateursWithPresence, membresNationaux: membresNationauxWithPresence, canEditPV });
  if (body.action === "attendance") {
    if (!(await requireClubCapability(req, res, member, "cscy_reviewer", assembly.school_id))) return;
    const target = attendance.find(row => row.member_id === body.memberId);
    if (!target) return json(res, 404, { error: "Membre absent du relevé de l’assemblée." });
    const attendanceStatus = ["invited", "present", "absent", "excused", "late"].includes(body.attendanceStatus) ? body.attendanceStatus : "invited";
    const votingRights = Boolean(body.votingRights);
    if (votingRights && !ELIGIBLE_MEMBER_STATUSES.has(target.membership_status)) return json(res, 400, { error: "Ce statut d’adhésion ne permet pas d’attribuer un droit de vote." });
    const result = await db`update portal_assembly_attendance set attendance_status=${attendanceStatus}, voting_rights=${votingRights}, eligibility_basis=${body.eligibilityBasis || target.membership_status}, assigned_by=${member.id}, note=${body.note || null} where assembly_id=${id} and member_id=${body.memberId} returning *`;
    await recordAudit(db, { actorId: member.id, action: "assembly.attendance.updated", entityType: "assembly", entityId: id, afterData: result[0] });
    return json(res, 200, { attendance: result[0] });
  }
  if (body.action === "club_attendance") {
    if (assembly.scope !== "national") return json(res, 400, { error: "La présence par club n’existe que pour les AG nationales." });
    // Same instance that checks members in at the door (cscy_reviewer)
    // can toggle club rows, plus the national secretary since they're
    // typically the one filling in the sheet from the room.
    const allowed = member.is_national_admin
      || (await hasCapability(member.id, assembly.school_id, "cscy_reviewer"))
      || (await hasNationalRole(member.id, "secretaire_national"));
    if (!allowed) return json(res, 403, { error: "Vous n'avez pas la permission de modifier la présence des clubs." });
    const target = clubAttendance.find(row => row.school_id === Number(body.schoolId));
    if (!target) return json(res, 404, { error: "Club absent du relevé de cette assemblée." });
    const attendanceStatus = ["present", "absent"].includes(body.attendanceStatus) ? body.attendanceStatus : "absent";
    const votingStatus = ["votant", "non_votant"].includes(body.votingStatus) ? body.votingStatus : "non_votant";
    const representativeName = body.representativeName == null ? target.representative_name : String(body.representativeName).trim().slice(0, 200) || null;
    const result = await db`update portal_assembly_club_attendance set attendance_status=${attendanceStatus}, voting_status=${votingStatus}, representative_name=${representativeName}, assigned_by=${member.id}, updated_at=now() where assembly_id=${id} and school_id=${body.schoolId} returning *`;
    await recordAudit(db, { actorId: member.id, action: "assembly.club_attendance.updated", entityType: "assembly", entityId: id, afterData: result[0] });
    return json(res, 200, { clubAttendance: result[0] });
  }
  if (body.action === "roster_presence") {
    // Présent/Absent (+ Votant/Non votant, except formateurs) toggle for
    // the BEN·SupCo, CNS, formateurs, and membres nationaux rosters —
    // scoped to this assembly, same permission group as club_attendance.
    if (assembly.scope !== "national") return json(res, 400, { error: "Cette liste n'existe que pour les AG nationales." });
    const allowed = member.is_national_admin
      || (await hasCapability(member.id, assembly.school_id, "cscy_reviewer"))
      || (await hasNationalRole(member.id, "secretaire_national"));
    if (!allowed) return json(res, 403, { error: "Vous n'avez pas la permission de modifier la présence de cette liste." });
    const roster = ["ben", "cns", "formateurs", "membres_nationaux"].includes(body.roster) ? body.roster : null;
    if (!roster) return json(res, 400, { error: "Liste invalide." });
    if (!body.memberId) return json(res, 400, { error: "Membre requis." });
    const attendanceStatus = ["present", "absent"].includes(body.attendanceStatus) ? body.attendanceStatus : "absent";
    const votingStatus = ["votant", "non_votant"].includes(body.votingStatus) ? body.votingStatus : "non_votant";
    const rows = await db`
      insert into portal_assembly_roster_presence (assembly_id, member_id, roster, attendance_status, voting_status, assigned_by, updated_at)
      values (${id}, ${body.memberId}, ${roster}, ${attendanceStatus}, ${votingStatus}, ${member.id}, now())
      on conflict (assembly_id, member_id, roster) do update set attendance_status = excluded.attendance_status, voting_status = excluded.voting_status, assigned_by = excluded.assigned_by, updated_at = now()
      returning *
    `;
    await recordAudit(db, { actorId: member.id, action: "assembly.roster_presence.updated", entityType: "assembly", entityId: id, afterData: rows[0] });
    return json(res, 200, { rosterPresence: rows[0] });
  }
  if (body.action === "changement_representant") {
    // Swaps who represents a club at the AG without touching its
    // présence/vote status — same paper concept as the "Mouvement" sheet
    // but scoped to one club's seat, and it always requires the new
    // representative to be a BEL member of that same club.
    if (assembly.scope !== "national") return json(res, 400, { error: "Le changement de représentant n’existe que pour les AG nationales." });
    const allowed = member.is_national_admin
      || (await hasCapability(member.id, assembly.school_id, "cscy_reviewer"))
      || (await hasNationalRole(member.id, "secretaire_national"));
    if (!allowed) return json(res, 403, { error: "Vous n'avez pas la permission de modifier le représentant d’un club." });
    const target = clubAttendance.find(row => row.school_id === Number(body.schoolId));
    if (!target) return json(res, 404, { error: "Club absent du relevé de cette assemblée." });
    let newRepName = String(body.newRepresentativeName || "").trim();
    let newRepMemberId = null;
    if (body.memberId) {
      const belRows = await db`select m.id, m.display_name from portal_members m join portal_club_display_roles r on r.member_id = m.id where m.id = ${body.memberId} and r.school_id = ${body.schoolId} and r.ended_at is null and m.status = 'active' limit 1`;
      if (!belRows[0]) return json(res, 400, { error: "Cette personne n’est pas membre du BEL de ce club." });
      newRepMemberId = belRows[0].id;
      newRepName = belRows[0].display_name;
    }
    if (!newRepName) return json(res, 400, { error: "Nom du nouveau représentant requis." });
    const result = await db`update portal_assembly_club_attendance set representative_name=${newRepName}, assigned_by=${member.id}, updated_at=now() where assembly_id=${id} and school_id=${body.schoolId} returning *`;
    await db`insert into portal_assembly_movements (assembly_id, movement_type, member_id, display_name, status_club, school_id, previous_representative_name, occurred_at_text, created_by) values (${id}, 'changement_representant', ${newRepMemberId}, ${newRepName}, ${clip(body.statusClub, 200)}, ${body.schoolId}, ${target.representative_name || null}, ${clip(body.occurredAtText, 40) || nowText()}, ${member.id})`;
    await recordAudit(db, { actorId: member.id, action: "assembly.club_attendance.rep_changed", entityType: "assembly", entityId: id, afterData: result[0] });
    return json(res, 200, { clubAttendance: result[0] });
  }
  if (body.action === "movement") {
    // "Sortie"/"Entrée" log, exactly like the attached screenshot: name,
    // statut/club, mouvement, heure. Anyone who can edit attendance can
    // log a movement; deletion is restricted to the same group so a
    // logged departure/return can be corrected without touching the DB.
    const allowed = member.is_national_admin
      || (await hasCapability(member.id, assembly.school_id, "cscy_reviewer"))
      || (assembly.scope === "national" && (await hasNationalRole(member.id, "secretaire_national")));
    if (!allowed) return json(res, 403, { error: "Vous n'avez pas la permission d'enregistrer un mouvement." });
    const movementType = ["sortie", "entree"].includes(body.movementType) ? body.movementType : null;
    if (!movementType) return json(res, 400, { error: "Type de mouvement invalide." });
    const displayName = String(body.displayName || "").trim().slice(0, 200);
    if (!displayName) return json(res, 400, { error: "Nom et prénom requis." });
    const rows = await db`insert into portal_assembly_movements (assembly_id, movement_type, member_id, display_name, status_club, school_id, occurred_at_text, created_by) values (${id}, ${movementType}, ${body.memberId || null}, ${displayName}, ${clip(body.statusClub, 200)}, ${body.schoolId || null}, ${clip(body.occurredAtText, 40) || nowText()}, ${member.id}) returning *`;
    await recordAudit(db, { actorId: member.id, action: "assembly.movement.recorded", entityType: "assembly", entityId: id, afterData: rows[0] });
    return json(res, 200, { movement: rows[0] });
  }
  if (body.action === "delete_movement") {
    const allowed = member.is_national_admin
      || (await hasCapability(member.id, assembly.school_id, "cscy_reviewer"))
      || (assembly.scope === "national" && (await hasNationalRole(member.id, "secretaire_national")));
    if (!allowed) return json(res, 403, { error: "Vous n'avez pas la permission de supprimer ce mouvement." });
    await db`delete from portal_assembly_movements where id = ${body.movementId} and assembly_id = ${id}`;
    return json(res, 200, { ok: true });
  }
  if (body.action === "plenary") {
    if (!(await requirePvEditorForAssembly(req, res, member, assembly))) return;
    const existing = plenaries.find(row => row.id === body.plenaryId);
    const position = existing ? existing.position : plenaries.length;
    const clip2 = (value, max) => (value == null ? null : String(value).slice(0, max));
    const rows = existing
      ? await db`update portal_assembly_plenaries set label=${clip2(body.label, 200) || existing.label}, starts_at_text=${clip2(body.startsAtText, 40)}, closes_at_text=${clip2(body.closesAtText, 40)}, president_name=${clip2(body.presidentName, 200)}, vice_president_name=${clip2(body.vicePresidentName, 200)}, secretaries=${clip2(body.secretaries, 500)}, cscy_name=${clip2(body.cscyName, 200)}, cf_name=${clip2(body.cfName, 200)} where id = ${existing.id} returning *`
      : await db`insert into portal_assembly_plenaries (assembly_id, position, label, starts_at_text, closes_at_text, president_name, vice_president_name, secretaries, cscy_name, cf_name) values (${id}, ${position}, ${clip2(body.label, 200) || `Plénière ${position + 1}`}, ${clip2(body.startsAtText, 40)}, ${clip2(body.closesAtText, 40)}, ${clip2(body.presidentName, 200)}, ${clip2(body.vicePresidentName, 200)}, ${clip2(body.secretaries, 500)}, ${clip2(body.cscyName, 200)}, ${clip2(body.cfName, 200)}) returning *`;
    await recordAudit(db, { actorId: member.id, action: "assembly.plenary.saved", entityType: "assembly", entityId: id, afterData: rows[0] });
    return json(res, 200, { plenary: rows[0] });
  }
  if (body.action === "delete_plenary") {
    if (!(await requirePvEditorForAssembly(req, res, member, assembly))) return;
    await db`delete from portal_assembly_plenaries where id = ${body.plenaryId} and assembly_id = ${id}`;
    return json(res, 200, { ok: true });
  }
  if (body.action === "pi") {
    // "PI" box: proposant/intervenant callout attached to a motion (or a
    // plénière). Picking an existing member auto-fills the role label
    // from their national/club role, matching the paper "PI: <name>
    // (<role>)" boxes; typing a name freehand needs an explicit role.
    if (!(await requirePvEditorForAssembly(req, res, member, assembly))) return;
    const bodyText = String(body.body || "").trim();
    if (!bodyText) return json(res, 400, { error: "Le contenu du point d’intervention est requis." });
    let displayName = String(body.displayName || "").trim();
    let roleLabel = body.roleLabel ? String(body.roleLabel).trim().slice(0, 200) : null;
    let memberId = null;
    if (body.memberId) {
      const rows = await db`select id, display_name from portal_members where id = ${body.memberId} and status = 'active' limit 1`;
      if (!rows[0]) return json(res, 400, { error: "Membre introuvable." });
      memberId = rows[0].id;
      displayName = rows[0].display_name;
      roleLabel = await getMemberRoleLabel(memberId);
    }
    if (!displayName) return json(res, 400, { error: "Nom requis pour le point d’intervention." });
    const rows = await db`insert into portal_assembly_pi (assembly_id, motion_id, plenary_id, member_id, display_name, role_label, body, position, created_by) values (${id}, ${body.motionId || null}, ${body.plenaryId || null}, ${memberId}, ${displayName.slice(0, 200)}, ${roleLabel}, ${bodyText.slice(0, 4000)}, ${piBoxes.length}, ${member.id}) returning *`;
    await recordAudit(db, { actorId: member.id, action: "assembly.pi.added", entityType: "assembly", entityId: id, afterData: rows[0] });
    return json(res, 200, { pi: rows[0] });
  }
  if (body.action === "delete_pi") {
    if (!(await requirePvEditorForAssembly(req, res, member, assembly))) return;
    await db`delete from portal_assembly_pi where id = ${body.piId} and assembly_id = ${id}`;
    return json(res, 200, { ok: true });
  }
  if (body.action === "ground_rules") {
    if (!(await requirePvEditorForAssembly(req, res, member, assembly))) return;
    const rules = Array.isArray(body.rules) ? body.rules.map(r => String(r || "").trim()).filter(Boolean).slice(0, 100) : [];
    const rows = await db`
      insert into portal_assembly_ground_rules (assembly_id, intro, rules, updated_by, updated_at)
      values (${id}, ${String(body.intro || "").trim().slice(0, 4000) || null}, ${JSON.stringify(rules)}::jsonb, ${member.id}, now())
      on conflict (assembly_id) do update set intro = excluded.intro, rules = excluded.rules, updated_by = excluded.updated_by, updated_at = now()
      returning *
    `;
    await recordAudit(db, { actorId: member.id, action: "assembly.ground_rules.saved", entityType: "assembly", entityId: id, afterData: rows[0] });
    return json(res, 200, { groundRules: rows[0] });
  }
  if (body.action === "editors") {
    if (!(await requirePvEditorForAssembly(req, res, member, assembly))) return;
    const editors = Array.isArray(body.editors) ? body.editors.filter(e => e && String(e.name || "").trim()).map(e => ({ name: String(e.name).trim().slice(0, 200), club: String(e.club || "").trim().slice(0, 200) })) : [];
    const adoptionState = ["draft", "submitted_for_adoption", "adopted"].includes(body.adoptionState) ? body.adoptionState : assembly.adoption_state;
    const rows = await db`update portal_assemblies set editors=${JSON.stringify(editors)}::jsonb, adoption_state=${adoptionState}, updated_at=now() where id=${id} returning *`;
    await recordAudit(db, { actorId: member.id, action: "assembly.editors.saved", entityType: "assembly", entityId: id, afterData: rows[0] });
    return json(res, 200, { assembly: rows[0] });
  }
  if (body.action === "motion") {
    if (!(await requirePvEditorForAssembly(req, res, member, assembly))) return;
    const position = Number(body.position);
    const existing = motions.find(row => row.position === position);
    const majorityType = ["simple", "absolute", "relative", "two_thirds"].includes(body.majorityType) ? body.majorityType : (existing?.majority_type || "simple");
    const voteMode = body.voteMode === "manual" ? "manual" : "count";
    const votesFor = Math.max(0, Number(body.votesFor) || 0);
    const votesAgainst = Math.max(0, Number(body.votesAgainst) || 0);
    const abstentions = Math.max(0, Number(body.abstentions) || 0);
    const manualResult = ["adopted", "rejected", "tie"].includes(body.manualResult) ? body.manualResult : null;
    const resultLabel = voteMode === "manual" ? (manualResult || existing?.manual_result || null) : majorityOutcome(votesFor, votesAgainst, abstentions, majorityType);
    const motionType = String(body.motionType || existing?.motion_type || "decision");
    const requiredMotion = body.requiredMotion == null ? Boolean(existing?.required_motion) : Boolean(body.requiredMotion);
    const plenaryId = body.plenaryId === undefined ? (existing?.plenary_id || null) : (body.plenaryId || null);
    const rows = await db`
      insert into portal_assembly_motions (
        assembly_id, position, motion_type, title, majority_type, required_motion,
        votes_for, votes_against, abstentions, result, consequence,
        proposer_name, seconder_name, amendment, direct_negative, discussion,
        starts_at_text, closes_at_text, duration_text, vote_mode, manual_result, plenary_id
      )
      values (
        ${id}, ${Number.isInteger(position) && position >= 0 ? position : motions.length}, ${motionType}, ${String(body.title || "Motion").slice(0, 300)}, ${majorityType}, ${requiredMotion},
        ${votesFor}, ${votesAgainst}, ${abstentions}, ${resultLabel}, ${clip(body.consequence, 2000)},
        ${clip(body.proposerName, 200)}, ${clip(body.seconderName, 200)}, ${clip(body.amendment, 2000)}, ${clip(body.directNegative, 2000)}, ${clip(body.discussion, 4000)},
        ${clip(body.startsAtText, 40)}, ${clip(body.closesAtText, 40)}, ${clip(body.durationText, 60)}, ${voteMode}, ${manualResult}, ${plenaryId}
      )
      on conflict (assembly_id, position) do update set
        motion_type=excluded.motion_type, title=excluded.title, majority_type=excluded.majority_type, required_motion=excluded.required_motion,
        votes_for=excluded.votes_for, votes_against=excluded.votes_against, abstentions=excluded.abstentions,
        result=excluded.result, consequence=excluded.consequence, proposer_name=excluded.proposer_name, seconder_name=excluded.seconder_name,
        amendment=excluded.amendment, direct_negative=excluded.direct_negative, discussion=excluded.discussion,
        starts_at_text=excluded.starts_at_text, closes_at_text=excluded.closes_at_text, duration_text=excluded.duration_text,
        vote_mode=excluded.vote_mode, manual_result=excluded.manual_result, plenary_id=excluded.plenary_id
      returning *
    `;
    await recordAudit(db, { actorId: member.id, action: "assembly.motion.recorded", entityType: "assembly", entityId: id, afterData: rows[0] });
    return json(res, 200, { motion: rows[0] });
  }
  // Single-field live save, restricted to secrétaires de la plénière
  // (national secretaries) on national assemblies. Writing one column at
  // a time — rather than the full-row upsert 'motion' uses — means a
  // secretary's keystrokes land as they type/blur instead of requiring
  // the whole motion form to be filled out and explicitly saved, and two
  // secretaries working the same PV don't clobber each other's other
  // fields the way a full-row save would.
  if (body.action === "motion_field") {
    const isNationalSecretaryLive = assembly.scope === "national" && (member.is_national_admin || await hasNationalRole(member.id, "secretaire_national"));
    if (!isNationalSecretaryLive) return json(res, 403, { error: "Réservé aux secrétaires de la plénière pour les assemblées nationales." });
    const position = Number(body.position);
    const existing = motions.find(row => row.position === position);
    if (!existing) return json(res, 404, { error: "Motion introuvable." });
    const FIELD_COLUMNS = {
      title: { column: "title", clip: 300, fallback: "Motion" },
      proposerName: { column: "proposer_name", clip: 200 },
      seconderName: { column: "seconder_name", clip: 200 },
      amendment: { column: "amendment", clip: 2000 },
      directNegative: { column: "direct_negative", clip: 2000 },
      discussion: { column: "discussion", clip: 4000 },
      consequence: { column: "consequence", clip: 2000 },
      startsAtText: { column: "starts_at_text", clip: 40 },
      closesAtText: { column: "closes_at_text", clip: 40 },
      durationText: { column: "duration_text", clip: 60 },
    };
    const spec = FIELD_COLUMNS[body.field];
    if (!spec) return json(res, 400, { error: "Champ invalide." });
    const value = clip(body.value, spec.clip) || (spec.fallback ?? null);
    let rows;
    switch (spec.column) {
      case "title": rows = await db`update portal_assembly_motions set title=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
      case "proposer_name": rows = await db`update portal_assembly_motions set proposer_name=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
      case "seconder_name": rows = await db`update portal_assembly_motions set seconder_name=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
      case "amendment": rows = await db`update portal_assembly_motions set amendment=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
      case "direct_negative": rows = await db`update portal_assembly_motions set direct_negative=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
      case "discussion": rows = await db`update portal_assembly_motions set discussion=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
      case "consequence": rows = await db`update portal_assembly_motions set consequence=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
      case "starts_at_text": rows = await db`update portal_assembly_motions set starts_at_text=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
      case "closes_at_text": rows = await db`update portal_assembly_motions set closes_at_text=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
      case "duration_text": rows = await db`update portal_assembly_motions set duration_text=${value}, updated_at=now() where assembly_id=${id} and position=${position} returning *`; break;
    }
    return json(res, 200, { motion: rows[0] });
  }
  if (body.action === "delete_motion") {
    if (!(await requirePvEditorForAssembly(req, res, member, assembly))) return;
    const position = Number(body.position);
    const target = motions.find(row => row.position === position);
    if (!target) return json(res, 404, { error: "Motion introuvable." });
    if (target.required_motion) return json(res, 400, { error: "Cette motion fait partie du déroulé obligatoire de l’assemblée et ne peut pas être supprimée." });
    await db`delete from portal_assembly_motions where assembly_id = ${id} and position = ${position}`;
    const remaining = await db`select * from portal_assembly_motions where assembly_id = ${id} order by position`;
    for (const [index, row] of remaining.entries()) if (row.position !== index) await db`update portal_assembly_motions set position = ${index} where id = ${row.id}`;
    await recordAudit(db, { actorId: member.id, action: "assembly.motion.deleted", entityType: "assembly", entityId: id, beforeData: target });
    return json(res, 200, { ok: true });
  }
  if (body.action === "close") {
    if (!(await requireClubCapability(req, res, member, "supervision_editor", assembly.school_id))) return;
    const rows = await db`update portal_assemblies set status='closed', quorum_met=${quorumMet}, outcome_summary=${body.outcomeSummary || null}, closed_at=now(), updated_at=now() where id=${id} returning *`;
    await db`update portal_meetings set status='completed', updated_at=now() where id=${assembly.meeting_id}`;
    await recordAudit(db, { actorId: member.id, action: "assembly.closed", entityType: "assembly", entityId: id, afterData: rows[0] });
    return json(res, 200, { assembly: rows[0], quorumMet });
  }
  return json(res, 400, { error: "Action d’assemblée inconnue." });
}

async function elections(req, res, member, body) {
  const db = sql();
  if (req.method === "GET") {
    const assemblyId = String(req.query?.assemblyId || "");
    if (!assemblyId) return json(res, 400, { error: "Assemblée requise." });
    const rows = await db`select e.*, a.school_id, a.assembly_type from portal_elections e join portal_assemblies a on a.id=e.assembly_id where e.assembly_id=${assemblyId} and (${member.is_national_admin} or a.school_id=${member.school_id}) order by e.created_at`;
    return json(res, 200, { elections: rows });
  }
  const assemblyId = String(body.assemblyId || "");
  const assemblyRows = await db`select * from portal_assemblies where id=${assemblyId}`;
  const assembly = assemblyRows[0];
  if (!assembly || (!member.is_national_admin && assembly.school_id !== member.school_id)) return json(res, 404, { error: "Assemblée introuvable." });
  if (!(await requireClubCapability(req, res, member, "pv_editor", assembly.school_id))) return;
  if (body.action === "create") {
    const office = String(body.office || "").trim().slice(0, 160);
    if (!office) return json(res, 400, { error: "Poste à élire requis." });
    const scope = ["local", "national", "regional"].includes(body.scope) ? body.scope : (assembly.scope === "national" ? "national" : "local");
    const rows = await db`insert into portal_elections (assembly_id, office, scope, majority_type) values (${assemblyId}, ${office}, ${scope}, 'absolute') returning *`;
    await recordAudit(db, { actorId: member.id, action: "election.created", entityType: "election", entityId: rows[0].id, afterData: rows[0] });
    return json(res, 201, { election: rows[0] });
  }
  if (body.action === "candidate") {
    const electionRows = await db`select * from portal_elections where id=${body.electionId} and assembly_id=${assemblyId}`;
    if (!electionRows[0]) return json(res, 404, { error: "Élection introuvable." });
    const targetRows = await db`select id, school_id, membership_status, status from portal_members where id=${body.memberId}`;
    const target = targetRows[0];
    if (!target || target.status !== "active") return json(res, 404, { error: "Candidat introuvable." });
    if (assembly.scope === "local" && target.school_id !== assembly.school_id) return json(res, 400, { error: "Un candidat à une élection locale doit appartenir au club concerné." });
    const eligibility = ELIGIBLE_MEMBER_STATUSES.has(target.membership_status) ? "eligible" : "ineligible";
    const rows = await db`insert into portal_election_candidates (election_id, member_id, eligibility_status, statement) values (${body.electionId}, ${body.memberId}, ${eligibility}, ${body.statement || null}) on conflict (election_id, member_id) do update set eligibility_status=excluded.eligibility_status, statement=excluded.statement returning *`;
    return json(res, 201, { candidate: rows[0] });
  }
  if (body.action === "round") {
    const electionRows = await db`select id from portal_elections where id=${body.electionId} and assembly_id=${assemblyId}`;
    if (!electionRows[0]) return json(res, 404, { error: "Élection introuvable." });
    const roundNumber = Math.max(1, Number(body.roundNumber) || 1);
    const rows = await db`insert into portal_election_rounds (election_id, round_number, discussion_minutes, tie_note, status) values (${body.electionId}, ${roundNumber}, ${Number(body.discussionMinutes) || null}, ${body.tieNote || null}, 'planned') on conflict (election_id, round_number) do update set discussion_minutes=excluded.discussion_minutes, tie_note=excluded.tie_note returning *`;
    return json(res, 201, { round: rows[0] });
  }
  if (body.action === "tally") {
    const roundRows = await db`select r.*, e.assembly_id from portal_election_rounds r join portal_elections e on e.id=r.election_id where r.id=${body.roundId} and e.assembly_id=${assemblyId}`;
    if (!roundRows[0]) return json(res, 404, { error: "Tour de scrutin introuvable." });
    const rows = await db`insert into portal_election_tallies (round_id, candidate_id, votes_for, abstentions) values (${body.roundId}, ${body.candidateId}, ${Math.max(0, Number(body.votesFor) || 0)}, ${Math.max(0, Number(body.abstentions) || 0)}) on conflict (round_id, candidate_id) do update set votes_for=excluded.votes_for, abstentions=excluded.abstentions returning *`;
    return json(res, 200, { tally: rows[0] });
  }
  return json(res, 400, { error: "Action électorale inconnue." });
}

async function electionDetail(req, res, member, body) {
  const id = String(body.electionId || req.query?.electionId || "");
  if (!id) return json(res, 400, { error: "Élection introuvable." });
  const db = sql();
  const rows = await db`select e.*, a.school_id, a.scope as assembly_scope, a.assembly_type from portal_elections e join portal_assemblies a on a.id=e.assembly_id where e.id=${id}`;
  const election = rows[0];
  if (!election || (!member.is_national_admin && election.school_id !== member.school_id)) return json(res, 404, { error: "Élection introuvable." });
  const [candidates, rounds] = await Promise.all([
    db`select c.*, m.display_name, m.username from portal_election_candidates c join portal_members m on m.id=c.member_id where c.election_id=${id} order by m.display_name`,
    db`select r.*, coalesce(json_agg(json_build_object('candidateId', t.candidate_id, 'votesFor', t.votes_for, 'abstentions', t.abstentions)) filter (where t.candidate_id is not null), '[]'::json) as tallies from portal_election_rounds r left join portal_election_tallies t on t.round_id=r.id where r.election_id=${id} group by r.id order by r.round_number`,
  ]);
  return json(res, 200, { election, candidates, rounds });
}

async function supervision(req, res, member, body) {
  const db = sql();
  const canViewSupervision = async (schoolId) => {
    if (member.is_national_admin) return true;
    return Boolean(await hasCapability(member.id, schoolId, "supervision_editor") || await hasCapability(member.id, schoolId, "cscy_reviewer"));
  };
  const requestedSchool = req.method === "GET" ? req.query?.schoolId : body.schoolId;
  const schoolId = schoolScope(member, requestedSchool);
  if (!schoolId && !member.is_national_admin) return json(res, 200, { reports: [], investigations: [] });
  const targetSchool = member.is_national_admin && !requestedSchool ? null : schoolId;
  if (req.method === "GET") {
    if (!member.is_national_admin && (!schoolId || !(await canViewSupervision(schoolId)))) {
      return json(res, 200, { restricted: true, reports: [], investigations: [] });
    }
    const reportsRows = targetSchool
      ? await db`select r.id, r.school_id, r.title, r.report_type, r.status, r.created_at, r.submitted_at, r.due_at, s.name as school_name from portal_reports r left join portal_schools s on s.id=r.school_id where r.school_id=${targetSchool} and r.report_type in ('supervision','investigation','mise_a_jour') order by r.created_at desc`
      : await db`select r.id, r.school_id, r.title, r.report_type, r.status, r.created_at, r.submitted_at, r.due_at, s.name as school_name from portal_reports r left join portal_schools s on s.id=r.school_id where r.report_type in ('supervision','investigation','mise_a_jour') order by r.created_at desc`;
    const investigationsRows = targetSchool
      ? await db`select i.*, s.name as school_name, m.display_name as subject_name from portal_investigations i left join portal_schools s on s.id=i.school_id left join portal_members m on m.id=i.subject_member_id where i.school_id=${targetSchool} and (${member.is_national_admin} or i.confidentiality <> 'national_only') order by i.opened_at desc`
      : await db`select i.*, s.name as school_name, m.display_name as subject_name from portal_investigations i left join portal_schools s on s.id=i.school_id left join portal_members m on m.id=i.subject_member_id where ${member.is_national_admin} or i.confidentiality <> 'national_only' order by i.opened_at desc`;
    return json(res, 200, { reports: reportsRows, investigations: investigationsRows });
  }
  if (body.action !== "open_investigation") return json(res, 400, { error: "Action de supervision inconnue." });
  if (!(await requireClubCapability(req, res, member, "supervision_editor", schoolId))) return;
  const category = ["communication", "personal_conflict", "regulation", "law", "other"].includes(body.category) ? body.category : "other";
  const level = body.level === "national" || category === "law" ? "national" : "local";
  if (category === "law" && !member.is_national_admin) return json(res, 403, { error: "Les sujets relevant de la loi sont réservés à la supervision nationale." });
  const title = String(body.title || "Investigation").trim().slice(0, 240);
  if (!title) return json(res, 400, { error: "Titre requis." });
  const rows = await db`insert into portal_investigations (school_id, subject_member_id, opened_by, level, category, title, summary, confidentiality) values (${schoolId}, ${body.subjectMemberId || null}, ${member.id}, ${level}, ${category}, ${title}, ${body.summary || null}, ${level === "national" ? "national_only" : "supervision"}) returning *`;
  await db`insert into portal_investigation_events (investigation_id, actor_id, event_type, content) values (${rows[0].id}, ${member.id}, 'status_change', 'Investigation ouverte dans le portail.')`;
  await recordAudit(db, { actorId: member.id, action: "investigation.opened", entityType: "investigation", entityId: rows[0].id, afterData: rows[0] });
  return json(res, 201, { investigation: rows[0] });
}

async function investigationDetail(req, res, member, body) {
  const id = String(body.investigationId || req.query?.investigationId || "");
  const db = sql();
  const rows = await db`select i.*, s.name as school_name from portal_investigations i left join portal_schools s on s.id=i.school_id where i.id=${id}`;
  const investigation = rows[0];
  if (!investigation || (!member.is_national_admin && (investigation.school_id !== member.school_id || investigation.confidentiality === "national_only"))) return json(res, 404, { error: "Dossier de supervision introuvable." });
  if (req.method === "GET" || body.action === "investigation") {
    if (!member.is_national_admin && !(await hasCapability(member.id, investigation.school_id, "supervision_editor")) && !(await hasCapability(member.id, investigation.school_id, "cscy_reviewer"))) return json(res, 403, { error: "Ce dossier est réservé au Conseil de Supervision ou aux personnes mandatées." });
    return json(res, 200, { investigation, events: await db`select e.*, m.display_name as actor_name from portal_investigation_events e join portal_members m on m.id=e.actor_id where e.investigation_id=${id} order by e.created_at` });
  }
  if (!(await requireClubCapability(req, res, member, "supervision_editor", investigation.school_id))) return;
  if (body.action === "event") {
    const eventType = ["note", "evidence", "hearing", "decision", "restriction", "status_change"].includes(body.eventType) ? body.eventType : "note";
    const content = String(body.content || "").trim().slice(0, 4000);
    if (!content) return json(res, 400, { error: "Contenu de l’événement requis." });
    const eventRows = await db`insert into portal_investigation_events (investigation_id, actor_id, event_type, content) values (${id}, ${member.id}, ${eventType}, ${content}) returning *`;
    return json(res, 201, { event: eventRows[0] });
  }
  if (body.action === "update") {
    const status = ["open", "under_review", "decision", "closed", "dismissed"].includes(body.status) ? body.status : investigation.status;
    const decision = body.decision == null ? investigation.decision : String(body.decision).slice(0, 4000);
    const restrictionSummary = body.restrictionSummary == null ? investigation.restriction_summary : String(body.restrictionSummary).slice(0, 2000);
    const updated = await db`update portal_investigations set status=${status}, decision=${decision || null}, restriction_summary=${restrictionSummary || null}, closed_at=${["closed", "dismissed"].includes(status) ? new Date() : null}, updated_at=now() where id=${id} returning *`;
    await recordAudit(db, { actorId: member.id, action: "investigation.updated", entityType: "investigation", entityId: id, afterData: updated[0] });
    return json(res, 200, { investigation: updated[0] });
  }
  return json(res, 400, { error: "Action d’investigation inconnue." });
}

module.exports = async (req, res) => {
  const member = await requireActiveMember(req, res);
  if (!member) return;
  const body = req.method === "GET" ? {} : parseBody(req);
  if (body === null) return json(res, 400, { error: "Corps JSON invalide." });
  const action = String(req.query?.action || body.action || "dashboard");
  try {
    if (action === "profile") return json(res, 200, await profile(member));
    if (action === "update_profile") return updateProfile(req, res, member, body);
    if (action === "dashboard") return json(res, 200, await dashboard(member));
    if (action === "roster") {
      const schoolId = schoolScope(member, req.query?.schoolId);
      if (!schoolId) return json(res, 200, { members: [] });
      const roster = await sql()`select id, display_name, username, membership_status from portal_members where school_id = ${schoolId} and status = 'active' order by display_name`;
      return json(res, 200, { members: roster });
    }
    if (action === "meetings") return req.method === "GET" ? json(res, 200, { meetings: await listMeetings(member, req.query || {}) }) : createMeeting(req, res, member, body);
    if (action === "meeting") return meetingDetail(req, res, member, body);
    if (action === "strategic_axes") return strategicAxes(req, res);
    if (action === "report_templates") return reportTemplates(req, res);
    if (action === "projects") return projects(req, res, member, body);
    if (action === "reports") return reports(req, res, member, body);
    if (action === "assemblies") return assemblies(req, res, member, body);
    if (action === "assembly") return assemblyDetail(req, res, member, body);
    if (action === "elections") return elections(req, res, member, body);
    if (action === "election") return electionDetail(req, res, member, body);
    if (action === "supervision") return supervision(req, res, member, body);
    if (action === "investigation") return investigationDetail(req, res, member, body);
    if (action === "document_upload") return documentUpload(req, res, member);
    if (action === "document_download") return documentDownload(req, res, member);
    if (action === "training") return training(req, res, member, body);
    if (action === "formation_sessions") return formationSessions(req, res, member, body);
    if (action === "tasks") return tasks(req, res, member, body);
    if (action === "responsibilities") return responsibilities(req, res, member, body);
    return json(res, 404, { error: "Action portail inconnue." });
  } catch (err) {
    console.error("portal API error", action, err);
    return json(res, 500, { error: "Une erreur interne est survenue." });
  }
};
