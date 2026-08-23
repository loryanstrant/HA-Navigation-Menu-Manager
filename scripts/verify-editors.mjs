/**
 * Verifies the card editor and the Nav Menus panel against a real Home
 * Assistant, and captures the screenshots for review.
 *
 * Runs in the Playwright image on BLASTER, sharing HomeAssistant-DEV's network:
 *
 *   ssh blaster "sudo -n docker run --rm --network container:HomeAssistant-DEV \
 *     -e HA_URL -e HA_TOKEN -v /tmp/nmm-out:/out -v /tmp/verify-editors.mjs:/verify.mjs \
 *     -e NODE_PATH=/usr/lib/node_modules mcr.microsoft.com/playwright:v1.48.0-jammy \
 *     sh -c 'npm i -g playwright-core@1.48.0 >/dev/null 2>&1 && node /verify.mjs'"
 *
 * Two traps this harness exists to avoid, both of which cost real time
 * elsewhere in the fleet:
 *
 *  - HA's newer pickers read `hass` from a Lit context provider rather than a
 *    property, so an editor built outside `<home-assistant>` renders a form
 *    where those fields are silently zero-height and empty, with no error. The
 *    editor is therefore attached inside `<home-assistant>`'s shadow tree, and
 *    every field's height is asserted.
 *  - The card-configuration dialog does not attach in a headless browser, so
 *    the editor is built directly via `getConfigElement()` instead.
 */
import { chromium } from "playwright-core";

const BASE = process.env.HA_URL || "http://localhost:8123";
const TOKEN = process.env.HA_TOKEN;
const OUT = process.env.OUT_DIR || "/out";
const CARD_URL = "/navigation_menu_manager_static/navigation-menu-manager-card.js?v=0.2.0";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* --------------------------- in-page utilities --------------------------- */

const PAGE_UTILS = `
  window.__nmmDeepQueryAll = function (sel, root) {
    root = root || document;
    const acc = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) acc.push(...window.__nmmDeepQueryAll(sel, el.shadowRoot));
    }
    return acc;
  };
  window.__nmmTick = (ms) => new Promise((r) => setTimeout(r, ms || 300));
  window.__nmmText = function (root) {
    let out = "";
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.textContent + " "; return; }
      if (n.shadowRoot) walk(n.shadowRoot);
      for (const c of (n.childNodes || [])) walk(c);
      if (n.tagName === "INPUT" && n.value) out += "[" + n.value + "] ";
    };
    walk(root);
    // Double-escaped on purpose: this whole helper is a template literal, and
    // an unrecognised escape there loses its backslash — /\s+/ would reach the
    // page as /s+/ and silently strip every letter "s" from the text reported.
    return out.replace(/\\s+/g, " ").trim();
  };
`;

/* --------------------------------- setup --------------------------------- */

const browser = await chromium.launch({
  executablePath: "/ms-playwright/chromium-1140/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

// Viewport is a CONTEXT-level option in Playwright. `context.newPage({viewport})`
// is silently ignored, which is how an earlier run produced two "380px"
// screenshots that were both 1280px wide — evidence-shaped, but not evidence.
async function makeContext(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(
  ({ base, token }) => {
    window.localStorage.setItem(
      "hassTokens",
      JSON.stringify({
        access_token: token,
        token_type: "Bearer",
        expires_in: 315360000,
        hassUrl: base,
        clientId: null,
        expires: Date.now() + 315360000000,
        refresh_token: "",
      })
    );
  },
  { base: BASE, token: TOKEN }
  );
  await ctx.addInitScript(PAGE_UTILS);
  return ctx;
}

const context = await makeContext(1280, 900);

async function openHa(page, path) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  console.log(`  … opening ${path}`);
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 45000 });
  try {
    await page.waitForFunction(
      () => {
        const ha = document.querySelector("home-assistant");
        return !!(ha && ha.hass && ha.hass.states);
      },
      null,
      { timeout: 60000 }
    );
  } catch (e) {
    const diag = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.body.innerHTML.slice(0, 300),
      hasHa: !!document.querySelector("home-assistant"),
      tokens: (window.localStorage.getItem("hassTokens") || "").slice(0, 60),
    }));
    console.log("  !! never reached a live hass: " + JSON.stringify(diag));
    await page.screenshot({ path: `${OUT}/diag-${path.replace(/\W+/g, "_")}.png` });
    throw e;
  }
  console.log(`  … ${path} is live`);
  return errors;
}

/* ---------------------------- the card editor ---------------------------- */

// newPage({viewport}) — `viewportSize` is silently ignored.
const page = await context.newPage();
const cardErrors = await openHa(page, "/lovelace/0");

const cardReport = await page.evaluate(async (cardUrl) => {
  const out = { steps: [] };
  await import(cardUrl);

  const CARD = window.customElements.get("navigation-menu-manager-card");
  out.cardDefined = !!CARD;
  const ha = document.querySelector("home-assistant");

  const editor = CARD.getConfigElement();
  const host = document.createElement("div");
  host.id = "nmm-harness";
  host.style.cssText = [
    "position:fixed",
    "top:24px",
    "left:24px",
    "z-index:999999",
    "width:min(440px, calc(100vw - 48px))",
    "box-sizing:border-box",
    "padding:20px",
    "border-radius:16px",
    "background:var(--card-background-color, #fff)",
    "color:var(--primary-text-color, #000)",
    "box-shadow:0 12px 48px rgba(0,0,0,.5)",
    "font-family:var(--paper-font-body1_-_font-family, Roboto, sans-serif)",
  ].join(";");
  const heading = document.createElement("div");
  heading.textContent = "Navigation Menu";
  heading.style.cssText = "font-size:20px;font-weight:500;margin-bottom:12px";
  host.appendChild(heading);
  host.appendChild(editor);
  // Inside <home-assistant>, or the pickers render nothing at all.
  ha.shadowRoot.appendChild(host);

  editor.hass = ha.hass;
  editor.setConfig({ type: "custom:navigation-menu-manager-card", menu: "demo" });
  await window.__nmmTick(900);

  const formA = editor.querySelector("ha-form");
  out.formPresent = !!formA;

  // 1. The form node survives repeated `hass` assignment.
  for (let i = 0; i < 20; i += 1) editor.hass = ha.hass;
  await window.__nmmTick(300);
  out.sameNodeAfter20 =
    formA === editor.querySelector("ha-form") && editor.querySelectorAll("ha-form").length === 1;

  // 2. Nothing but ha-form is authored into the editor's own DOM.
  out.ownChildren = [...editor.children].map((el) => el.tagName.toLowerCase());
  out.rawControls = editor.querySelectorAll(":scope > select, :scope > input, :scope > style").length;

  // 3. A real setConfig still reaches .data.
  const full = {
    type: "custom:navigation-menu-manager-card",
    menu: "navtest",
    style: "icons",
    columns: 3,
    card_style: false,
    seamless: true,
    grid_options: { columns: 12 },
  };
  editor.setConfig(full);
  await window.__nmmTick(400);
  out.dataAfterSetConfig = JSON.parse(JSON.stringify(formA.data));

  // 4. Round-trip: hand the form's own data straight back and see what the
  //    editor emits. Anything lost or invented shows up here.
  const emitted = [];
  editor.addEventListener("config-changed", (e) =>
    emitted.push(JSON.parse(JSON.stringify(e.detail.config)))
  );
  const bounce = () =>
    formA.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value: JSON.parse(JSON.stringify(formA.data)) },
        bubbles: true,
        composed: true,
      })
    );
  bounce();
  await window.__nmmTick(200);
  out.roundTripFull = emitted[emitted.length - 1];

  const minimal = { type: "custom:navigation-menu-manager-card", menu: "demo" };
  editor.setConfig(minimal);
  await window.__nmmTick(300);
  bounce();
  await window.__nmmTick(200);
  out.roundTripMinimal = emitted[emitted.length - 1];

  // 5. Every field actually rendered — the silent-empty-picker trap.
  editor.setConfig(full);
  await window.__nmmTick(700);
  const selectors = formA.shadowRoot ? [...formA.shadowRoot.querySelectorAll("ha-selector")] : [];
  out.fieldHeights = selectors.map((el) => Math.round(el.getBoundingClientRect().height));
  out.menuFieldText = selectors.length ? window.__nmmText(selectors[0]) : "";

  // The menu field changes shape with the situation; check all three without
  // needing three live Home Assistants.
  const probe = CARD.getConfigElement();
  probe.hass = ha.hass;
  probe.setConfig({ type: "custom:navigation-menu-manager-card", menu: "future" });
  probe._menus = {};
  probe._schemaCache = null;
  out.noMenusField = Object.keys(probe._schema()[0].selector)[0];
  probe._menus = { demo: { name: "Demo Nav" } };
  probe._schemaCache = null;
  probe.setConfig({ type: "custom:navigation-menu-manager-card", menu: "gone" });
  out.staleOptionLabels = probe._schema()[0].selector.select.options.map((o) => o.label);

  out.menuPickerTag = selectors.length
    ? (window
        .__nmmDeepQueryAll("ha-combo-box, ha-generic-picker, ha-select", selectors[0].shadowRoot)
        .map((el) => el.tagName.toLowerCase())[0] || "none")
    : "none";

  // Back to a realistic config for the screenshot.
  editor.setConfig({ type: "custom:navigation-menu-manager-card", menu: "demo", columns: 3 });
  await window.__nmmTick(700);
  return out;
}, CARD_URL);

check("card module defines the card", cardReport.cardDefined);
check("editor builds one ha-form", cardReport.formPresent);
check(
  "ha-form is the same node across 20 hass assignments",
  cardReport.sameNodeAfter20,
  `children: ${cardReport.ownChildren.join(",")}`
);
check(
  "no raw select/input/style authored in the editor",
  cardReport.rawControls === 0 && cardReport.ownChildren.every((t) => t === "ha-form"),
  `own children: ${cardReport.ownChildren.join(",") || "none"}`
);
check(
  "setConfig reaches .data with the mapped shape",
  eq(cardReport.dataAfterSetConfig, {
    type: "custom:navigation-menu-manager-card",
    menu: "navtest",
    columns: 3,
    card_style: false,
    seamless: true,
    grid_options: { columns: 12 },
    style_mode: "icons",
  }),
  JSON.stringify(cardReport.dataAfterSetConfig)
);
check(
  "a fully-populated config round-trips unchanged",
  eq(cardReport.roundTripFull, {
    type: "custom:navigation-menu-manager-card",
    menu: "navtest",
    columns: 3,
    card_style: false,
    seamless: true,
    grid_options: { columns: 12 },
    style: "icons",
  }),
  JSON.stringify(cardReport.roundTripFull)
);
check(
  "a bare config round-trips without growing keys",
  eq(cardReport.roundTripMinimal, {
    type: "custom:navigation-menu-manager-card",
    menu: "demo",
  }),
  JSON.stringify(cardReport.roundTripMinimal)
);
check(
  "all five fields rendered with height",
  cardReport.fieldHeights.length === 5 && cardReport.fieldHeights.every((h) => h > 0),
  `heights: ${cardReport.fieldHeights.join(", ")}`
);
check(
  "the menu field is an HA picker",
  ["ha-combo-box", "ha-generic-picker", "ha-select"].includes(cardReport.menuPickerTag),
  cardReport.menuPickerTag
);
check(
  "the menu field shows the menu's name, not its id",
  /Demo Nav/.test(cardReport.menuFieldText),
  JSON.stringify(cardReport.menuFieldText)
);
check(
  "with no menus defined the field becomes a text box",
  cardReport.noMenusField === "text",
  cardReport.noMenusField
);
check(
  "an id with no matching menu is kept and flagged",
  cardReport.staleOptionLabels.includes("gone — not defined"),
  cardReport.staleOptionLabels.join(" / ")
);

// DEV carries other sessions' components, so foreign console noise is expected
// and must not be reported as ours. Scope by filename, and print the rest.
const ours = (list) => list.filter((e) => /navigation[-_]menu[-_]manager/i.test(e));
const foreign = (list) => list.filter((e) => !/navigation[-_]menu[-_]manager/i.test(e));
if (foreign(cardErrors).length) console.log("  (foreign page errors, not ours: " + foreign(cardErrors).join(" | ") + ")");
check("no page errors from our card files", ours(cardErrors).length === 0, ours(cardErrors).join(" | "));

async function shotHarness(p, file) {
  const box = await p.evaluate(() => {
    const ha = document.querySelector("home-assistant");
    const host = ha.shadowRoot.getElementById("nmm-harness");
    const r = host.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await p.screenshot({
    path: `${OUT}/${file}`,
    clip: {
      x: Math.max(0, box.x - 12),
      y: Math.max(0, box.y - 12),
      width: box.width + 24,
      height: box.height + 24,
    },
  });
}
await shotHarness(page, "card-editor-desktop.png");
await page.close();

/* the same editor at phone width */
const narrowContext = await makeContext(380, 820);
const narrow = await narrowContext.newPage();
await openHa(narrow, "/lovelace/0");
await narrow.evaluate(async (cardUrl) => {
  await import(cardUrl);
  const CARD = window.customElements.get("navigation-menu-manager-card");
  const ha = document.querySelector("home-assistant");
  const editor = CARD.getConfigElement();
  const host = document.createElement("div");
  host.id = "nmm-harness";
  host.style.cssText =
    "position:fixed;top:12px;left:12px;z-index:999999;width:calc(100vw - 24px);box-sizing:border-box;padding:16px;border-radius:16px;background:var(--card-background-color,#fff);color:var(--primary-text-color,#000);box-shadow:0 12px 48px rgba(0,0,0,.5);font-family:var(--paper-font-body1_-_font-family,Roboto,sans-serif)";
  const heading = document.createElement("div");
  heading.textContent = "Navigation Menu";
  heading.style.cssText = "font-size:18px;font-weight:500;margin-bottom:10px";
  host.appendChild(heading);
  host.appendChild(editor);
  ha.shadowRoot.appendChild(host);
  editor.hass = ha.hass;
  editor.setConfig({ type: "custom:navigation-menu-manager-card", menu: "demo", columns: 3 });
  await window.__nmmTick(1200);
}, CARD_URL);
await shotHarness(narrow, "card-editor-380.png");
await narrow.close();
await narrowContext.close();

/* ------------------------------- the panel ------------------------------- */

// Cold load: straight onto the panel URL, no dashboard visited first, so the
// Lovelace chunk that defines ha-form is genuinely absent at boot.
const panel = await context.newPage();
const panelErrors = await openHa(panel, "/navigation-menus");
await panel.waitForFunction(
  () => window.__nmmDeepQueryAll("navigation-menu-manager-panel").length > 0,
  null,
  { timeout: 30000 }
);
await panel.waitForTimeout(2500);

const panelReport = await panel.evaluate(async () => {
  const out = {};
  const [el] = window.__nmmDeepQueryAll("navigation-menu-manager-panel");
  const root = el.shadowRoot;
  out.forms = root.querySelectorAll("ha-form").length;
  out.rawControls = root.querySelectorAll("select, input, textarea").length;
  out.alerts = root.querySelectorAll("ha-alert").length;
  out.buttons = [...root.querySelectorAll("ha-button, mwc-button")].map((b) =>
    b.tagName.toLowerCase()
  );
  const measure = (sel) =>
    window
      .__nmmDeepQueryAll(sel, root)
      .map((n) => Math.round(n.getBoundingClientRect().height));
  out.iconPicker = measure("ha-icon-picker");
  out.navPicker = measure("ha-navigation-picker");
  out.selectors = measure("ha-selector");
  out.itemRows = root.querySelectorAll(".item-row").length;
  out.pathCaptions = [...root.querySelectorAll(".item-path .field-caption")].map((n) =>
    n.textContent.trim()
  );
  out.pathSelectors = measure(".item-path ha-selector");
  out.headControls = root.querySelectorAll(".item-head ha-icon-button").length;
  return out;
});

check("panel renders after a cold load straight onto its URL", panelReport.forms > 0, `${panelReport.forms} ha-form`);
check(
  "no raw select/input in the panel's own DOM",
  panelReport.rawControls === 0,
  `${panelReport.rawControls} found`
);
check(
  "icon pickers rendered with height",
  panelReport.iconPicker.length > 0 && panelReport.iconPicker.every((h) => h > 0),
  `heights: ${panelReport.iconPicker.join(", ")}`
);
check(
  "navigation pickers rendered with height",
  panelReport.navPicker.length > 0 && panelReport.navPicker.every((h) => h > 0),
  `heights: ${panelReport.navPicker.join(", ")}`
);
check(
  "every panel field rendered with height",
  panelReport.selectors.length > 0 && panelReport.selectors.every((h) => h > 0),
  `${panelReport.selectors.length} fields`
);
check(
  "buttons are HA buttons",
  panelReport.buttons.length > 0 && panelReport.buttons.every((t) => t === "ha-button"),
  panelReport.buttons.join(",") || "none"
);
check(
  "every item's path field carries a visible caption",
  panelReport.pathCaptions.length === panelReport.itemRows &&
    panelReport.pathCaptions.every((t) => t.startsWith("Path or URL")),
  panelReport.pathCaptions.join(" / ") || "none"
);
check(
  "the path field renders full width with height",
  panelReport.pathSelectors.length === panelReport.itemRows &&
    panelReport.pathSelectors.every((h) => h > 0),
  `heights: ${panelReport.pathSelectors.join(", ")}`
);
check(
  "each item's controls sit on one header line",
  panelReport.headControls === panelReport.itemRows * 3,
  `${panelReport.headControls} buttons across ${panelReport.itemRows} rows`
);
if (foreign(panelErrors).length) console.log("  (foreign page errors, not ours: " + foreign(panelErrors).join(" | ") + ")");
check("no page errors from our panel file", ours(panelErrors).length === 0, ours(panelErrors).join(" | "));

/* Round-trip a menu through the panel's own save path, paths included. */
const roundTrip = await panel.evaluate(async () => {
  const [el] = window.__nmmDeepQueryAll("navigation-menu-manager-panel");
  const root = el.shadowRoot;
  const target = [...root.querySelectorAll(".menu-list li")].find(
    (li) => li.dataset.id === "rt_test"
  );
  if (!target) return { ok: false, why: "rt_test not in the sidebar" };
  target.click();
  await window.__nmmTick(1500);
  const save = root.getElementById("save");
  save.click();
  await window.__nmmTick(2500);
  return { ok: true, items: root.querySelectorAll(".item-row").length };
});
check("panel loaded and saved the round-trip menu", roundTrip.ok, roundTrip.why || `${roundTrip.items} rows`);

await panel.screenshot({ path: `${OUT}/panel-desktop.png`, fullPage: false });
await panel.close();

const panelNarrowContext = await makeContext(380, 900);
const panelNarrow = await panelNarrowContext.newPage();
await openHa(panelNarrow, "/navigation-menus");
await panelNarrow.waitForFunction(
  () => window.__nmmDeepQueryAll(".item-row").length > 0,
  null,
  { timeout: 30000 }
);
await panelNarrow.waitForTimeout(2500);
await panelNarrow.screenshot({ path: `${OUT}/panel-380.png`, fullPage: false });
await panelNarrow.close();
await panelNarrowContext.close();

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exit(1);
}
