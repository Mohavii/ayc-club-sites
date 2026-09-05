// bel-workspace.js
//
// One shared implementation of the "list + create/edit + delete" screen
// used by the Bureau Exécutif Local workspaces that were added for the
// three posts which previously had no space at all: VPI (vpi.html),
// VPE (vpe.html) and VPC (vpc.html).
//
// Why this file exists rather than three near-identical inline scripts:
// the pages differ ONLY in their field list, their table columns and
// which api/portal.js resource they talk to. Everything else — access
// gating, fetching, rendering, enum labels, edit mode, delete
// confirmation, error surfacing — is identical, and three copies of it
// would drift apart the first time one of them was fixed.
//
// Each page therefore declares a config and calls
// AYCBelWorkspace.mount(config); the generic CRUD contract on the server
// side is api/portal.js's belResource() / BEL_RESOURCES map, so a new
// resource needs a config here and an entry there, nothing more.
//
// Multi-resource pages (VPI = recruitment + needs, VPE = partnerships +
// delegations) call mount() once per resource; the second call's scope
// is the second <section> and everything below is local to that root,
// so two instances on the same page do not collide.
(() => {
  const esc = value => window.AYCPortal.escapeHtml(value == null ? "" : value);

  // ---- field control -----------------------------------------------
  // Renders one form control from a field spec. `type` mirrors the
  // coercion performed server-side in coerceBelField(). The `id` of
  // every control is namespaced with `scope` so two instances on the
  // same page don't produce duplicate ids (HTML forbids duplicates and
  // `document.getElementById` would otherwise pick the first).
  function fieldControl(field, value, scope) {
    const id = `${scope}-f-${field.key}`;
    const required = field.required ? " required" : "";
    switch (field.type) {
      case "textarea":
        return `<textarea id="${id}" data-field="${esc(field.key)}"${required} placeholder="${esc(field.placeholder || "")}">${esc(value || "")}</textarea>`;
      case "select":
        return `<select id="${id}" data-field="${esc(field.key)}"${required}>`
          + (field.allowEmpty ? `<option value="">${esc(field.emptyLabel || "À préciser")}</option>` : "")
          + field.options.map(opt => `<option value="${esc(opt.value)}"${String(value) === String(opt.value) ? " selected" : ""}>${esc(opt.label)}</option>`).join("")
          + `</select>`;
      case "date":
        return `<input id="${id}" data-field="${esc(field.key)}" type="date" value="${esc(toDateInput(value))}"${required}>`;
      case "number":
        return `<input id="${id}" data-field="${esc(field.key)}" type="number" min="${field.min ?? 0}" step="1" value="${value == null ? "" : esc(value)}"${required}>`;
      case "checkbox":
        return `<label class="inline-check"><input id="${id}" data-field="${esc(field.key)}" type="checkbox"${value ? " checked" : ""}> ${esc(field.checkboxLabel || field.label)}</label>`;
      case "url":
        return `<input id="${id}" data-field="${esc(field.key)}" type="url" value="${esc(value || "")}" placeholder="https://…"${required}>`;
      default:
        return `<input id="${id}" data-field="${esc(field.key)}" value="${esc(value || "")}" placeholder="${esc(field.placeholder || "")}"${required}>`;
    }
  }

  function toDateInput(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
  }

  // camelCase field key -> snake_case DB column, matching the `column`
  // defaults on the server: coerceBelField uses spec.column || key, and
  // BEL_RESOURCES sets `column` for every multi-word key.
  function columnFor(key) {
    return key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
  }

  function readValue(field, item) {
    if (!item) return field.default ?? (field.type === "checkbox" ? false : "");
    const direct = item[field.key];
    if (direct !== undefined) return direct;
    return item[columnFor(field.key)];
  }

  // ---- mount -------------------------------------------------------
  // config:
  //   resource        string (required)  portal action name (one of BEL_RESOURCES)
  //   accessFlag      string (required)  one of canAccess{Internal,External}Relations / canAccessCommunication
  //   root            string|Element     element id or Element; everything is scoped inside it
  //   fields          array of { key, label, type, required, full, options, hint, … }
  //   columns         array of { label, render(item, esc) }
  //   stats           array of { label, value(items) } (optional, requires a .bel-kpis inside root)
  //   emptyText       string (optional)
  //   formTitle       string (optional)
  //   editTitle       string (optional)
  //   member          object (optional)  pre-loaded session member (reused when a page hosts multiple mounts)
  function mount(config) {
    const {
      resource,
      accessFlag,
      root,
      fields = [],
      columns = [],
      emptyText = "Aucun élément enregistré",
      stats = null,
      formTitle = "Nouvel élément",
      editTitle = "Modifier l’élément",
      member: preloadedMember = null,
    } = config;

    const rootEl = typeof root === "string" ? document.getElementById(root) : root;
    if (!rootEl) throw new Error(`bel-workspace: root "${root}" introuvable.`);
    // The scope is the resource name: short, unique, safe in an HTML id.
    // Using the resource name (not a counter) means every input keeps the
    // same id across renders of the same instance, which makes links like
    // #club_recruitment-f-title work in URLs.
    const scope = resource;
    const $ = sel => rootEl.querySelector(sel);
    const $$ = sel => Array.from(rootEl.querySelectorAll(sel));
    const $rows = $(`[data-bw-rows]`);
    const $fields = $(`[data-bw-fields]`);
    const $form = $(`[data-bw-form]`);
    const $title = $(`[data-bw-form-title]`);
    const $submit = $(`[data-bw-submit]`);
    const $cancel = $(`[data-bw-cancel]`);
    const $kpis = $(`[data-bw-kpis]`);

    let member = preloadedMember;
    let items = [];
    let editingId = null;

    function renderStats() {
      if (!stats || !$kpis) return;
      $kpis.innerHTML = stats.map(stat => `
        <div class="stat-card">
          <span class="stat-number">${esc(stat.value(items))}</span>
          <span class="stat-label">${esc(stat.label)}</span>
        </div>`).join("");
    }

    function renderTable() {
      if (!$rows) return;
      if (!items.length) {
        $rows.innerHTML = `<tr><td colspan="${columns.length + 1}">${window.AYCPortal.renderEmpty(emptyText)}</td></tr>`;
        return;
      }
      $rows.innerHTML = items.map(item => `
        <tr>
          ${columns.map(column => `<td>${column.render(item, esc)}</td>`).join("")}
          <td class="row-actions">
            <button class="btn btn-secondary btn-sm" data-bw-edit="${esc(item.id)}">Modifier</button>
            <button class="btn btn-danger btn-sm" data-bw-delete="${esc(item.id)}">Supprimer</button>
          </td>
        </tr>`).join("");
    }

    function renderForm(item) {
      if ($title) $title.textContent = item ? editTitle : formTitle;
      if ($cancel) $cancel.hidden = !item;
      if ($submit) $submit.textContent = item ? "Mettre à jour" : "Enregistrer";
      if ($fields) {
        $fields.innerHTML = fields.map(field => `
          <div class="form-field${field.full ? " full" : ""}">
            ${field.type === "checkbox" ? "" : `<label for="${scope}-f-${esc(field.key)}">${esc(field.label)}</label>`}
            ${fieldControl(field, readValue(field, item), scope)}
            ${field.hint ? `<small class="field-hint">${esc(field.hint)}</small>` : ""}
          </div>`).join("");
      }
    }

    function collect() {
      const body = {};
      fields.forEach(field => {
        const el = $fields?.querySelector(`[data-field="${field.key}"]`);
        if (!el) return;
        if (field.type === "checkbox") { body[field.key] = el.checked; return; }
        const value = el.value.trim();
        // Send null (not "") for empties so the server's coerceBelField
        // stores a real NULL instead of an empty string.
        body[field.key] = value === "" ? null : value;
      });
      return body;
    }

    async function load() {
      const data = await window.AYCPortal.api(resource);
      items = data.items || [];
      renderStats();
      renderTable();
    }

    function resetForm() {
      editingId = null;
      renderForm(null);
    }

    // ---- the shared notice target. Pages with multiple mounts pass
    // a selector through `noticeSelector` (e.g. "#notice") so all
    // instances write to the same place. If none is given we fall back
    // to looking inside the root for a [data-bw-notice], then to a
    // window-level one, then to the root itself (errors visible inline).
    const $notice = (() => {
      if (config.noticeSelector) return document.querySelector(config.noticeSelector);
      return $("[data-bw-notice]") || document.getElementById("notice") || rootEl;
    })();

    async function boot() {
      if (!member) {
        member = await window.AYCPortal.initPortalShell({ requireActive: true });
        if (!member) return;
      }
      const allowed = Boolean(member.isNationalAdmin || member.access?.[accessFlag]);
      if (!allowed) {
        // Hide this instance, show the page-level restricted note if any
        rootEl.hidden = true;
        return;
      }
      rootEl.hidden = false;

      resetForm();

      try {
        await load();
      } catch (err) {
        window.AYCPortal.renderError($notice, err);
      }

      if ($form) {
        $form.addEventListener("submit", async event => {
          event.preventDefault();
          const body = collect();
          if (editingId) { body.action = "update"; body.id = editingId; }
          else body.action = "create";
          try {
            await window.AYCPortal.api(resource, { method: "POST", body });
            $notice.innerHTML = `<div class="alert alert-success">${editingId ? "Modifications enregistrées." : "Élément enregistré."}</div>`;
            resetForm();
            await load();
          } catch (err) {
            window.AYCPortal.renderError($notice, err);
          }
        });
      }

      if ($cancel) $cancel.addEventListener("click", resetForm);

      if ($rows) {
        $rows.addEventListener("click", async event => {
          const editBtn = event.target.closest("[data-bw-edit]");
          if (editBtn) {
            const item = items.find(row => String(row.id) === String(editBtn.dataset.bwEdit));
            if (!item) return;
            editingId = item.id;
            renderForm(item);
            $form?.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
          }
          const deleteBtn = event.target.closest("[data-bw-delete]");
          if (deleteBtn) {
            if (!confirm("Supprimer définitivement cet élément ?")) return;
            try {
              await window.AYCPortal.api(resource, { method: "POST", body: { action: "delete", id: deleteBtn.dataset.bwDelete } });
              $notice.innerHTML = '<div class="alert alert-success">Élément supprimé.</div>';
              if (String(editingId) === String(deleteBtn.dataset.bwDelete)) resetForm();
              await load();
            } catch (err) {
              window.AYCPortal.renderError($notice, err);
            }
          }
        });
      }

      // The refresh button can either be the shared topbar one (#btn-refresh)
      // or a per-instance one inside root. Both reload every instance
      // attached to this notice target so all resources on a page stay
      // in sync.
      const refreshTargets = [document.getElementById("btn-refresh"), $("[data-bw-refresh]")].filter(Boolean);
      refreshTargets.forEach(btn => btn.addEventListener("click", () => {
        if (window.AYCBelWorkspace._instances) {
          window.AYCBelWorkspace._instances.forEach(instance => {
            instance.load().catch(err => window.AYCPortal.renderError($notice, err));
          });
        } else {
          load().catch(err => window.AYCPortal.renderError($notice, err));
        }
      }));
    }

    // Register this instance so the refresh button can fan out to all
    // siblings on the same page. The collection lives in the same
    // namespace; it never grows across reloads because mounting happens
    // after DOMContentLoaded.
    if (!window.AYCBelWorkspace._instances) window.AYCBelWorkspace._instances = [];
    window.AYCBelWorkspace._instances.push({ load, root: rootEl });

    boot().catch(err => window.AYCPortal.renderError($notice, err));
  }

  // Small helper the pages use to turn an enum value into a coloured chip
  // without each of them re-declaring the badge markup.
  function chip(value, labels, tones) {
    const label = labels[value] || value || "—";
    const tone = (tones && tones[value]) || "neutral";
    return `<span class="bel-chip bel-${tone}">${window.AYCPortal.escapeHtml(label)}</span>`;
  }

  // A tiny shared block that the page uses to pre-load the member once
  // and hand it to every mount() call so initPortalShell runs only once
  // per page (otherwise each instance would re-render the topbar and
  // sidebar, producing flicker on multi-resource pages).
  async function prepareShell() {
    const member = await window.AYCPortal.initPortalShell({ requireActive: true });
    return member;
  }

  window.AYCBelWorkspace = { mount, chip, toDateInput, prepareShell };
})();
