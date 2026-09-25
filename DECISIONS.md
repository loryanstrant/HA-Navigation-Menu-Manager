# Decisions

Dated, non-obvious choices and the quirks that forced them. One entry per decision, each ending in
a lesson worth carrying elsewhere.

## 2026-09-25 — `handle_safe_area` stays **false**, and why the real fix was a `100vh`

HA 2026.8.2 added `handle_safe_area` to `panel_custom.async_register_panel`. The name reads like an
opt-in to safe-area support. It is the opposite: it opts a panel **out** of the padding Home
Assistant now adds for you. Core's own signature comment says so — *"If your panel handles the safe
area insets itself, opting out of the padding Home Assistant would otherwise add around it"* — and
`ha-panel-custom.ts` implements it as `const applySafeArea = !config.handle_safe_area`, which when
true skips setting `paddingTop/Bottom/Left/Right` on the panel container.

This panel consumes no insets anywhere in its CSS. Setting `handle_safe_area: true` would therefore
have **removed** notch protection from a panel that has none of its own — shipping the regression
while appearing to fix it. It stays at the default `false`, and `__init__.py` is untouched.

The parameter did surface a real bug, though. Since 2026.8.2 `ha-panel-custom` is a `border-box`
container with `padding: var(--safe-area-inset-*)`, and `.layout` carried `min-height: 100vh`. A
full-viewport child inside a padded border-box container overflows by exactly the top+bottom insets
— a phantom page scroll that pushes the footer off a notched screen. Pre-2026.8.2 the padding did
not exist and `100vh` was right; the upstream change made it wrong. Now:

```css
min-height: calc(100vh - var(--safe-area-inset-top, 0px) - var(--safe-area-inset-bottom, 0px));
```

Two things in that line are deliberate. **`var(--safe-area-inset-*)`, not `env(safe-area-inset-*)`**
— HA defines `--safe-area-inset-top: var(--app-safe-area-inset-top, env(safe-area-inset-top, 0px))`,
so in the Companion app the true inset arrives through the native `--app-*` variable while `env()`
inside the WebView commonly reads `0px`. Using `env()` would under-subtract in precisely the case
the fix exists for, and would silently disagree with what the container actually padded by. Custom
properties cross the shadow boundary, so it resolves inside the panel's shadow root. (The `0px`
fallbacks are belt-and-braces for a frontend older than 2026.8.2 that never defines the variables at
all: `var()` substitutes a fallback only when the property is genuinely *unset*, not when it is
declared-but-empty. HA's own chain bottoms out at a literal `0px`, so the empty case does not arise
here — but if it ever did, the `calc()` would be invalid and `min-height` would compute to `auto`
rather than silently reverting to `100vh`.)

And **not a percentage**: nothing in the ancestor chain — `ha-drawer[slot=appContent]`,
`partial-panel-resolver`, `ha-panel-custom` — sets a height (`home-assistant-main`'s stylesheet
styles `partial-panel-resolver` for tap-highlight only), so `min-height: 100%` resolves against an
auto-height parent and collapses to content height. `100dvh` was also rejected: it solves mobile
browser-chrome, not a parent's padding, so it would look like a fix without being one. With no
insets the `calc()` is exactly `100vh`, so the desktop case is byte-for-byte unchanged.

**Lesson:** read the flag's implementation, not its name. `handle_safe_area` means "I'll handle it",
and the reflexive opt-in would have been a regression dressed as an improvement.

## 2026-08-23 — Both editing surfaces are built on `ha-form`

The card editor was ~130 lines of hand-built DOM and the Nav Menus panel another ~630, both
producing browser-default `<select>` and `<input>` inside screens otherwise made of Home Assistant
Material fields. Two `standards/ux.md` rules broken: *consistency* (reuse the app's primitives;
match the neighbours — raw controls follow the browser's `color-scheme`, not the active theme) and
*copy* (no raw identifiers where a name would do — the card listed menu **ids**, and the panel asked
for `mdi:home` and `/lovelace/climate` to be typed from memory).

The structural argument mattered more than the cosmetic one. `_render()` assigned `innerHTML` over
the whole subtree, so any re-render destroyed the control the user was in. The sibling
`HA-Laundry-Weather` shipped exactly that bug — a dropdown that flashed open and shut because Home
Assistant assigns `hass` several times a second. This panel had the same fault on a different
trigger: every `change` event rebuilt every field, worked around by a comment saying *"Don't
re-render on every keystroke (would steal focus)"*.

`ha-form` removes the possibility rather than guarding it: the form element is created once and
thereafter only `.hass`, `.schema` and `.data` are assigned, so Lit patches in place.

**Lesson:** when a bug is held off by a comment asking people not to write something, look for the
construction where writing it is impossible.

## 2026-08-23 — Three settings are tri-state, so none of them is a checkbox

The card's `style` is absent / `buttons` / `icons` / `compact`, where **absent means "inherit from
the menu"**. Its `card_style` is absent-or-`true` versus `false`. An item's `match` is absent /
`exact` / `prefix` / `suffix`, where absent means automatic. A boolean selector expresses two
states, so each of these became a dropdown with a sentinel option and a mapping in both directions.
Configs and menus written by the old editors load unchanged, and keys are still stripped when they
hold their default, so an untouched dashboard does not grow keys it never had.

**Lesson:** "off" and "not set" are different answers whenever something else supplies the default.
Count the states before reaching for a checkbox.

## 2026-08-23 — `custom_value` was tried for the menu picker, and abandoned

The old editor used *two* controls for one field: a `<select>` when menus existed and a free-text
box when none did. A select selector with `custom_value: true` merges both into one control that
also accepts a typed id, and that is what shipped first.

It had to go. With `custom_value`, Home Assistant renders an `ha-generic-picker` that displays the
raw **value**, so the field read `demo` where the menu is called *Demo Nav* — reinstating precisely
the raw identifier this port set out to remove. It was invisible in code review and obvious in a
screenshot.

The field now switches shape by situation instead: a dropdown of names normally; a text box when no
menus exist at all; and, for a stored id with no matching menu, that id added as an option labelled
`<id> — not defined` so the value is shown rather than silently dropped.

**Lesson:** a control that can hold any value tends to render like one. If the whole point is to
show a friendly name, check what the widget actually paints before trusting the config that asked
for it.

## 2026-08-23 — The panel draws the path field's caption itself

Every other field in an item row shows its floating caption. The path field showed none, because
`ha-navigation-picker` hands its `label` down to the picker as a **placeholder** — visible only
while the field is empty, which it never is once a menu has been saved. The result read as an
unlabelled box sitting between labelled ones.

So `path` came out of the `ha-form` grid and is rendered as its own `ha-selector` under a caption we
draw, styled to match HA's own top-label treatment. Full width was a bonus rather than a
workaround: paths are the longest values in the row and were being truncated mid-word in a
quarter-width column.

**Lesson:** `label` and `placeholder` are not the same promise. A component that accepts a label can
still decline to keep it on screen.

## 2026-08-23 — An `ha-form` must never reach the DOM without a `schema`

The panel logged `TypeError: e is not iterable` twice on every load. Nothing pointed at us: the
stack was entirely inside Home Assistant's own minified chunks, and element-by-element bisects
cleared every selector, `ha-icon-button`, `ha-alert` and `ha-dialog`. The control that mattered was
HACS — the only other custom panel on the instance — which threw nothing, ruling out HA's
custom-panel shell.

Decoding the minified frame against the `.js.map` shipped next to the chunk settled it in one step:
`ha-form.ts:161` (render) → `conditions.ts:86`, iterating `schema`. Our skeleton put
`<ha-form id="menu-form">` into the document while `_updateEditor()` returned early whenever no menu
was selected, so it rendered once with `schema === undefined`. The menu form and every item row now
receive `schema` and `data` at construction, before they can be attached.

**Lesson:** Home Assistant ships source maps beside every chunk. Decoding one frame beats an hour of
bisecting by elimination — and "the stack has none of my code in it" is not evidence that the bug
isn't mine.

## 2026-08-23 — Loading HA's form components differs between a card editor and a panel

Mushroom's trick for forcing the chunk that defines `ha-form` is to call
`hui-tile-card.getConfigElement()`. That works in a card editor because the card dialog has already
loaded Lovelace. A panel is not the card dialog: a cold reload straight onto `/navigation-menus` may
have no `hui-*` card defined at all, and the fields would never arrive. The panel therefore falls
back to `window.loadCardHelpers()`, which imports the chunk from anywhere, and a check asserts the
panel renders after a genuinely cold load rather than after visiting a dashboard first.

Related, and load-bearing in both files: `window.customElements` is re-read on every call and never
captured, and `customElements.whenDefined()` is never called at module top level — Home Assistant
swaps the registry for a scoped-registry polyfill while booting, so a captured reference can point
at the wrong one and a top-level `whenDefined` may never fire.

**Lesson:** "it works in the dialog" is not "it works". Test the entry point that has the least
loaded before it.

## 2026-08-23 — Two traps in verifying this, both of which produced convincing wrong answers

`ha-entity-picker` and friends render *nothing* — zero height, empty shadow root, no console error —
unless they sit inside `<home-assistant>`, because newer components take `hass` from a Lit context
provider rather than a property. A harness that builds the editor and attaches it to `document.body`
silently tests a half-dead form while every other field renders fine. Every field's height is now
asserted.

Worse, the first pair of "380px" screenshots were both 1280px wide. Playwright's viewport is a
**context**-level option, so `context.newPage({viewport})` is accepted and ignored. Those images
would have been presented as the narrow-width check.

**Lesson:** a screenshot at the wrong viewport is worse than no screenshot, because it looks like
evidence. Assert the dimensions of the artefact, not just that one was produced.
