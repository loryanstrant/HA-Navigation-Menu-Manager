/*!
 * Navigation Menu Manager — Admin Panel
 * https://github.com/loryanstrant/HA-Navigation-Menu-Manager
 */
const PANEL_VERSION = "0.2.0";
const DOMAIN = "navigation_menu_manager";

// eslint-disable-next-line no-console
console.info(
  `%c NAVIGATION-MENU-MANAGER-PANEL %c v${PANEL_VERSION} `,
  "color: white; background: #03a9f4; font-weight: 700;",
  "color: #03a9f4; background: white; font-weight: 700;"
);

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

/* --------------------------- HA form plumbing ---------------------------- */

/*
 * Every field on this panel is a Home Assistant component driven by `ha-form`,
 * rather than the hand-built `<input>`/`<select>` this replaced. The panel sits
 * among HA's own settings screens, and browser-default controls match neither
 * them nor the active theme; and it used to ask for `mdi:home` and
 * `/lovelace/climate` to be typed from memory, which is a raw identifier in
 * exactly the field that has to be right.
 *
 * The structural half matters more. The old `_render()` assigned `innerHTML`
 * over the whole screen on every `change` event, destroying every field on it —
 * which is why the code carried a comment explaining that it must not re-render
 * while you type. That is a guard, and the next edit to `_render()` undoes it.
 * Here the screen is built once and afterwards only `.hass`, `.schema` and
 * `.data` are assigned, so Lit patches in place and the fault cannot occur.
 */

const STYLE_OPTIONS = [
  { value: "buttons", label: "Buttons — icon above label" },
  { value: "icons", label: "Icons only" },
  { value: "compact", label: "Compact — icon beside label" },
];

const MATCH_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "exact", label: "Exact" },
  { value: "prefix", label: "Starts with" },
  { value: "suffix", label: "Ends with" },
];

const MENU_SCHEMA = [
  {
    type: "grid",
    schema: [
      { name: "id", required: true, selector: { text: {} } },
      { name: "name", selector: { text: {} } },
    ],
  },
  {
    name: "style",
    required: true,
    selector: { select: { mode: "dropdown", options: STYLE_OPTIONS } },
  },
];

const MENU_LABELS = {
  id: "Menu ID",
  name: "Display name",
  style: "Default style",
};

const MENU_HELPERS = {
  id: "How a card refers to this menu. Letters, digits, dashes and underscores only.",
  // Not "the list on the left": below 720px the menu list sits above the form,
  // and copy that names a position is wrong on half the screens it renders on.
  name: "What you'll see in the menu list, and in the card editor.",
};

const ITEM_SCHEMA = [
  {
    type: "grid",
    // Side by side on a wide screen, collapsing as the panel narrows. HA's grid
    // does that on its own from a minimum column width, so there is no media
    // query to keep in sync.
    column_min_width: "180px",
    schema: [
      { name: "label", required: true, selector: { text: {} } },
      { name: "icon", selector: { icon: {} } },
      { name: "match_mode", selector: { select: { mode: "dropdown", options: MATCH_OPTIONS } } },
    ],
  },
];

/*
 * Path is rendered on its own, full width, under a caption we draw ourselves —
 * not as a fourth column of the grid above.
 *
 * `ha-navigation-picker` hands its label down to the picker as a *placeholder*
 * rather than a floating label, so the moment the field has a value the caption
 * disappears and the field reads as an unlabelled box. Every other field in the
 * row keeps its caption, which made that one look broken. Drawing the caption
 * ourselves is the only way to keep it visible without reaching into HA's
 * shadow DOM to flip a private property.
 *
 * Full width is a bonus rather than a workaround: paths are the longest values
 * in the row and were being truncated mid-word in a quarter-width column.
 */
const PATH_SELECTOR = { navigation: {} };

const ITEM_LABELS = {
  label: "Label",
  icon: "Icon",
  path: "Path or URL",
  match_mode: "Match",
};

/**
 * `match` is stored absent (or empty) for automatic, and "exact"/"prefix"/
 * "suffix" otherwise — three states, so a boolean cannot express it and the
 * dropdown needs a sentinel. Mapped in both directions so a menu saved by the
 * old panel loads unchanged.
 */
function itemToFormData(item) {
  return {
    label: item.label || "",
    icon: item.icon || "",
    match_mode: item.match || "auto",
  };
}

function formDataToItem(value) {
  return {
    label: value.label || "",
    icon: value.icon || "",
    match: value.match_mode && value.match_mode !== "auto" ? value.match_mode : "",
  };
}

/**
 * Make sure Home Assistant's form components are defined before one is built.
 *
 * `window.customElements` is re-read on every call rather than captured: HA
 * swaps it for a scoped-registry polyfill while its core bundle boots. That is
 * also why this must never be a top-level `customElements.whenDefined()` —
 * such a binding attaches to the native registry's method and may never fire.
 *
 * Unlike the card editor, this panel is *not* the card dialog. Poking a
 * Lovelace card for its config element (Mushroom's trick) only works where one
 * is already defined, and a cold reload straight onto /navigation-menus may
 * have no `hui-*` card at all — so `loadCardHelpers()` is the path that
 * actually matters here, not the belt-and-braces.
 */
async function loadHaComponents() {
  if (window.customElements.get("ha-form")) return;

  const tile = window.customElements.get("hui-tile-card");
  if (tile && tile.getConfigElement) {
    try {
      tile.getConfigElement();
    } catch (_) {
      /* noop — fall through to the helpers path */
    }
  }
  if (window.customElements.get("ha-form")) return;

  if (typeof window.loadCardHelpers === "function") {
    try {
      const helpers = await window.loadCardHelpers();
      const el = await helpers.createCardElement({ type: "entities", entities: [] });
      if (el && el.constructor && el.constructor.getConfigElement) {
        await el.constructor.getConfigElement();
      }
    } catch (_) {
      /* noop */
    }
  }
}

/**
 * `ha-button` is the current Home Assistant button; `mwc-button` is what this
 * panel used before and what older frontends define. Whichever is registered
 * once the form chunk has loaded is the one that will actually render, so the
 * choice is made from the registry rather than assumed.
 */
function buttonTag() {
  return window.customElements.get("ha-button") ? "ha-button" : "mwc-button";
}

/* --------------------------------- panel --------------------------------- */

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
    this._els = null; // built-once element references
    this._itemRows = new Map(); // item _key -> { root, form, up, down, pos }
    this._bannerKey = null;
    this._confirmResolve = null;
  }

  /* ---------- HA panel API ---------- */

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._boot();
    } else {
      // HA hands a panel a fresh `hass` constantly. Push it down to the forms
      // that need it to resolve their selectors, and touch nothing else: a
      // re-render here is what used to destroy the field being typed into.
      this._pushHass();
    }
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

  async _boot() {
    // Paint a frame straight away so the panel is never a blank page, then wait
    // for HA's form components before building anything that uses them — the
    // skeleton picks its button tag from the registry, so it must be built on
    // the far side of this await.
    this.shadowRoot.innerHTML = `
      ${this._styles()}
      <div class="layout">
        <header class="topbar">
          <div class="title">
            <ha-icon icon="mdi:menu"></ha-icon>
            <h1>Navigation Menus</h1>
          </div>
        </header>
        <div class="empty-state"><p>Loading…</p></div>
      </div>
    `;
    await loadHaComponents();
    if (!window.customElements.get("ha-form")) {
      // Not fatal — the elements upgrade if the chunk lands later — but it is
      // the one failure that would leave this panel looking empty, so say so.
      // eslint-disable-next-line no-console
      console.warn("[navigation-menu-manager] ha-form is not defined yet; fields may be blank.");
    }
    this._render();
    await this._load();
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
        if (ids.length) {
          await this._select(ids[0]);
          return;
        }
      }
      this._render();
    } catch (e) {
      this._status = { kind: "error", text: "Could not load menus." };
      this._render();
    }
  }

  async _select(id) {
    if (this._dirty && !(await this._confirmDiscard())) return;
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

  async _newMenu() {
    if (this._dirty && !(await this._confirmDiscard())) return;
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
      this._busy = false;
      this._status = { kind: "ok", text: "Saved." };
      const res = await this._hass.callWS({ type: `${DOMAIN}/list_menus` });
      this._menus = res.menus || {};
      const saved = this._status;
      await this._select(id);
      this._status = saved;
      this._render();
    } catch (e) {
      this._status = { kind: "error", text: `Save failed: ${e?.message || e}` };
      this._busy = false;
      this._render();
    }
  }

  async _deleteSelected() {
    if (!this._selectedId) return;
    const name = this._menus[this._selectedId]?.name || this._selectedId;
    const ok = await this._confirm({
      title: "Delete this menu?",
      text: `Cards using "${name}" will stop working until you point them at another menu. This cannot be undone.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;

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
      const res = await this._hass.callWS({ type: `${DOMAIN}/list_menus` });
      this._menus = res.menus || {};
    } catch (e) {
      this._status = { kind: "error", text: `Delete failed: ${e?.message || e}` };
    } finally {
      this._busy = false;
      this._render();
    }
  }

  /* ---------- draft mutations ---------- */

  _markDirty() {
    this._dirty = true;
    // Only the save affordance depends on this. Deliberately not a re-render:
    // the field the user is in must survive their own keystrokes.
    this._updateActions();
  }

  _addItem() {
    this._draft.items = [
      ...this._draft.items,
      { _key: uid(), label: "", icon: "", path: "", match: "" },
    ];
    this._markDirty();
    this._syncItems();
  }

  _removeItem(key) {
    this._draft.items = this._draft.items.filter((it) => it._key !== key);
    this._markDirty();
    this._syncItems();
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
    this._markDirty();
    this._syncItems();
  }

  /* ---------- confirmation ---------- */

  _confirmDiscard() {
    return this._confirm({
      title: "Discard unsaved changes?",
      text: "You have edits to this menu that haven't been saved. Leaving now loses them.",
      confirmText: "Discard",
      destructive: true,
    });
  }

  /** Home Assistant's own dialog, in place of the browser's confirm() box. */
  _confirm({ title, text, confirmText, destructive }) {
    const els = this._els;
    if (!els || !els.confirm) return Promise.resolve(window.confirm(text));
    return new Promise((resolve) => {
      this._settleConfirm(false);
      els.confirm.heading = title;
      els.confirmText.textContent = text;
      els.confirmOk.textContent = confirmText || "Confirm";
      els.confirmOk.classList.toggle("destructive", !!destructive);
      this._confirmResolve = resolve;
      els.confirm.open = true;
    });
  }

  _settleConfirm(result) {
    const resolve = this._confirmResolve;
    this._confirmResolve = null;
    if (resolve) resolve(result);
  }

  /* ---------- render: build once, then patch ---------- */

  _render() {
    if (!this._els) this._buildSkeleton();
    this._updateActions();
    this._updateBanner();
    this._updateSidebar();
    this._updateEditor();
  }

  _pushHass() {
    if (!this._els) return;
    if (this._els.menuForm) this._els.menuForm.hass = this._hass;
    this._itemRows.forEach((row) => {
      row.form.hass = this._hass;
      row.path.hass = this._hass;
    });
  }

  _buildSkeleton() {
    const btn = buttonTag();
    this.shadowRoot.innerHTML = `
      ${this._styles()}
      <div class="layout">
        <header class="topbar">
          <div class="title">
            <ha-icon icon="mdi:menu"></ha-icon>
            <h1>Navigation Menus</h1>
          </div>
          <div class="actions">
            <${btn} raised id="save">Save</${btn}>
            <${btn} outlined id="new">+ New menu</${btn}>
          </div>
        </header>

        <div id="banner"></div>

        <div class="body">
          <aside class="sidebar">
            <div class="section-title">Your menus</div>
            <div id="menu-list"></div>
          </aside>

          <main class="editor">
            <div class="empty-state" id="empty-state">
              <ha-icon icon="mdi:gesture-tap" class="big"></ha-icon>
              <p>Select a menu on the left, or click <strong>+ New menu</strong> to create one.</p>
              <p class="hint">A menu is a reusable set of buttons (label + icon + URL/view) that you can drop onto any dashboard using the Navigation Menu card.</p>
            </div>

            <div class="form" id="form" hidden>
              <ha-form id="menu-form"></ha-form>

              <div class="items-header">
                <h2>Items</h2>
                <${btn} outlined id="add-item">+ Add item</${btn}>
              </div>
              <div class="hint">
                Each item is one button. Pick a view from the list, or type a bare view id
                (<code>climate</code>) or an external link (<code>https://…</code>).
              </div>

              <div class="empty" id="no-items" hidden>
                No items yet. Click <strong>+ Add item</strong> to add a button.
              </div>
              <div class="items" id="items"></div>

              <div class="danger-zone" id="danger-zone" hidden>
                <${btn} id="delete" class="destructive">Delete this menu</${btn}>
              </div>
            </div>
          </main>
        </div>

        <footer class="footer">
          Add the <strong>Navigation Menu</strong> card to any view and reference a menu id.
          The card shows a live preview in the card picker.
        </footer>
      </div>

      <ha-dialog id="confirm">
        <div id="confirm-text"></div>
        <${btn} slot="secondaryAction" dialogAction="cancel">Cancel</${btn}>
        <${btn} slot="primaryAction" id="confirm-ok">Confirm</${btn}>
      </ha-dialog>
    `;

    const $ = (id) => this.shadowRoot.getElementById(id);
    this._els = {
      save: $("save"),
      new: $("new"),
      banner: $("banner"),
      menuList: $("menu-list"),
      emptyState: $("empty-state"),
      form: $("form"),
      menuForm: $("menu-form"),
      addItem: $("add-item"),
      noItems: $("no-items"),
      items: $("items"),
      dangerZone: $("danger-zone"),
      delete: $("delete"),
      confirm: $("confirm"),
      confirmText: $("confirm-text"),
      confirmOk: $("confirm-ok"),
    };

    this._els.save.addEventListener("click", () => this._save());
    this._els.new.addEventListener("click", () => this._newMenu());
    this._els.addItem.addEventListener("click", () => this._addItem());
    this._els.delete.addEventListener("click", () => this._deleteSelected());

    this._els.menuForm.computeLabel = (schema) => MENU_LABELS[schema.name] || schema.name;
    this._els.menuForm.computeHelper = (schema) => MENU_HELPERS[schema.name] || "";
    // Schema and data go on at creation, never later. `ha-form.render()` iterates
    // its schema, so a form that reaches the document without one throws
    // "e is not iterable" from HA's own conditions.ts — and this form is in the
    // skeleton, while _updateEditor() returns early when no menu is selected.
    this._els.menuForm.schema = MENU_SCHEMA;
    this._els.menuForm.data = {};
    this._els.menuForm.addEventListener("value-changed", (event) => {
      event.stopPropagation();
      const value = event.detail.value;
      this._draft = { ...this._draft, id: value.id, name: value.name, style: value.style };
      // Feed the value straight back: ha-form renders from `.data` and does not
      // update it itself, so without this the field would show the old text.
      // Lit patches the same nodes, so the caret stays where it was.
      this._els.menuForm.data = value;
      this._markDirty();
    });

    this._els.confirmOk.addEventListener("click", () => {
      this._els.confirm.open = false;
      this._settleConfirm(true);
    });
    this._els.confirm.addEventListener("closed", () => this._settleConfirm(false));
  }

  _updateActions() {
    const els = this._els;
    els.save.hidden = !this._draft;
    els.save.disabled = !!this._busy;
    els.save.textContent = this._busy ? "Saving…" : "Save";
    els.new.disabled = !!this._busy;
  }

  _updateBanner() {
    const key = this._status ? `${this._status.kind}|${this._status.text}` : "";
    if (key === this._bannerKey) return;
    this._bannerKey = key;
    this._els.banner.textContent = "";
    if (!this._status) return;
    // ha-alert carries an icon per severity as well as the sentence, so the
    // status never depends on colour alone.
    const alert = document.createElement("ha-alert");
    alert.setAttribute("alert-type", this._status.kind === "ok" ? "success" : "error");
    alert.textContent = this._status.text;
    this._els.banner.appendChild(alert);
  }

  _updateSidebar() {
    const ids = Object.keys(this._menus).sort();
    // No editable controls in here, so rebuilding this subtree is safe.
    this._els.menuList.innerHTML =
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
           </ul>`;
    this._els.menuList.querySelectorAll(".menu-list li").forEach((el) => {
      el.addEventListener("click", () => this._select(el.dataset.id));
    });
  }

  _updateEditor() {
    const draft = this._draft;
    this._els.emptyState.hidden = !!draft;
    this._els.form.hidden = !draft;
    if (!draft) return;

    this._els.menuForm.hass = this._hass;
    this._els.menuForm.schema = MENU_SCHEMA;
    this._els.menuForm.data = { id: draft.id, name: draft.name, style: draft.style };

    this._els.dangerZone.hidden = !this._selectedId;
    this._els.delete.disabled = !!this._busy;
    this._syncItems();
  }

  _syncItems() {
    const items = (this._draft && this._draft.items) || [];
    const container = this._els.items;
    this._els.noItems.hidden = items.length > 0;

    const seen = new Set();
    items.forEach((item, index) => {
      seen.add(item._key);
      let row = this._itemRows.get(item._key);
      if (!row) {
        row = this._buildItemRow(item._key);
        this._itemRows.set(item._key, row);
      }
      // Reuse the node and move it, rather than rebuilding: the form inside
      // holds the user's in-progress edits.
      if (container.children[index] !== row.root) {
        container.insertBefore(row.root, container.children[index] || null);
      }
      row.pos.textContent = String(index + 1);
      // Attribute rather than property: it drives both the element's own
      // disabled handling and the CSS that dims it.
      row.up.toggleAttribute("disabled", index === 0);
      row.down.toggleAttribute("disabled", index === items.length - 1);
      row.form.hass = this._hass;
      row.form.schema = ITEM_SCHEMA;
      row.form.data = itemToFormData(item);
      row.path.hass = this._hass;
      row.path.value = item.path || "";
    });

    this._itemRows.forEach((row, key) => {
      if (!seen.has(key)) {
        row.root.remove();
        this._itemRows.delete(key);
      }
    });
  }

  _buildItemRow(key) {
    const root = document.createElement("div");
    root.className = "item-row";
    root.dataset.item = key;
    // Controls on a header line above the fields, rather than as rails down
    // either side. The four fields wrap to two lines at most widths, which used
    // to stretch the reorder column to the full height of the row and leave the
    // bin floating in the middle of it.
    root.innerHTML = `
      <div class="item-head">
        <span class="pos"></span>
        <ha-icon-button class="up" label="Move up">
          <ha-icon icon="mdi:chevron-up"></ha-icon>
        </ha-icon-button>
        <ha-icon-button class="down" label="Move down">
          <ha-icon icon="mdi:chevron-down"></ha-icon>
        </ha-icon-button>
        <span class="spacer"></span>
        <ha-icon-button class="del" label="Remove item">
          <ha-icon icon="mdi:trash-can-outline"></ha-icon>
        </ha-icon-button>
      </div>
      <ha-form class="item-fields"></ha-form>
      <div class="item-path">
        <span class="field-caption">${esc(ITEM_LABELS.path)} *</span>
        <ha-selector class="path-selector"></ha-selector>
      </div>
    `;

    const form = root.querySelector("ha-form");
    form.computeLabel = (schema) => ITEM_LABELS[schema.name] || schema.name;
    // Before the row is ever attached — see the note on the menu form.
    form.schema = ITEM_SCHEMA;
    form.data = itemToFormData({});
    form.addEventListener("value-changed", (event) => {
      event.stopPropagation();
      const value = event.detail.value;
      const item = this._draft.items.find((it) => it._key === key);
      if (item) Object.assign(item, formDataToItem(value));
      // See the menu form: ha-form renders from `.data`, so hand it back.
      form.data = value;
      this._markDirty();
    });

    const path = root.querySelector(".path-selector");
    path.selector = PATH_SELECTOR;
    path.required = true;
    path.addEventListener("value-changed", (event) => {
      event.stopPropagation();
      const item = this._draft.items.find((it) => it._key === key);
      if (item) item.path = event.detail.value || "";
      path.value = event.detail.value || "";
      this._markDirty();
    });

    const up = root.querySelector(".up");
    const down = root.querySelector(".down");
    up.addEventListener("click", () => this._moveItem(key, -1));
    down.addEventListener("click", () => this._moveItem(key, 1));
    root.querySelector(".del").addEventListener("click", () => this._removeItem(key));

    return { root, form, path, up, down, pos: root.querySelector(".pos") };
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
        /* Several containers below set an explicit display, which would beat
           the user-agent rule for [hidden] and leave "hidden" panes visible. */
        [hidden] { display: none !important; }
        .layout { display:flex; flex-direction:column; height:100%; min-height:100vh; }
        .topbar {
          display:flex; align-items:center; justify-content:space-between;
          padding: 16px 24px;
          background: var(--app-header-background-color, var(--primary-color));
          color: var(--app-header-text-color, var(--text-primary-color, #fff));
        }
        .title { display:flex; align-items:center; gap:12px; }
        .title h1 { font-size:20px; margin:0; font-weight:500; }
        .actions { display:flex; gap:8px; align-items:center; }
        .actions ha-button, .actions mwc-button {
          --mdc-theme-primary: var(--app-header-text-color, var(--text-primary-color, #fff));
        }

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
          display:flex; flex-direction:column; gap:4px;
          padding: 8px 12px 12px;
          border-radius: 10px;
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
        }
        .item-head { display:flex; align-items:center; gap:2px; }
        .item-head .spacer { flex:1; }
        .item-head ha-icon-button {
          --mdc-icon-button-size: 32px;
          --mdc-icon-size: 20px;
          color: var(--primary-text-color);
        }
        /* Material's disabled opacity. At .25 the arrow read as missing rather
           than unavailable, which is a different thing to tell someone. */
        .item-head ha-icon-button[disabled] { opacity:.38; }
        .item-head .pos {
          font-size: 12px; opacity:.6; font-weight:500;
          min-width: 18px; text-align:center; margin-right: 4px;
        }
        .item-head .del { color: var(--error-color, #db4437); }
        .item-fields { display:block; min-width:0; }
        .item-path { display:block; margin-top: 8px; }
        /* Matches HA's own top-label treatment: same size, same muted tone. */
        .field-caption {
          display:block;
          font-size: 12px;
          color: var(--secondary-text-color);
          margin: 0 0 4px 4px;
        }

        .danger-zone {
          margin-top: 24px;
          padding-top: 16px;
          border-top: 1px solid var(--divider-color);
        }
        .destructive { --mdc-theme-primary: var(--error-color, #db4437); }

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

        #banner ha-alert { display:block; }

        .footer {
          padding: 12px 24px;
          font-size: 12px;
          opacity: .65;
          border-top: 1px solid var(--divider-color);
        }

        @media (max-width: 720px) {
          .body { flex-direction: column; }
          .sidebar { width: auto; border-right: 0; border-bottom: 1px solid var(--divider-color); }
          .editor { padding: 16px; }
          .topbar { padding: 12px 16px; }
        }
      </style>
    `;
  }
}

if (!customElements.get("navigation-menu-manager-panel")) {
  customElements.define("navigation-menu-manager-panel", NavigationMenuManagerPanel);
}
