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
  hasCapability,
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
      (select count(*)::int from portal_meeting_attendees a where a.meeting_id = m.id) as attendee_count,
      (select coalesce(json_agg(json_build_object('id', i.id, 'position', i.position, 'title', i.title, 'durationMinutes', i.duration_minutes, 'notes', i.notes) order by i.position), '[]'::json)
         from portal_meeting_agenda_items i where i.meeting_id = m.id) as agenda_items
    from portal_meetings m
      join portal_schools s on s.id = m.school_id
      left join portal_members chair on chair.id = m.chair_id
      left join portal_members secretary on secretary.id = m.secretary_id
    where m.school_id = ${schoolId}
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
  const title = String(body.title || "").trim();
  const startsAt = String(body.startsAt || "").trim();
  const allowedTypes = ["reunion", "assemblee_locale", "assemblee_generale"];
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
  if (!meeting || (!member.is_national_admin && meeting.school_id !== member.school_id)) {
    return json(res, 404, { error: "Réunion introuvable." });
  }
  const [agendaItems, attendees, minutes, roster] = await Promise.all([
    db`select * from portal_meeting_agenda_items where meeting_id = ${id} order by position`,
    db`
      select a.*, m.display_name, m.username, m.profile_picture_url, m.membership_status
      from portal_meeting_attendees a join portal_members m on m.id = a.member_id
      where a.meeting_id = ${id} order by m.display_name
    `,
    db`select * from portal_minutes where meeting_id = ${id}`,
    db`select id, display_name, username, membership_status from portal_members where school_id = ${meeting.school_id} and status = 'active' order by display_name`,
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
  if (req.method === "GET" || body.action === "meeting") return json(res, 200, { meeting, agendaItems, attendees, roster, minutes: minutes[0] || null, structured });
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
    const activeIds = new Set(roster.map(row => row.id));
    const normalizedAttendance = attendance.filter(row => activeIds.has(row.memberId)).map((row, index) => ({
      memberId: row.memberId,
      attendanceStatus: ["present", "absent", "excused", "late"].includes(row.attendanceStatus) ? row.attendanceStatus : "present",
      votingRights: Boolean(row.votingRights),
      memberRole: row.memberRole ? String(row.memberRole).slice(0, 160) : null,
      note: row.note ? String(row.note).slice(0, 500) : null,
      position: index,
    }));
    const savedMinutes = await db`
      insert into portal_minutes
        (meeting_id, mode, mandate, organizer, drafted_at, sent_at, closing_at, duration_minutes, redactors, attendance, agenda_blocks, motions, status, created_by)
      values (${id}, ${mode}, ${body.mandate || null}, ${body.organizer || null}, ${body.draftedAt || null}, ${body.sentAt || null},
        ${body.closingAt || null}, ${body.durationMinutes ? Number(body.durationMinutes) : null},
        ${JSON.stringify(body.redactors || [])}::jsonb, ${JSON.stringify(normalizedAttendance)}::jsonb,
        ${JSON.stringify(agendaBlocks)}::jsonb, ${JSON.stringify(motions)}::jsonb, ${status}, ${member.id})
      on conflict (meeting_id) do update set
        mode = excluded.mode, mandate = excluded.mandate, organizer = excluded.organizer,
        drafted_at = excluded.drafted_at, sent_at = excluded.sent_at, closing_at = excluded.closing_at,
        duration_minutes = excluded.duration_minutes, redactors = excluded.redactors, attendance = excluded.attendance,
        agenda_blocks = excluded.agenda_blocks, motions = excluded.motions, status = excluded.status, updated_at = now()
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
        insert into portal_minutes_agenda_blocks (minutes_id, position, title, discussion, decision, duration_minutes)
        values (${minutesId}, ${position}, ${String(block.title || 'Point').slice(0, 300)}, ${block.discussion || null}, ${block.decision || null}, ${block.durationMinutes ? Number(block.durationMinutes) : null})
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

async function projects(req, res, member, body) {
  const db = sql();
  if (req.method === "GET") {
    const schoolId = schoolScope(member, req.query?.schoolId);
    if (!schoolId) return json(res, 200, { projects: [] });
    const rows = await db`
      select p.*, a.name as axis_name, sa.name as sub_axis_name,
        (select count(*)::int from portal_reports r where r.project_id = p.id) as report_count
      from portal_projects p
      left join portal_strategic_axes a on a.slug = p.axis_slug
      left join portal_strategic_sub_axes sa on sa.slug = p.sub_axis_slug
      where p.school_id = ${schoolId} and p.status <> 'cancelled'
      order by coalesce(p.starts_at, p.created_at) desc
    `;
    return json(res, 200, { projects: rows });
  }
  if (!(await requireClubCapability(req, res, member, "project_manager", schoolScope(member, body.schoolId)))) return;
  const schoolId = schoolScope(member, body.schoolId);
  const title = String(body.title || "").trim();
  if (!schoolId || !title) return json(res, 400, { error: "Club et titre de projet requis." });
  const axisSlug = body.axisSlug ? String(body.axisSlug).trim() : null;
  if (axisSlug) {
    const axis = await db`select slug from portal_strategic_axes where slug = ${axisSlug}`;
    if (!axis[0]) return json(res, 400, { error: "Axe stratégique invalide." });
  }
  const projectType = String(body.projectType || "projet").slice(0, 80);
  const result = await db`
    insert into portal_projects
      (school_id, created_by, title, description, project_type, starts_at, ends_at, status, axis_slug, sub_axis_slug, objectives, expected_results, evaluation_method, stakeholders, indicators)
    values
      (${schoolId}, ${member.id}, ${title}, ${body.description || null}, ${projectType}, ${body.startsAt || null}, ${body.endsAt || null},
       ${["draft", "in_progress", "completed", "cancelled"].includes(body.status) ? body.status : "draft"}, ${axisSlug}, ${body.subAxisSlug || null},
       ${body.objectives || null}, ${body.expectedResults || null}, ${body.evaluationMethod || null},
       ${JSON.stringify(Array.isArray(body.stakeholders) ? body.stakeholders : [])}::jsonb,
       ${JSON.stringify(Array.isArray(body.indicators) ? body.indicators : [])}::jsonb)
    returning *
  `;
  return json(res, 201, { project: result[0] });
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
  if (req.method === "GET") {
    const [entries, trainerRows, awards, documents] = await Promise.all([
      db`select * from portal_training_entries where member_id = ${member.id} order by held_on desc nulls last, created_at desc`,
      db`select * from portal_trainer_profiles where member_id = ${member.id}`,
      db`select id, title, issuer, awarded_on, value_tag, description, visibility, created_at from portal_member_awards where member_id = ${member.id} and visibility = 'active_members' order by awarded_on desc nulls last, created_at desc`,
      visibleDocuments(db, member),
    ]);
    const totals = { received: 0, delivered: 0, facilitation: 0, other: 0, hours: 0, declaredHours: 0, validatedHours: 0 };
    const isVerifiedTrainer = trainerRows[0]?.certification_status === "verified" || member.is_national_admin;
    for (const entry of entries) {
      totals[entry.category] = (totals[entry.category] || 0) + 1;
      const hours = Number(entry.hours || 0);
      totals.declaredHours += hours;
      if (isVerifiedTrainer) totals.validatedHours += hours;
    }
    totals.hours = totals.validatedHours;
    return json(res, 200, { entries, trainerProfile: trainerRows[0] || null, awards, documents, totals, access: { isVerifiedTrainer } });
  }
  if (body.action === "trainer_profile") {
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
  if (!body.title || !["received", "delivered", "facilitation", "other"].includes(body.category)) return json(res, 400, { error: "Catégorie et titre requis." });
  const trainerRows = await db`select certification_status from portal_trainer_profiles where member_id = ${member.id} limit 1`;
  const canEditOfficialTraining = member.is_national_admin || trainerRows[0]?.certification_status === "verified";
  if (!canEditOfficialTraining && !["received", "other"].includes(body.category)) return json(res, 403, { error: "Les formations dispensées et leurs heures sont réservées aux formateurs homologués ou au VPA." });
  if (!canEditOfficialTraining && body.hours !== "" && body.hours != null) return json(res, 403, { error: "Un membre peut déclarer une participation, mais ne peut pas renseigner des heures officielles." });
  const hours = canEditOfficialTraining && body.hours !== "" && body.hours != null ? Number(body.hours) : null;
  if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 10000)) return json(res, 400, { error: "Nombre d'heures invalide." });
  let evidenceId = body.evidenceDocumentId ? String(body.evidenceDocumentId) : null;
  if (evidenceId) {
    const evidence = await db`select id from portal_member_documents where id = ${evidenceId} and member_id = ${member.id}`;
    if (!evidence[0]) return json(res, 400, { error: "Justificatif invalide." });
  }
  const rows = await db`
    insert into portal_training_entries (member_id, category, title, host, held_on, location, booklet_url, hours, notes, evidence_document_id)
    values (${member.id}, ${body.category}, ${String(body.title).trim()}, ${body.host || null}, ${body.heldOn || null}, ${body.location || null}, ${body.bookletUrl || null}, ${hours}, ${body.notes || null}, ${evidenceId})
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
  const schoolId = schoolScope(member, body.schoolId);
  if (!schoolId || !(await requireClubCapability(req, res, member, "project_manager", schoolId))) return;
  const assignedTo = String(body.assignedTo || member.id);
  const assigneeRows = await db`select id from portal_members where id=${assignedTo} and status='active' and school_id=${schoolId}`;
  if (!assigneeRows[0]) return json(res, 400, { error: "Membre assigné invalide pour ce club." });
  let projectId = body.projectId || null;
  if (projectId) {
    const projectRows = await db`select id from portal_projects where id=${projectId} and school_id=${schoolId} and status <> 'cancelled'`;
    if (!projectRows[0]) return json(res, 400, { error: "Projet invalide pour ce club." });
  }
  const priority = ["basse", "normale", "haute", "urgente"].includes(body.priority) ? body.priority : "normale";
  const rows = await db`insert into portal_tasks (school_id, assigned_to, project_id, title, description, priority, deadline, comments, created_by) values (${schoolId}, ${assignedTo}, ${projectId}, ${String(body.title).trim()}, ${body.description || null}, ${priority}, ${body.deadline || null}, ${body.comments || null}, ${member.id}) returning *`;
  await recordAudit(db, { actorId: member.id, action: "task.created", entityType: "task", entityId: rows[0].id, afterData: rows[0] });
  return json(res, 201, { task: rows[0] });
}

async function responsibilities(req, res, member, body) {
  const db = sql();
  if (req.method === "GET") return json(res, 200, { responsibilities: await db`select r.*, s.name as school_name from portal_responsibilities r left join portal_schools s on s.id=r.school_id where r.member_id=${member.id} order by r.held_on desc nulls last, r.created_at desc` });
  if (!body.title) return json(res, 400, { error: "Titre requis." });
  const rows = await db`insert into portal_responsibilities (member_id, school_id, title, description, project_url, database_url, held_on, status) values (${member.id}, ${member.school_id}, ${String(body.title).trim()}, ${body.description || null}, ${body.projectUrl || null}, ${body.databaseUrl || null}, ${body.heldOn || null}, 'proposed') returning *`;
  return json(res, 201, { responsibility: rows[0] });
}

const ASSEMBLY_TYPES = ["alofm", "adhesion", "validation", "aloe", "dissolution", "ag_ordinaire", "ag_extraordinaire"];
const ASSEMBLY_LABELS = { alofm: "ALOFM", adhesion: "AL d’adhésion", validation: "AL de validation", aloe: "ALOE", dissolution: "AL de dissolution", ag_ordinaire: "AG ordinaire", ag_extraordinaire: "AG extraordinaire" };
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
  if (!schoolId || !(await requireClubCapability(req, res, member, "meeting_organizer", schoolId))) return;
  const assemblyType = String(body.assemblyType || "");
  if (!ASSEMBLY_TYPES.includes(assemblyType)) return json(res, 400, { error: "Type d’assemblée invalide." });
  const title = String(body.title || ASSEMBLY_LABELS[assemblyType]).trim();
  const startsAt = String(body.startsAt || "").trim();
  if (!title || !startsAt) return json(res, 400, { error: "Titre et date requis." });
  const scope = assemblyType.startsWith("ag_") ? "national" : "local";
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
  const assemblyRows = await db`
    insert into portal_assemblies (meeting_id, school_id, assembly_type, scope, status, member_snapshot_count, quorum_required, eligible_voter_count, voter_snapshot, project_url, database_url, created_by)
    values (${meeting.id}, ${schoolId}, ${assemblyType}, ${scope}, 'planned', ${memberRows.length}, ${quorumRequired}, ${eligible.length}, ${JSON.stringify(memberSnapshot)}::jsonb, ${body.projectUrl || null}, ${body.databaseUrl || null}, ${member.id})
    returning *
  `;
  const assembly = assemblyRows[0];
  for (const row of memberRows) await db`insert into portal_assembly_attendance (assembly_id, member_id, attendance_status, voting_rights, eligibility_basis, assigned_by) values (${assembly.id}, ${row.id}, 'invited', ${ELIGIBLE_MEMBER_STATUSES.has(row.membership_status)}, ${row.membership_status}, ${member.id}) on conflict (assembly_id, member_id) do nothing`;
  for (const [position, motionTitle] of assemblyMotionSeed(assemblyType).entries()) await db`insert into portal_assembly_motions (assembly_id, position, motion_type, title, majority_type, required_motion) values (${assembly.id}, ${position}, ${position < 5 || position >= assemblyMotionSeed(assemblyType).length - 3 ? "procedural" : "decision"}, ${motionTitle}, 'simple', ${position < 5 || position >= assemblyMotionSeed(assemblyType).length - 3})`;
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
  const [attendance, roles, motions, elections] = await Promise.all([
    db`select a.*, m.display_name, m.username, m.membership_status from portal_assembly_attendance a join portal_members m on m.id = a.member_id where a.assembly_id = ${id} order by m.display_name`,
    db`select ar.*, m.display_name, m.username from portal_assembly_roles ar join portal_members m on m.id = ar.member_id where ar.assembly_id = ${id} order by m.display_name`,
    db`select * from portal_assembly_motions where assembly_id = ${id} order by position`,
    db`select * from portal_elections where assembly_id = ${id} order by created_at`,
  ]);
  const presentCount = attendance.filter(row => ["present", "late"].includes(row.attendance_status)).length;
  const quorumMet = assembly.scope === "local" ? presentCount >= assembly.quorum_required : null;
  if (req.method === "GET" || body.action === "assembly") return json(res, 200, { assembly: { ...assembly, assembly_label: ASSEMBLY_LABELS[assembly.assembly_type] || assembly.assembly_type, present_count: presentCount, quorum_met_live: quorumMet }, attendance, roles, motions, elections });
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
  if (body.action === "motion") {
    if (!(await requireClubCapability(req, res, member, "pv_editor", assembly.school_id))) return;
    const position = Number(body.position);
    const existing = motions.find(row => row.position === position);
    const majorityType = ["simple", "absolute", "relative", "two_thirds"].includes(body.majorityType) ? body.majorityType : (existing?.majority_type || "simple");
    const votesFor = Math.max(0, Number(body.votesFor) || 0);
    const votesAgainst = Math.max(0, Number(body.votesAgainst) || 0);
    const abstentions = Math.max(0, Number(body.abstentions) || 0);
    const resultLabel = majorityOutcome(votesFor, votesAgainst, abstentions, majorityType);
    const rows = await db`
      insert into portal_assembly_motions (assembly_id, position, motion_type, title, majority_type, required_motion, votes_for, votes_against, abstentions, result, consequence)
      values (${id}, ${Number.isInteger(position) && position >= 0 ? position : motions.length}, ${String(body.motionType || "decision")}, ${String(body.title || "Motion").slice(0, 300)}, ${majorityType}, ${Boolean(body.requiredMotion)}, ${votesFor}, ${votesAgainst}, ${abstentions}, ${resultLabel}, ${body.consequence || null})
      on conflict (assembly_id, position) do update set title=excluded.title, majority_type=excluded.majority_type, votes_for=excluded.votes_for, votes_against=excluded.votes_against, abstentions=excluded.abstentions, result=excluded.result, consequence=excluded.consequence
      returning *
    `;
    await recordAudit(db, { actorId: member.id, action: "assembly.motion.recorded", entityType: "assembly", entityId: id, afterData: rows[0] });
    return json(res, 200, { motion: rows[0] });
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
    if (action === "tasks") return tasks(req, res, member, body);
    if (action === "responsibilities") return responsibilities(req, res, member, body);
    return json(res, 404, { error: "Action portail inconnue." });
  } catch (err) {
    console.error("portal API error", action, err);
    return json(res, 500, { error: "Une erreur interne est survenue." });
  }
};
