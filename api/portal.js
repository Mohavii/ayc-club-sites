// Consolidated YOUTHCLUBber portal API.
// This route uses only the portal Neon database and portal session/role model.
const { sql } = require("./_lib/db");
const { requireActiveMember } = require("./_lib/sessions");
const {
  getMemberRoleHistory,
  getMemberCapabilities,
  requireCapability,
} = require("./_lib/roles");

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body); } catch { return null; }
}

function json(res, status, value) {
  res.status(status).json(value);
}

function schoolScope(member, requested) {
  const id = Number(requested || member.school_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function requireClubCapability(req, res, member, capability, schoolId) {
  const guard = requireCapability(capability);
  return guard(req, res, member, schoolId);
}

async function profile(member) {
  const db = sql();
  const rows = await db`
    select m.id, m.email, m.username, m.display_name, m.profile_picture_url,
           m.cover_photo_url, m.phone, m.education_level, m.formateur_track,
           m.bio, m.status, m.is_national_admin, m.school_id,
           s.name as school_name, s.slug as school_slug
    from portal_members m left join portal_schools s on s.id = m.school_id
    where m.id = ${member.id}
  `;
  return {
    member: rows[0] || member,
    roles: await getMemberRoleHistory(member.id),
    capabilities: await getMemberCapabilities(member.id),
  };
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
      (select count(*)::int from portal_meeting_attendees a where a.meeting_id = m.id) as attendee_count
    from portal_meetings m join portal_schools s on s.id = m.school_id
    where m.school_id = ${schoolId}
    order by m.starts_at desc
  `;
}

async function createMeeting(req, res, member, body) {
  const schoolId = schoolScope(member, body.schoolId);
  if (!schoolId) return json(res, 400, { error: "Club invalide." });
  if (!(await requireClubCapability(req, res, member, "meeting_organizer", schoolId))) return;
  const title = String(body.title || "").trim();
  const startsAt = String(body.startsAt || "").trim();
  const allowedTypes = ["reunion", "assemblee_locale", "assemblee_generale"];
  if (!title || !startsAt || !allowedTypes.includes(body.meetingType)) {
    return json(res, 400, { error: "Titre, type et date requis." });
  }
  const db = sql();
  const rows = await db`
    insert into portal_meetings
      (school_id, created_by, title, meeting_type, starts_at, ends_at, format, location, maps_url, comments, agenda, attachments)
    values
      (${schoolId}, ${member.id}, ${title}, ${body.meetingType}, ${startsAt},
       ${body.endsAt || null}, ${body.format || "presentiel"}, ${body.location || null},
       ${body.mapsUrl || null}, ${body.comments || null},
       ${JSON.stringify(Array.isArray(body.agenda) ? body.agenda : [])}::jsonb,
       ${JSON.stringify(Array.isArray(body.attachments) ? body.attachments : [])}::jsonb)
    returning *
  `;
  return json(res, 201, { meeting: rows[0] });
}

async function meetingDetail(req, res, member, body) {
  const id = String(body.meetingId || req.query?.meetingId || "");
  if (!id) return json(res, 400, { error: "Réunion introuvable." });
  const db = sql();
  const rows = await db`select * from portal_meetings where id = ${id}`;
  const meeting = rows[0];
  if (!meeting || (!member.is_national_admin && meeting.school_id !== member.school_id)) {
    return json(res, 404, { error: "Réunion introuvable." });
  }
  const [attendees, minutes] = await Promise.all([
    db`
      select a.*, m.display_name, m.username, m.profile_picture_url
      from portal_meeting_attendees a join portal_members m on m.id = a.member_id
      where a.meeting_id = ${id} order by m.display_name
    `,
    db`select * from portal_minutes where meeting_id = ${id}`,
  ]);
  if (req.method === "GET" || body.action === "meeting") return json(res, 200, { meeting, attendees, minutes: minutes[0] || null });
  if (body.action === "rsvp") {
    const rsvp = ["pending", "present", "absent"].includes(body.rsvp) ? body.rsvp : "pending";
    const result = await db`
      insert into portal_meeting_attendees (meeting_id, member_id, rsvp, voting_rights)
      values (${id}, ${member.id}, ${rsvp}, ${Boolean(body.votingRights)})
      on conflict (meeting_id, member_id) do update set rsvp = excluded.rsvp, voting_rights = excluded.voting_rights
      returning *
    `;
    return json(res, 200, { attendee: result[0] });
  }
  if (body.action === "save_minutes") {
    if (!(await requireClubCapability(req, res, member, "pv_editor", meeting.school_id))) return;
    const mode = body.mode === "assemblee_generale" ? body.mode : "standard";
    const result = await db`
      insert into portal_minutes
        (meeting_id, mode, mandate, organizer, drafted_at, sent_at, redactors, attendance, agenda_blocks, motions, status, created_by)
      values (${id}, ${mode}, ${body.mandate || null}, ${body.organizer || null},
        ${body.draftedAt || null}, ${body.sentAt || null},
        ${JSON.stringify(body.redactors || [])}::jsonb, ${JSON.stringify(body.attendance || [])}::jsonb,
        ${JSON.stringify(body.agendaBlocks || [])}::jsonb, ${JSON.stringify(body.motions || [])}::jsonb,
        ${body.status || "draft"}, ${member.id})
      on conflict (meeting_id) do update set
        mode = excluded.mode, mandate = excluded.mandate, organizer = excluded.organizer,
        drafted_at = excluded.drafted_at, sent_at = excluded.sent_at, redactors = excluded.redactors,
        attendance = excluded.attendance, agenda_blocks = excluded.agenda_blocks, motions = excluded.motions,
        status = excluded.status, updated_at = now()
      returning *
    `;
    return json(res, 200, { minutes: result[0] });
  }
  return json(res, 400, { error: "Action de réunion inconnue." });
}

async function reports(req, res, member, body) {
  const db = sql();
  if (req.method === "GET") {
    const schoolId = schoolScope(member, req.query?.schoolId);
    if (!schoolId) return json(res, 200, { reports: [] });
    const rows = await db`
      select r.*, m.display_name as submitter_name,
        coalesce(json_agg(json_build_object('department', rv.department, 'status', rv.status, 'comment', rv.comment)) filter (where rv.report_id is not null), '[]') as reviews
      from portal_reports r join portal_members m on m.id = r.submitted_by
      left join portal_report_reviews rv on rv.report_id = r.id
      where r.school_id = ${schoolId}
      group by r.id, m.display_name order by r.created_at desc
    `;
    return json(res, 200, { reports: rows });
  }
  if (body.action === "review") {
    const reportRows = await db`select school_id from portal_reports where id = ${body.reportId}`;
    const report = reportRows[0];
    if (!report) return json(res, 404, { error: "Rapport introuvable." });
    if (!(await requireClubCapability(req, res, member, "report_validator", report.school_id))) return;
    const status = ["pending", "valid", "invalid"].includes(body.status) ? body.status : "pending";
    const result = await db`
      insert into portal_report_reviews (report_id, department, status, comment, reviewer_id, reviewed_at)
      values (${body.reportId}, ${body.department || "coordination_strategique"}, ${status}, ${body.comment || null}, ${member.id}, now())
      on conflict (report_id, department) do update set status=excluded.status, comment=excluded.comment, reviewer_id=excluded.reviewer_id, reviewed_at=now()
      returning *
    `;
    await db`update portal_reports set status = case when ${status} = 'invalid' then 'invalidated' when ${status} = 'valid' then 'validated' else status end, updated_at = now() where id = ${body.reportId}`;
    return json(res, 200, { review: result[0] });
  }
  const schoolId = schoolScope(member, body.schoolId);
  if (!schoolId || !body.title || !body.reportType) return json(res, 400, { error: "Type, club et titre requis." });
  const result = await db`
    insert into portal_reports (school_id, submitted_by, report_type, title, event_date, description, payload, status)
    values (${schoolId}, ${member.id}, ${body.reportType}, ${String(body.title).trim()}, ${body.eventDate || null}, ${body.description || null}, ${JSON.stringify(body.payload || {})}::jsonb, ${body.status === "draft" ? "draft" : "submitted"})
    returning *
  `;
  return json(res, 201, { report: result[0] });
}

async function training(req, res, member, body) {
  const db = sql();
  if (req.method === "GET") {
    const entries = await db`select * from portal_training_entries where member_id = ${member.id} order by held_on desc nulls last, created_at desc`;
    return json(res, 200, { entries });
  }
  if (!body.title || !["received", "delivered", "facilitation", "other"].includes(body.category)) return json(res, 400, { error: "Catégorie et titre requis." });
  const rows = await db`
    insert into portal_training_entries (member_id, category, title, host, held_on, location, booklet_url, hours, notes)
    values (${member.id}, ${body.category}, ${String(body.title).trim()}, ${body.host || null}, ${body.heldOn || null}, ${body.location || null}, ${body.bookletUrl || null}, ${body.hours || null}, ${body.notes || null})
    returning *
  `;
  return json(res, 201, { entry: rows[0] });
}

async function tasks(req, res, member, body) {
  const db = sql();
  if (req.method === "GET") {
    const rows = await db`select t.*, p.title as project_title, s.name as school_name from portal_tasks t left join portal_projects p on p.id=t.project_id left join portal_schools s on s.id=t.school_id where t.assigned_to=${member.id} order by t.deadline nulls last, t.assigned_at desc`;
    return json(res, 200, { tasks: rows });
  }
  if (body.action === "status") {
    const status = ["a_faire", "soumis", "executee", "hors_delai"].includes(body.status) ? body.status : "a_faire";
    const rows = await db`update portal_tasks set status=${status}, comments=${body.comments || null}, updated_at=now() where id=${body.taskId} and assigned_to=${member.id} returning *`;
    return json(res, rows[0] ? 200 : 404, rows[0] ? { task: rows[0] } : { error: "Tâche introuvable." });
  }
  if (!body.title) return json(res, 400, { error: "Titre requis." });
  const rows = await db`insert into portal_tasks (school_id, assigned_to, project_id, title, description, priority, deadline, comments, created_by) values (${body.schoolId || member.school_id}, ${body.assignedTo || member.id}, ${body.projectId || null}, ${String(body.title).trim()}, ${body.description || null}, ${body.priority || "normale"}, ${body.deadline || null}, ${body.comments || null}, ${member.id}) returning *`;
  return json(res, 201, { task: rows[0] });
}

async function responsibilities(req, res, member, body) {
  const db = sql();
  if (req.method === "GET") return json(res, 200, { responsibilities: await db`select r.*, s.name as school_name from portal_responsibilities r left join portal_schools s on s.id=r.school_id where r.member_id=${member.id} order by r.held_on desc nulls last, r.created_at desc` });
  if (!body.title) return json(res, 400, { error: "Titre requis." });
  const rows = await db`insert into portal_responsibilities (member_id, school_id, title, description, project_url, database_url, held_on) values (${member.id}, ${body.schoolId || member.school_id}, ${String(body.title).trim()}, ${body.description || null}, ${body.projectUrl || null}, ${body.databaseUrl || null}, ${body.heldOn || null}) returning *`;
  return json(res, 201, { responsibility: rows[0] });
}

module.exports = async (req, res) => {
  const member = await requireActiveMember(req, res);
  if (!member) return;
  const body = req.method === "GET" ? {} : parseBody(req);
  if (body === null) return json(res, 400, { error: "Corps JSON invalide." });
  const action = String(req.query?.action || body.action || "dashboard");
  try {
    if (action === "profile") return json(res, 200, await profile(member));
    if (action === "dashboard") return json(res, 200, await dashboard(member));
    if (action === "meetings") return req.method === "GET" ? json(res, 200, { meetings: await listMeetings(member, req.query || {}) }) : createMeeting(req, res, member, body);
    if (action === "meeting") return meetingDetail(req, res, member, body);
    if (action === "reports") return reports(req, res, member, body);
    if (action === "training") return training(req, res, member, body);
    if (action === "tasks") return tasks(req, res, member, body);
    if (action === "responsibilities") return responsibilities(req, res, member, body);
    return json(res, 404, { error: "Action portail inconnue." });
  } catch (err) {
    console.error("portal API error", action, err);
    return json(res, 500, { error: "Une erreur interne est survenue." });
  }
};
