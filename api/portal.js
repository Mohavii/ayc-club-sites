// Consolidated YOUTHCLUBber portal API.
// This route uses only the portal Neon database and portal session/role model.
const { sql } = require("./_lib/db");
const { requireActiveMember } = require("./_lib/sessions");
const {
  getMemberRoleHistory,
  getMemberCapabilities,
  getMemberStatusHistory,
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
           m.bio, m.status, m.membership_status, m.is_national_admin, m.school_id,
           s.name as school_name, s.slug as school_slug
    from portal_members m left join portal_schools s on s.id = m.school_id
    where m.id = ${member.id}
  `;
  return {
    member: rows[0] || member,
    roles: await getMemberRoleHistory(member.id),
    capabilities: await getMemberCapabilities(member.id),
    statusHistory: await getMemberStatusHistory(member.id),
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
  const rows = await db`insert into portal_responsibilities (member_id, school_id, title, description, project_url, database_url, held_on, status) values (${member.id}, ${member.school_id}, ${String(body.title).trim()}, ${body.description || null}, ${body.projectUrl || null}, ${body.databaseUrl || null}, ${body.heldOn || null}, 'proposed') returning *`;
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
    if (action === "training") return training(req, res, member, body);
    if (action === "tasks") return tasks(req, res, member, body);
    if (action === "responsibilities") return responsibilities(req, res, member, body);
    return json(res, 404, { error: "Action portail inconnue." });
  } catch (err) {
    console.error("portal API error", action, err);
    return json(res, 500, { error: "Une erreur interne est survenue." });
  }
};
