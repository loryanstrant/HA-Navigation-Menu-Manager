/*!
 * Navigation Menu Manager — Admin Panel
 * https://github.com/loryanstrant/navigation-menu-manager
 */
const DOMAIN = "navigation_menu_manager";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function uid() {
  return "id-" + Math.random().toString(36).slice(2, 9);
}

class NavigationMenuManagerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._menus = {};
    this._selectedId = null;
    this._draft = null; // working copy of the selected menu (incl. id)
    this._dirty = false;
    this._loaded = false;
    this._busy = false;
    this._status = null;
  }

  /* ---------- HA panel API ---------- */

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
  }

  set narrow(narrow) {
    this._narrow = !!narrow;
  }

  set route(route) {
    this._route = route;
  }

  set panel(panel) {
    this._panel = panel;
  }

  /* ---------- data ops ---------- */

  async _load() {
    if (!this._hass) return;
    try {
      const res = await this._hass.callWS({ type: `${DOMAIN}/list_menus` });
      this._menus = res.menus || {};
      this._loaded = true;
      if (!this._selectedId) {
        const ids = Object.keys(this._menus);
        if (ids.length) this._select(ids[0]);
      }
      this._render();
    } catch (e) {
      this._status = { kind: "error", text: "Could not load menus." };
      this._render();
    }
  }

  _select(id) {
    if (this._dirty && !confirm("Discard unsaved changes?")) return;
    this._selectedId = id;
    const m = this._menus[id];
    if (m) {
      this._draft = {
        id,
        name: m.name || "",
        style: m.style || "buttons",
        items: (m.items || []).map((it) => ({
          _key: uid(),
          label: it.label || "",
          icon: it.icon || "",
          path: it.path || "",
          match: it.match || "",
        })),
      };
    } else {
      this._draft = null;
    }
    this._dirty = false;
    this._status = null;
    this._render();
  }

  _newMenu() {
    if (this._dirty && !confirm("Discard unsaved changes?")) return;
    let id = "menu";
    let i = 1;
    while (this._menus[id]) id = `menu${++i}`;
    this._selectedId = null;
    this._draft = {
      id,
      name: "New menu",
      style: "buttons",
      items: [{ _key: uid(), label: "", icon: "", path: "", match: "" }],
    };
    this._dirty = true;
    this._status = null;
    this._render();
  }

  async _save() {
    if (!this._draft || this._busy) return;
    const draft = this._draft;
    const id = (draft.id || "").trim();
    if (!id) {
      this._status = { kind: "error", text: "Menu id is required." };
      this._render();
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(id)) {
      this._status = {
        kind: "error",
        text: "Menu id may only contain letters, digits, dashes and underscores.",
      };
      this._render();
      return;
    }
    const items = draft.items
      .filter((it) => (it.label || "").trim() && (it.path || "").trim())
      .map((it) => {
        const o = { label: it.label.trim(), path: it.path.trim() };
        if (it.icon && it.icon.trim()) o.icon = it.icon.trim();
        if (it.match) o.match = it.match;
        return o;
      });
    const payload = {
      name: draft.name.trim() || id,
      style: draft.style || "buttons",
      items,
    };

    this._busy = true;
    this._render();
    try {
      // If renaming (id changed), delete the old id first so we don't leave a stale copy.
      if (this._selectedId && this._selectedId !== id) {
        try {
          await this._hass.callWS({
            type: `${DOMAIN}/delete_menu`,
            menu_id: this._selectedId,
          });
        } catch (_) {
          /* not fatal */
        }
      }
      await this._hass.callWS({
        type: `${DOMAIN}/save_menu`,
        menu_id: id,
        menu: payload,
      });
      this._selectedId = id;
      this._dirty = false;
      this._status = { kind: "ok", text: "Saved." };
      await this._load();
      this._select(id);
    } catch (e) {
      this._status = { kind: "error", text: `Save failed: ${e?.message || e}` };
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _deleteSelected() {
    if (!this._selectedId) return;
    if (!confirm(`Delete menu "${this._selectedId}"? Cards using this menu will stop working until reconfigured.`)) {
      return;
    }
    this._busy = true;
    this._render();
    try {
      await this._hass.callWS({
        type: `${DOMAIN}/delete_menu`,
        menu_id: this._selectedId,
      });
      this._selectedId = null;
      this._draft = null;
      this._dirty = false;
      this._status = { kind: "ok", text: "Deleted." };
      await this._load();
    } catch (e) {
      this._status = { kind: "error", text: `Delete failed: ${e?.message || e}` };
    } finally {
      this._busy = false;
      this._render();
    }
  }

  /* ---------- draft mutations ---------- */

  _updateDraft(patch) {
    this._draft = { ...this._draft, ...patch };
    this._dirty = true;
    this._render();
  }

  _updateItem(key, patch) {
    this._draft.items = this._draft.items.map((it) =>
      it._key === key ? { ...it, ...patch } : it
    );
    this._dirty = true;
    this._render();
  }

  _addItem() {
    this._draft.items = [
      ...this._draft.items,
      { _key: uid(), label: "", icon: "", path: "", match: "" },
    ];
    this._dirty = true;
    this._render();
  }

  _removeItem(key) {
    this._draft.items = this._draft.items.filter((it) => it._key !== key);
    this._dirty = true;
    this._render();
  }

  _moveItem(key, delta) {
    const idx = this._draft.items.findIndex((it) => it._key === key);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= this._draft.items.length) return;
    const items = [...this._draft.items];
    const [moved] = items.splice(idx, 1);
    items.splice(next, 0, moved);
    this._draft.items = items;
    this._dirty = true;
    this._render();
  }

  /* ---------- render ---------- */

  _render() {
    const ids = Object.keys(this._menus).sort();
    const d = this._draft;

    this.shadowRoot.innerHTML = `
      ${this._styles()}
      <div class="layout">
        <header class="topbar">
          <div class="title">
            <ha-icon icon="mdi:menu"></ha-icon>
            <h1>Navigation Menus</h1>
          </div>
          <div class="actions">
            ${
              d
                ? `<mwc-button raised ${this._busy ? "disabled" : ""} id="save">${
                    this._busy ? "Saving…" : "Save"
                  }</mwc-button>`
                : ""
            }
            <mwc-button outlined id="new">+ New menu</mwc-button>
          </div>
        </header>

        ${
          this._status
            ? `<div class="banner ${this._status.kind}">${esc(this._status.text)}</div>`
            : ""
        }

        <div class="body">
          <aside class="sidebar">
            <div class="section-title">Your menus</div>
            ${
              ids.length === 0
                ? `<div class="empty">No menus yet. Click <strong>+ New menu</strong> to create one.</div>`
                : `<ul class="menu-list">
                     ${ids
                       .map(
                         (id) => `
                       <li class="${id === this._selectedId ? "selected" : ""}" data-id="${esc(id)}">
                         <div class="menu-name">${esc(this._menus[id].name || id)}</div>
                         <div class="menu-id">${esc(id)} · ${
                           (this._menus[id].items || []).length
                         } items</div>
                       </li>`
                       )
                       .join("")}
                   </ul>`
            }
          </aside>

          <main class="editor">
            ${d ? this._renderEditor(d) : this._renderEmpty()}
          </main>
        </div>

        <footer class="footer">
          Add the <strong>Navigation Menu</strong> card to any view and reference a menu id.
          The card shows a live preview in the card picker.
        </footer>
      </div>
    `;

    // Wire events
    this.shadowRoot.querySelectorAll(".menu-list li").forEach((el) => {
      el.addEventListener("click", () => this._select(el.dataset.id));
    });
    this.shadowRoot.getElementById("new")?.addEventListener("click", () => this._newMenu());
    this.shadowRoot.getElementById("save")?.addEventListener("click", () => this._save());
    this.shadowRoot.getElementById("delete")?.addEventListener("click", () =>
      this._deleteSelected()
    );

    // Draft form
    const bind = (id, key) => {
      const el = this.shadowRoot.getElementById(id);
      if (!el) return;
      el.addEventListener("input", (e) => {
        this._draft[key] = e.target.value;
        this._dirty = true;
        // Don't re-render on every keystroke (would steal focus)
      });
      el.addEventListener("change", (e) => {
        this._updateDraft({ [key]: e.target.value });
      });
    };
    bind("draft-id", "id");
    bind("draft-name", "name");
    const styleEl = this.shadowRoot.getElementById("draft-style");
    styleEl?.addEventListener("change", (e) => this._updateDraft({ style: e.target.value }));

    // Items
    this.shadowRoot.querySelectorAll("[data-item]").forEach((row) => {
      const key = row.dataset.item;
      row.querySelectorAll("input,select").forEach((input) => {
        const field = input.dataset.field;
        input.addEventListener("input", (e) => {
          const item = this._draft.items.find((it) => it._key === key);
          if (item) item[field] = e.target.value;
          this._dirty = true;
        });
        input.addEventListener("change", (e) => {
          this._updateItem(key, { [field]: e.target.value });
        });
      });
      row.querySelector(".up")?.addEventListener("click", () => this._moveItem(key, -1));
      row.querySelector(".down")?.addEventListener("click", () => this._moveItem(key, 1));
      row.querySelector(".del")?.addEventListener("click", () => this._removeItem(key));
    });
    this.shadowRoot.getElementById("add-item")?.addEventListener("click", () => this._addItem());
  }

  _renderEmpty() {
    return `
      <div class="empty-state">
        <ha-icon icon="mdi:gesture-tap" class="big"></ha-icon>
        <p>Select a menu on the left, or click <strong>+ New menu</strong> to create one.</p>
        <p class="hint">A menu is a reusable set of buttons (label + icon + URL/view) that you can drop onto any dashboard using the Navigation Menu card.</p>
      </div>
    `;
  }

  _renderEditor(d) {
    return `
      <div class="form">
        <div class="form-row two-col">
          <div class="field">
            <label for="draft-id">Menu ID</label>
            <input id="draft-id" type="text" value="${esc(d.id)}" placeholder="e.g. main"
                   pattern="[A-Za-z0-9_-]+" />
            <div class="hint">Used by the card config (<code>menu: ${esc(d.id || "&lt;id&gt;")}</code>). Letters, digits, dashes, underscores only.</div>
          </div>
          <div class="field">
            <label for="draft-name">Display name</label>
            <input id="draft-name" type="text" value="${esc(d.name)}" placeholder="Main Navigation" />
          </div>
        </div>

        <div class="form-row">
          <div class="field">
            <label for="draft-style">Default style</label>
            <select id="draft-style">
              <option value="buttons" ${d.style === "buttons" ? "selected" : ""}>Buttons (icon + label)</option>
              <option value="icons" ${d.style === "icons" ? "selected" : ""}>Icons only</option>
              <option value="compact" ${d.style === "compact" ? "selected" : ""}>Compact (icon + label inline)</option>
            </select>
          </div>
        </div>

        <div class="items-header">
          <h2>Items</h2>
          <mwc-button outlined id="add-item">+ Add item</mwc-button>
        </div>

        ${
          d.items.length === 0
            ? `<div class="empty">No items yet. Click <strong>+ Add item</strong> to add a button.</div>`
            : `<div class="items">
                 ${d.items
                   .map(
                     (it, i) => `
                   <div class="item-row" data-item="${esc(it._key)}">
                     <div class="reorder">
                       <button class="up" type="button" title="Move up" ${i === 0 ? "disabled" : ""}>
                         <ha-icon icon="mdi:chevron-up"></ha-icon>
                       </button>
                       <span class="pos">${i + 1}</span>
                       <button class="down" type="button" title="Move down" ${
                         i === d.items.length - 1 ? "disabled" : ""
                       }>
                         <ha-icon icon="mdi:chevron-down"></ha-icon>
                       </button>
                     </div>
                     <div class="item-fields">
                       <div class="field">
                         <label>Label</label>
                         <input type="text" data-field="label" value="${esc(it.label)}" placeholder="Home" />
                       </div>
                       <div class="field">
                         <label>Icon</label>
                         <input type="text" data-field="icon" value="${esc(it.icon)}" placeholder="mdi:home" />
                       </div>
                       <div class="field path">
                         <label>Path or URL</label>
                         <input type="text" data-field="path" value="${esc(it.path)}"
                                placeholder="e.g. climate, /lovelace/home, https://…" />
                       </div>
                       <div class="field">
                         <label>Match</label>
                         <select data-field="match">
                           <option value="" ${!it.match ? "selected" : ""}>Auto</option>
                           <option value="exact" ${it.match === "exact" ? "selected" : ""}>Exact</option>
                           <option value="prefix" ${it.match === "prefix" ? "selected" : ""}>Prefix</option>
                           <option value="suffix" ${it.match === "suffix" ? "selected" : ""}>Suffix</option>
                         </select>
                       </div>
                     </div>
                     <button class="del" type="button" title="Remove item">
                       <ha-icon icon="mdi:trash-can-outline"></ha-icon>
                     </button>
                   </div>`
                   )
                   .join("")}
               </div>`
        }

        <div class="danger-zone">
          ${
            this._selectedId
              ? `<mwc-button id="delete" ${this._busy ? "disabled" : ""}>
                   <ha-icon icon="mdi:trash-can-outline" style="--mdc-icon-size:18px;margin-right:4px"></ha-icon>
                   Delete this menu
                 </mwc-button>`
              : ""
          }
        </div>
      </div>
    `;
  }

  _styles() {
    return `
      <style>
        :host {
          display:block;
          height:100%;
          background: var(--primary-background-color);
          color: var(--primary-text-color);
          font-family: var(--paper-font-body1_-_font-family, "Roboto", sans-serif);
        }
        .layout { display:flex; flex-direction:column; height:100%; min-height:100vh; }
        .topbar {
          display:flex; align-items:center; justify-content:space-between;
          padding: 16px 24px;
          background: var(--app-header-background-color, var(--primary-color));
          color: var(--app-header-text-color, var(--text-primary-color, #fff));
        }
        .title { display:flex; align-items:center; gap:12px; }
        .title h1 { font-size:20px; margin:0; font-weight:500; }
        .actions { display:flex; gap:8px; }

        .body { display:flex; flex:1; min-height:0; }
        .sidebar {
          width: 280px;
          background: var(--card-background-color);
          border-right: 1px solid var(--divider-color);
          padding: 16px;
          overflow-y: auto;
        }
        .section-title {
          text-transform: uppercase;
          font-size: 11px;
          letter-spacing: .04em;
          opacity: .6;
          margin-bottom: 8px;
        }
        .menu-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
        .menu-list li {
          padding: 8px 12px;
          border-radius: 8px;
          cursor: pointer;
          border: 1px solid transparent;
        }
        .menu-list li:hover { background: var(--secondary-background-color); }
        .menu-list li.selected {
          background: color-mix(in srgb, var(--primary-color) 15%, transparent);
          border-color: var(--primary-color);
        }
        .menu-name { font-weight: 500; }
        .menu-id { font-size: 12px; opacity: .65; margin-top: 2px; }

        .editor { flex:1; padding: 24px; overflow-y: auto; }
        .form { max-width: 920px; display:flex; flex-direction:column; gap:18px; }
        .form-row { display:flex; gap:16px; }
        .form-row.two-col .field { flex:1; }
        .field { display:flex; flex-direction:column; gap:6px; }
        .field label { font-size:12px; opacity:.75; }
        .field input, .field select {
          padding: 10px 12px;
          border-radius: 8px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-size: 14px;
          font-family: inherit;
        }
        .field input:focus, .field select:focus {
          outline: 2px solid var(--primary-color);
          outline-offset: 1px;
          border-color: var(--primary-color);
        }
        .hint { font-size:12px; opacity:.6; }
        .hint code {
          padding: 1px 4px;
          background: var(--secondary-background-color);
          border-radius: 4px;
          font-size: 11px;
        }

        .items-header { display:flex; align-items:center; justify-content:space-between; margin-top: 8px; }
        .items-header h2 { font-size:16px; margin:0; }
        .items { display:flex; flex-direction:column; gap:8px; }
        .item-row {
          display:flex; align-items:flex-start; gap:8px;
          padding: 12px;
          border-radius: 10px;
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
        }
        .reorder {
          display:flex; flex-direction:column; align-items:center; gap:2px;
          padding-top: 22px;
        }
        .reorder button, .item-row .del {
          background: transparent;
          border: 0;
          padding: 4px;
          cursor: pointer;
          color: var(--primary-text-color);
          opacity: .7;
          border-radius: 4px;
        }
        .reorder button:hover, .item-row .del:hover { opacity:1; background: var(--secondary-background-color); }
        .reorder button:disabled { opacity:.2; cursor: default; }
        .reorder .pos { font-size: 11px; opacity:.6; }
        .item-fields {
          flex:1; display:grid;
          grid-template-columns: 1fr 1fr 1.5fr 0.8fr;
          gap: 8px;
        }
        .item-row .del { align-self: center; }

        .danger-zone {
          margin-top: 24px;
          padding-top: 16px;
          border-top: 1px solid var(--divider-color);
        }
        .danger-zone mwc-button {
          --mdc-theme-primary: var(--error-color, #db4437);
        }

        .empty, .empty-state {
          padding: 16px;
          opacity: .75;
          text-align: center;
        }
        .empty-state { padding: 64px 16px; }
        .empty-state .big {
          --mdc-icon-size: 64px;
          opacity: .4;
          margin-bottom: 12px;
        }
        .empty-state p { margin: 4px 0; }
        .empty-state .hint { opacity: .55; max-width: 480px; margin: 12px auto 0; }

        .banner {
          padding: 10px 24px;
          font-size: 13px;
        }
        .banner.ok { background: color-mix(in srgb, var(--success-color, #4caf50) 20%, transparent); }
        .banner.error { background: color-mix(in srgb, var(--error-color, #db4437) 20%, transparent); }

        .footer {
          padding: 12px 24px;
          font-size: 12px;
          opacity: .65;
          border-top: 1px solid var(--divider-color);
        }

        @media (max-width: 720px) {
          .body { flex-direction: column; }
          .sidebar { width: auto; border-right: 0; border-bottom: 1px solid var(--divider-color); }
          .item-fields { grid-template-columns: 1fr 1fr; }
          .form-row { flex-direction: column; }
        }
      </style>
    `;
  }
}

if (!customElements.get("navigation-menu-manager-panel")) {
  customElements.define("navigation-menu-manager-panel", NavigationMenuManagerPanel);
}
