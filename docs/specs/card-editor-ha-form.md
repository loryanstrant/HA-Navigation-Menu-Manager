# Spec — Both editing surfaces on `ha-form`

*Status: approved 2026-08-23.*

## Problem

This integration has two places a person edits something, and both are hand-built DOM producing
browser-default controls.

- **The card editor** — `NavigationMenuManagerCardEditor` in
  `custom_components/navigation_menu_manager/frontend/navigation-menu-manager-card.js`. Six raw
  `<select>`/`<input>` controls for five settings, rendered inside Home Assistant's card dialog
  surrounded by Material fields.
- **The Nav Menus panel** — `navigation-menu-manager-panel.js`. Menu id, display name, default
  style, and a repeating item list of label / icon / path / match, all raw controls.

Two `standards/ux.md` rules are broken by this:

- **Consistency** — *"reuse the app's existing primitives before inventing new ones; a new control
  matches the treatment of its neighbours."* Raw `<select>` and `<input>` have different font
  metrics, focus rings and spacing from every other control on the same screen, and they follow the
  browser's `color-scheme` rather than the active Home Assistant theme.
- **Copy** — *"no raw identifiers where a name would do."* The card's menu picker lists menu ids.
  The panel asks a non-developer to type `mdi:home` and `/lovelace/climate` from memory. Those are
  the two fields someone must get exactly right.

There is a structural argument too, and it is the stronger one. `_render()` assigns `innerHTML`
over the whole subtree, so any re-render destroys the control the user is currently using.

- The **card editor** is one `set hass` away from the bug `HA-Laundry-Weather` shipped in 0.3.0,
  where the clock-format dropdown flashed open and shut because Home Assistant assigns `hass`
  several times a second. This editor happens not to re-render on `hass` today. Nothing stops the
  next edit from adding it.
- The **panel** has the fault already, on a different trigger: every `change` event calls
  `_render()`, rebuilding every field on screen. The code works around it with a comment —
  *"Don't re-render on every keystroke (would steal focus)"* — which is a guard, not a fix.

With `ha-form` the fault cannot occur. The form element is created once and thereafter only
`.hass`, `.schema` and `.data` are assigned; Lit patches in place and there is no `innerHTML` to
blow away.

## Scope

Both front-end editing surfaces, and nothing else:

- `navigation-menu-manager-card.js` — the editor class only. The card's own rendering path is
  untouched.
- `navigation-menu-manager-panel.js` — the field controls, the render loop, the status banner and
  the two confirmations.

Not the Python side. The integration's config flow has one step with no options, and the WebSocket
API, storage shape and menu schema are unchanged.

## Constraints found before designing

**This is not a new pattern for this fleet.** `HA-Laundry-Weather` v0.4.0
(`custom_components/laundry_weather/www/laundry-weather-card.js`) is the reference:
`EDITOR_LABELS` + `EDITOR_HELPERS`, a cached schema builder, `computeLabel`/`computeHelper`, one
`ha-form`, and a `value-changed` listener that stops the inner event and re-emits
`config-changed`. `ha-jokes` and `HA-Transformers-Allspark-UI` have the same shape.

**Every primitive needed already exists in the Home Assistant frontend.** Verified against the
bundle in HomeAssistant-DEV (2026.8.3): `ha-form`, `ha-selector-select` including `custom_value`,
`ha-icon-picker`, `ha-navigation-picker`, `ha-button`, `ha-dialog`, `ha-alert`. `custom_value` is
also present in `SelectSelectorConfig` on the Python side.

**`custom_value` is what merges the card's two menu controls into one.** Today the editor renders a
free-text input when no menus exist and a `<select>` when some do — two controls for one field. A
select selector with `custom_value: true` renders a dropdown of names that also accepts a typed
id, which covers both cases in one control.

**`ha-form` is only defined once Home Assistant loads its editor chunk,** and the panel is not the
card dialog. Mushroom's `loadHaComponents()` trick — calling `hui-tile-card.getConfigElement()` to
force the chunk — works in a card editor because the dialog already loaded Lovelace. A cold reload
straight onto `/navigation-menus` may have no `hui-*` card defined at all, so the panel needs
`window.loadCardHelpers()` as a fallback.

**`customElements.whenDefined()` must not be called at module top level.** Home Assistant replaces
`window.customElements` with a scoped-registry polyfill while its core bundle boots, so a
top-level binding attaches to the native registry's method and may never fire.

**Three settings are tri-state and cannot be booleans.** The card's `style` is
absent/`buttons`/`icons`/`compact` where absent means *inherit from the menu*; the card's
`card_style` is absent-or-`true` versus `false`; the panel's item `match` is
absent/`exact`/`prefix`/`suffix` where absent means *automatic*. Each needs a select plus a
mapping in both directions, and configs written by the old editor must still load.

## Flow

Unchanged for the user. *Edit card* shows the same five settings in the same order; **Nav Menus**
shows the same menu list, the same form and the same item rows with the same ▲/▼/🗑 controls.
What changes is that the fields are Home Assistant's own, the menu is chosen by name, the icon
comes from a searchable picker, the path offers the dashboard's actual views, and the dropdowns
open in an overlay layer instead of as native popups.

## Acceptance criteria

1. Every control on both surfaces is a Home Assistant component; no raw `<select>` or `<input>`
   authored by this repo survives. (HA's own components render `<input>` internally; the assertion
   is scoped to our own DOM.)
2. The card's menu field is a single control replacing today's select-or-text-input pair, and it
   shows menus by **friendly name**. Its shape follows the situation: a dropdown of names when
   menus exist; a text box when none do, so the id of a menu about to be created can still be
   typed; and an id with no matching menu is kept as an option labelled `<id> — not defined` rather
   than silently dropped. *(Amended during implementation: a select selector with
   `custom_value: true` would have covered all three at once, but Home Assistant renders that mode
   as a picker displaying the raw value — which is the identifier this port exists to remove.)*
3. That field distinguishes four states in its helper text: loading, loaded, no menus defined, and
   `list_menus` failed. The failure case is currently swallowed silently.
4. The card's style field offers *Use the menu's own style* plus the three styles, and stores the
   key absent for the first. A config written by the old editor loads into it unchanged.
5. `card_style`, `seamless` and `columns` round-trip: keys are stripped when they hold their
   default, exactly as today's editor emits them, and unknown keys the editor does not manage
   (`type`, `grid_options`, `view_layout`, `visibility`) survive an edit.
6. The panel's item icon field is `ha-icon-picker` and its path field offers the dashboard's views
   by name while still accepting a bare view id or an external URL. Existing values load unchanged
   and save back byte-identically.
6a. Every item's path field carries a caption that stays visible once the field holds a value.
    *(Added during implementation: `ha-navigation-picker` passes its label down as a placeholder,
    so the caption is drawn by this repo rather than by the selector.)*
7. The panel's item `match` offers *Automatic* / *Exact* / *Starts with* / *Ends with* and stores
   absent/`exact`/`prefix`/`suffix`.
8. The `ha-form` node is the same object across 20 consecutive `hass` assignments in the card
   editor, and the panel does not rebuild its fields when one of them changes.
9. The panel's status banner is `ha-alert` (icon + sentence, so status is never colour alone) and
   both `confirm()` boxes are Home Assistant dialogs.
10. The panel renders after a cold hard reload directly on `/navigation-menus`, with no dashboard
    visited first.
11. `manifest.json`, `const.py` `VERSION`, `CARD_VERSION` and `PANEL_VERSION` all read `0.2.0`, and
    the served file at `?v=0.2.0` contains the new code.
12. Screenshots of both surfaces at desktop and ~380px show them matching the surrounding Home
    Assistant fields — with the image dimensions themselves asserted, not assumed.
13. Neither surface logs a page error from this repo's own files. Errors from other components on
    the test instance are reported separately rather than counted as ours.

## Non-goals

- The card's rendering path, its subscription handling, and the active-view highlighting.
- The integration's config flow, WebSocket API and storage format.
- Migrating stored configs or menus. Nothing about either stored shape changes, so there is
  nothing to migrate.
- New settings. This is a port, not a feature.
