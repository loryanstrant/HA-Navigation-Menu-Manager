/*!
 * Navigation Menu Manager — Lovelace card
 * https://github.com/loryanstrant/navigation-menu-manager
 */
const CARD_VERSION = "0.1.5";
const DOMAIN = "navigation_menu_manager";

// How long to wait before showing a visible "Loading…" placeholder. Below
// this threshold the card stays blank (zero-height) so a fast subscribe
// never produces a visible flash/flicker.
const LOADING_PLACEHOLDER_DELAY_MS = 400;
// One automatic retry after a failed subscribe, after this backoff.
const SUBSCRIBE_RETRY_MS = 2000;

// eslint-disable-next-line no-console
console.info(
  `%c NAVIGATION-MENU-MANAGER-CARD %c v${CARD_VERSION} `,
  "color: white; background: #03a9f4; font-weight: 700;",
  "color: #03a9f4; background: white; font-weight: 700;"
);

/* ----------------------------- path matching ----------------------------- */

function pathSegments(p) {
  return (p || "").split("/").filter(Boolean);
}

function matchExact(current, path) {
  return current === path || current.replace(/\/$/, "") === path.replace(/\/$/, "");
}

function matchSuffix(current, path) {
  return current.endsWith(path);
}

function matchPrefix(current, path) {
  return current.startsWith(path);
}

function matchDefault(current, path) {
  // If user gave a full path (starts with "/"), match exactly or as a prefix
  // up to the next segment boundary.
  if (path.startsWith("/")) {
    const a = current.replace(/\/$/, "");
    const b = path.replace(/\/$/, "");
    return a === b || a.startsWith(b + "/");
  }
  // Otherwise it's a view id — match against the last segment of the URL.
  const segs = pathSegments(current);
  return segs[segs.length - 1] === path;
}

function isItemActive(currentPath, item) {
  const matcher =
    item.match === "exact"
      ? matchExact
      : item.match === "suffix"
      ? matchSuffix
      : item.match === "prefix"
      ? matchPrefix
      : matchDefault;
  try {
    return matcher(currentPath, item.path);
  } catch (_) {
    return false;
  }
}

/* --------------------------------- card --------------------------------- */

class NavigationMenuManagerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._menu = null;
    this._state = "idle"; // idle | loading | ready | not_found | error
    this._errorMsg = null;
    this._unsub = null; // subscription unsub function (sync)
    this._loadGen = 0; // increments each (re)connect; used to ignore stale callbacks
    this._currentPath = window.location.pathname;
    this._hasRenderedMenu = false; // whether a real menu has ever been shown
    this._loadingTimer = null; // delayed "Loading…" placeholder timer
    this._retryTimer = null; // one-shot subscribe retry timer
    this._retriedGen = -1; // generation we've already retried, to retry only once
    this._onLocationChanged = this._onLocationChanged.bind(this);
  }

  /* ---------- lifecycle ---------- */

  connectedCallback() {
    window.addEventListener("location-changed", this._onLocationChanged);
    window.addEventListener("popstate", this._onLocationChanged);
    this._maybeConnect();
  }

  disconnectedCallback() {
    window.removeEventListener("location-changed", this._onLocationChanged);
    window.removeEventListener("popstate", this._onLocationChanged);
    this._teardown();
  }

  /* ---------- HA card API ---------- */

  setConfig(config) {
    if (!config || !config.menu) {
      throw new Error('Navigation Menu card: "menu" is required.');
    }
    const prevMenu = this._config && this._config.menu;
    this._config = { ...config };
    if (prevMenu !== config.menu) {
      // Different menu — wipe state and reconnect.
      this._menu = null;
      this._state = "idle";
      this._errorMsg = null;
      this._hasRenderedMenu = false;
      this._teardown();
      this._maybeConnect();
    }
    this._render();
  }

  getCardSize() {
    return 1;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._maybeConnect();
  }

  static getConfigElement() {
    return document.createElement("navigation-menu-manager-card-editor");
  }

  static async getStubConfig(hass) {
    // Pick a real existing menu id if the user has any defined; otherwise
    // fall back to "main" so the card renders a helpful empty-state message
    // pointing the user at the panel.
    try {
      if (hass && hass.callWS) {
        const res = await hass.callWS({ type: `${DOMAIN}/list_menus` });
        const ids = Object.keys((res && res.menus) || {});
        if (ids.length) {
          return { type: `custom:navigation-menu-manager-card`, menu: ids[0] };
        }
      }
    } catch (_) {
      /* ignore — fall through to the default */
    }
    return { type: `custom:navigation-menu-manager-card`, menu: "main" };
  }

  /* ---------- internals ---------- */

  _onLocationChanged() {
    const newPath = window.location.pathname;
    if (newPath !== this._currentPath) {
      this._currentPath = newPath;
      this._render();
    }
  }

  _clearTimers() {
    if (this._loadingTimer) {
      clearTimeout(this._loadingTimer);
      this._loadingTimer = null;
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  _teardown() {
    // Invalidate any in-flight subscribe callback by bumping the generation
    this._loadGen += 1;
    this._clearTimers();
    if (this._unsub) {
      try {
        this._unsub();
      } catch (_) {
        /* noop */
      }
      this._unsub = null;
    }
  }

  _maybeConnect() {
    if (!this._hass || !this._config) return;
    if (this._unsub) return; // already connected
    if (this._state === "loading") return; // connect in flight

    const gen = ++this._loadGen;
    const menuId = this._config.menu;
    this._state = "loading";

    // Don't paint a visible "Loading…" immediately — that's what causes the
    // flicker when the subscribe resolves a moment later. Only show it if
    // loading actually drags on. If a menu was previously rendered, keep it
    // on screen instead (transient reconnect should not blank the nav).
    this._clearTimers();
    if (!this._hasRenderedMenu) {
      this._render(); // renders an empty, zero-height card (see _render)
      this._loadingTimer = setTimeout(() => {
        this._loadingTimer = null;
        if (gen === this._loadGen && this._state === "loading") {
          this._renderLoadingPlaceholder();
        }
      }, LOADING_PLACEHOLDER_DELAY_MS);
    }

    this._hass.connection
      .subscribeMessage(
        (event) => {
          // Ignore stale events from a previous subscription that we
          // haven't finished tearing down.
          if (gen !== this._loadGen) return;
          this._clearTimers();
          if (!event) {
            this._state = "not_found";
            this._menu = null;
          } else if (event.menu) {
            this._state = "ready";
            this._menu = event.menu;
            this._hasRenderedMenu = true;
          } else {
            this._state = "not_found";
            this._menu = null;
          }
          this._render();
        },
        {
          type: `${DOMAIN}/subscribe_menu`,
          menu_id: menuId,
        }
      )
      .then((unsub) => {
        if (gen !== this._loadGen) {
          // We were torn down before subscribe finished — unsub immediately.
          try {
            unsub();
          } catch (_) {
            /* noop */
          }
          return;
        }
        this._unsub = unsub;
      })
      .catch((err) => {
        if (gen !== this._loadGen) return;
        this._clearTimers();
        // eslint-disable-next-line no-console
        console.error("[navigation-menu-manager] subscribe failed", err);

        // Attempt one automatic retry before surfacing an error — handles
        // transient connection blips and races during HA reloads.
        if (this._retriedGen !== gen) {
          this._retriedGen = gen;
          this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            if (gen === this._loadGen && !this._unsub) {
              this._state = "idle";
              this._maybeConnect();
            }
          }, SUBSCRIBE_RETRY_MS);
          return;
        }

        // Retry already used. If we have a previously-rendered menu, keep it
        // on screen rather than replacing it with an error box. Only show the
        // error state when we have nothing else to show.
        if (this._hasRenderedMenu) {
          this._state = "ready";
          this._render();
          return;
        }
        this._state = "error";
        this._errorMsg = err && err.message ? err.message : String(err);
        this._render();
      });
  }

  /* ---------- navigation ---------- */

  _dashboardRoot() {
    const parts = pathSegments(window.location.pathname);
    return parts[0] || "lovelace";
  }

  _resolvePath(path) {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return { external: true, href: path };
    if (path.startsWith("/")) return { external: false, href: path };
    return { external: false, href: `/${this._dashboardRoot()}/${path}` };
  }

  _onItemClick(item, event) {
    const resolved = this._resolvePath(item.path);
    if (!resolved) return;
    if (resolved.external) {
      const target = event && (event.ctrlKey || event.metaKey) ? "_blank" : "_self";
      window.open(resolved.href, target);
      return;
    }
    history.pushState(null, "", resolved.href);
    window.dispatchEvent(
      new CustomEvent("location-changed", { detail: { replace: false } })
    );
  }

  /* ---------- rendering ---------- */

  _renderLoadingPlaceholder() {
    this._setHtml(`
      <ha-card><div class="placeholder">Loading navigation menu…</div></ha-card>
    `);
  }

  _render() {
    if (!this._config) return;

    if (this._state === "loading" || this._state === "idle") {
      // While (re)connecting: if we already have a menu, keep showing it;
      // otherwise render a blank, zero-height card so nothing flickers. A
      // visible "Loading…" is shown separately, only after a short delay.
      if (this._hasRenderedMenu && this._menu) {
        this._renderMenu();
      } else {
        this._setHtml(`<ha-card class="nmm-blank"></ha-card>`);
      }
      return;
    }

    if (this._state === "error") {
      this._setHtml(`
        <ha-card><div class="err">
          Could not load menu "<strong>${escapeHtml(this._config.menu)}</strong>": ${escapeHtml(
        this._errorMsg || "unknown error"
      )}
        </div></ha-card>
      `);
      return;
    }

    if (this._state === "not_found" || !this._menu) {
      this._setHtml(`
        <ha-card><div class="err">
          Menu "<strong>${escapeHtml(
            this._config.menu
          )}</strong>" is not defined. Open the <strong>Nav Menus</strong> sidebar entry to create it.
        </div></ha-card>
      `);
      return;
    }

    this._renderMenu();
  }

  _renderMenu() {
    const items = Array.isArray(this._menu.items) ? this._menu.items : [];
    const style = this._config.style || this._menu.style || "buttons";
    const columns =
      this._config.columns && Number(this._config.columns) > 0
        ? Number(this._config.columns)
        : items.length || 1;
    const cardStyle = this._config.card_style !== false;
    const seamless = this._config.seamless === true;

    if (items.length === 0) {
      const inner = `<div class="placeholder">Menu "${escapeHtml(
        this._menu.name || this._config.menu
      )}" has no items.</div>`;
      this._setHtml(cardStyle ? `<ha-card>${inner}</ha-card>` : inner);
      return;
    }

    const renderedItems = items
      .map((item, i) => {
        const active = isItemActive(this._currentPath, item);
        const iconHtml = item.icon
          ? `<ha-icon icon="${escapeHtml(item.icon)}"></ha-icon>`
          : "";
        const labelHtml =
          style === "icons" ? "" : `<div class="label">${escapeHtml(item.label)}</div>`;
        return `
          <button class="item ${active ? "active" : ""}" data-index="${i}" type="button"
                  aria-current="${active ? "page" : "false"}" title="${escapeHtml(item.label)}">
            ${iconHtml}${labelHtml}
          </button>`;
      })
      .join("");

    const menuClasses = [style, seamless ? "seamless" : ""].filter(Boolean).join(" ");
    const inner = `<div class="menu ${menuClasses}" role="navigation" data-columns="${columns}">${renderedItems}</div>`;
    const cardClasses = seamless ? "seamless" : "";
    this._setHtml(
      cardStyle ? `<ha-card class="${cardClasses}">${inner}</ha-card>` : inner,
      columns
    );

    if (!this.shadowRoot) return;
    this.shadowRoot.querySelectorAll(".item").forEach((el) => {
      el.addEventListener("click", (event) => {
        const idx = Number(el.dataset.index);
        const item = items[idx];
        if (item) this._onItemClick(item, event);
      });
    });
  }

  _setHtml(body, columns = 1) {
    // Guard against teardown races where shadowRoot may be gone.
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `${this._styles(columns)}${body}`;
  }

  _styles(columns) {
    return `
      <style>
        :host { display:block; }
        ha-card { padding: var(--nmm-card-padding, 8px); }
        /* blank card while (re)connecting — occupies no visible space */
        ha-card.nmm-blank {
          padding: 0;
          border: 0;
          background: transparent;
          box-shadow: none;
          min-height: 0;
        }
        .placeholder { padding: 12px; opacity: .7; font-size: 13px; text-align: center; }
        .err { padding: 12px; color: var(--error-color, #db4437); font-size: 13px; }
        .menu {
          display: grid;
          grid-template-columns: repeat(${columns}, minmax(0, 1fr));
          gap: var(--nmm-gap, 8px);
        }
        .item {
          all: unset;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: var(--nmm-item-padding, 12px 8px);
          background: var(--nmm-item-bg, var(--card-background-color, #1c1c1e));
          color: var(--nmm-item-fg, var(--primary-text-color));
          border-radius: var(--nmm-item-radius, var(--ha-card-border-radius, 12px));
          border: var(--nmm-item-border, 1px solid var(--divider-color, transparent));
          cursor: pointer;
          text-align: center;
          transition: background-color 120ms ease, color 120ms ease, transform 80ms ease;
          user-select: none;
          box-sizing: border-box;
          min-height: var(--nmm-item-min-height, 72px);
        }
        .item:hover {
          background: var(--nmm-item-hover-bg, var(--state-icon-active-color, var(--primary-color)));
          color: var(--nmm-item-hover-fg, var(--text-primary-color, #fff));
        }
        .item:focus-visible {
          outline: 2px solid var(--primary-color);
          outline-offset: 2px;
        }
        .item.active {
          background: var(--nmm-item-active-bg, var(--primary-color));
          color: var(--nmm-item-active-fg, var(--text-primary-color, #fff));
          font-weight: 600;
        }
        .item ha-icon {
          --mdc-icon-size: var(--nmm-icon-size, 32px);
          color: var(--nmm-icon-color, var(--paper-item-icon-color, var(--primary-color)));
        }
        .item.active ha-icon {
          color: var(--nmm-active-icon-color, var(--text-primary-color, #fff));
        }
        .label {
          font-size: var(--nmm-label-size, 13px);
          line-height: 1.2;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }
        .compact .item {
          flex-direction: row;
          gap: 8px;
          padding: 8px 12px;
          min-height: 44px;
        }
        .compact .item ha-icon { --mdc-icon-size: 22px; }
        .icons .item {
          gap: 0;
          padding: 8px;
          min-height: 56px;
        }
        /* seamless: no gaps, no per-item borders/radii — a single canvas */
        ha-card.seamless { padding: 0; overflow: hidden; }
        .menu.seamless { gap: 0; }
        .menu.seamless .item {
          border: 0;
          border-radius: 0;
        }
        /* keep a subtle hairline divider between buttons so they remain
           visually distinguishable without looking boxed */
        .menu.seamless .item + .item {
          box-shadow: inset 1px 0 0 var(--nmm-seamless-divider, transparent);
        }
      </style>
    `;
  }
}

/* ------------------------------ editor ----------------------------------- */

class NavigationMenuManagerCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._menus = null;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._loadMenus();
  }

  async _loadMenus() {
    if (this._menus || !this._hass) return;
    try {
      const res = await this._hass.callWS({ type: `${DOMAIN}/list_menus` });
      this._menus = res.menus || {};
    } catch (e) {
      this._menus = {};
    }
    this._render();
  }

  _emit() {
    this.dispatchEvent(
      new CustomEvent("config-changed", { detail: { config: this._config } })
    );
  }

  _set(field, value) {
    if (value === "" || value === undefined || value === null) {
      delete this._config[field];
    } else {
      this._config[field] = value;
    }
    this._emit();
  }

  _render() {
    const menus = this._menus || {};
    const ids = Object.keys(menus);
    const options = ids
      .map(
        (id) =>
          `<option value="${escapeHtml(id)}" ${
            id === this._config.menu ? "selected" : ""
          }>${escapeHtml(menus[id].name || id)} (${escapeHtml(id)})</option>`
      )
      .join("");

    this.innerHTML = `
      <style>
        .nmm-editor { display:flex; flex-direction:column; gap:12px; padding:8px 4px; }
        .nmm-editor label { font-size:12px; opacity:.8; }
        .nmm-row { display:flex; flex-direction:column; gap:4px; }
        .nmm-editor select, .nmm-editor input {
          padding:8px; border-radius:6px;
          border:1px solid var(--divider-color, #555);
          background: var(--card-background-color, transparent);
          color: var(--primary-text-color, inherit);
          font-size: 14px;
        }
        .nmm-help { font-size:12px; opacity:.7; }
        .nmm-warning { font-size:12px; color: var(--warning-color, #ffa600); }
      </style>
      <div class="nmm-editor">
        <div class="nmm-row">
          <label for="nmm-menu">Menu</label>
          ${
            ids.length === 0
              ? `<div class="nmm-warning">No menus defined yet. Open the <strong>Nav Menus</strong> sidebar entry to create one.</div>
                 <input id="nmm-menu" type="text" placeholder="Menu id (e.g. main)" value="${escapeHtml(
                   this._config.menu || ""
                 )}" />`
              : `<select id="nmm-menu">
                   ${options}
                 </select>`
          }
        </div>

        <div class="nmm-row">
          <label for="nmm-style">Style override (optional)</label>
          <select id="nmm-style">
            <option value="">— Use menu default —</option>
            <option value="buttons" ${
              this._config.style === "buttons" ? "selected" : ""
            }>Buttons (icon + label)</option>
            <option value="icons" ${
              this._config.style === "icons" ? "selected" : ""
            }>Icons only</option>
            <option value="compact" ${
              this._config.style === "compact" ? "selected" : ""
            }>Compact</option>
          </select>
        </div>

        <div class="nmm-row">
          <label for="nmm-columns">Columns (optional)</label>
          <input id="nmm-columns" type="number" min="1" max="20" value="${
            this._config.columns || ""
          }" placeholder="Auto (one per item)" />
        </div>

        <div class="nmm-row">
          <label>Card style</label>
          <select id="nmm-card-style">
            <option value="true" ${
              this._config.card_style !== false ? "selected" : ""
            }>Wrap in card</option>
            <option value="false" ${
              this._config.card_style === false ? "selected" : ""
            }>No card background</option>
          </select>
        </div>

        <div class="nmm-row">
          <label for="nmm-seamless">Appearance</label>
          <select id="nmm-seamless">
            <option value="false" ${
              this._config.seamless !== true ? "selected" : ""
            }>Separated buttons (default)</option>
            <option value="true" ${
              this._config.seamless === true ? "selected" : ""
            }>Seamless (no gaps or borders)</option>
          </select>
          <div class="nmm-help">
            Edit menu contents (labels, icons, paths) in the Nav Menus sidebar entry.
          </div>
        </div>
      </div>
    `;

    const menuEl = this.querySelector("#nmm-menu");
    menuEl?.addEventListener("change", (e) => this._set("menu", e.target.value));
    menuEl?.addEventListener("input", (e) => this._set("menu", e.target.value));

    this.querySelector("#nmm-style")?.addEventListener("change", (e) =>
      this._set("style", e.target.value)
    );
    this.querySelector("#nmm-columns")?.addEventListener("change", (e) => {
      const v = parseInt(e.target.value, 10);
      this._set("columns", Number.isFinite(v) && v > 0 ? v : undefined);
    });
    this.querySelector("#nmm-card-style")?.addEventListener("change", (e) => {
      this._set("card_style", e.target.value === "true" ? undefined : false);
    });
    this.querySelector("#nmm-seamless")?.addEventListener("change", (e) => {
      this._set("seamless", e.target.value === "true" ? true : undefined);
    });
  }
}

/* --------------------------------- utils -------------------------------- */

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ----------------------------- registration ----------------------------- */

if (!customElements.get("navigation-menu-manager-card")) {
  customElements.define("navigation-menu-manager-card", NavigationMenuManagerCard);
}
if (!customElements.get("navigation-menu-manager-card-editor")) {
  customElements.define(
    "navigation-menu-manager-card-editor",
    NavigationMenuManagerCardEditor
  );
}

window.customCards = window.customCards || [];
if (
  !window.customCards.find(
    (c) => c.type === "navigation-menu-manager-card"
  )
) {
  window.customCards.push({
    type: "navigation-menu-manager-card",
    name: "Navigation Menu",
    description:
      "Centrally-managed navigation menu — define once, use everywhere. Highlights the active view automatically.",
    preview: true,
    documentationURL:
      "https://github.com/loryanstrant/navigation-menu-manager",
  });
}
