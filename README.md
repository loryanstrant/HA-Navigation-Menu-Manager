# Navigation Menu Manager

A Home Assistant custom integration that lets you define dashboard navigation menus **once**, then drop a custom Lovelace card on any view to render them. Update the menu in one place — every dashboard updates live.

## Why

If you've ever built a Home Assistant dashboard with a row of navigation tiles across the top, you know the pain:

- Spacing drifts between views because the menu is copy-pasted onto each one
- Modifying the menu means editing every single view by hand
- Highlighting the "active" button via a separate theme fights with the rest of your dashboard theming

While there are some cards out there to simplify this, or make reusable templates, I found limitations or quirks with them that required me to get into the CSS just to make them display correctly.

This integration fixes all of that:

- **Define menus centrally** — labels, icons, paths — in a dedicated sidebar panel
- **One card per view** — `type: custom:navigation-menu-manager-card` with a `menu:` reference
- **Active-view detection** — the card highlights the button matching the current browser URL automatically
- **Live updates** — edit a menu in the panel and every dashboard re-renders instantly via WebSocket
- **HACS-ready**, with a card preview in the Lovelace card picker

## Features

- Reusable named menus with labels, MDI icons, paths/URLs
- Three display styles: **buttons** (icon + label), **icons** (icons only), **compact** (icon + label inline)
- Per-card overrides for style, column count, and "wrap in card" rendering
- Customisable via CSS variables — see [Theming](#theming)
- Three URL match modes: auto (smart), exact, prefix, suffix
- Admin-only panel; non-admins can use the card but can't edit menus
- Smooth in-app navigation (no full page reloads)

## Installation

### HACS (recommended)

1. In HACS, click **Integrations → ⋯ → Custom repositories**
2. Add `https://github.com/loryanstrant/HA-Navigation-Menu-Manager` as type **Integration**
3. Install **Navigation Menu Manager**
4. Restart Home Assistant
5. *Settings → Devices & Services → Add Integration → Navigation Menu Manager*

### Manual

1. Copy the `custom_components/navigation_menu_manager` folder into your HA `config/custom_components/` directory
2. Restart Home Assistant
3. *Settings → Devices & Services → Add Integration → Navigation Menu Manager*

After install, a **Nav Menus** entry appears in your sidebar (admins only).

## Examples

<img width="1593" height="164" alt="image" src="https://github.com/user-attachments/assets/55d1518b-672f-4d7a-8645-1b91cc39960c" />

<img width="1606" height="140" alt="image" src="https://github.com/user-attachments/assets/e5e77c12-f3f8-42ee-990c-4904aa74e596" />

<img width="1602" height="139" alt="image" src="https://github.com/user-attachments/assets/db860f6e-a3c6-4ead-9b4e-de574cc24080" />


## Usage

### 1. Define a menu

Open the **Nav Menus** sidebar entry. Click **+ New menu** and fill in:

| Field | Description |
| --- | --- |
| **Menu ID** | The identifier you'll reference from cards (e.g. `main`). Letters, digits, dashes, underscores. |
| **Display name** | A human-readable name (used in the panel and card picker only). |
| **Default style** | `buttons` (icon + label), `icons` (icons only), or `compact` (icon + label side-by-side). |
| **Items** | Each item has a **label**, **icon** (MDI), **path**, and optional **match** mode. |

#### Path formats

- `home` — a view ID; resolved against the current dashboard (`/lovelace/home`, `/lovelace-mobile/home`, etc.)
- `/lovelace/climate` — a fully-qualified Lovelace path
- `https://…` — an external URL (opens in same tab; ctrl/cmd-click for new tab)

#### Match modes

- **Auto** *(default)* — view IDs match the last URL segment; full paths match as a prefix
- **Exact** — only exact URL matches highlight as active
- **Prefix** — `current.startsWith(path)`
- **Suffix** — `current.endsWith(path)`

<img width="1824" height="994" alt="image" src="https://github.com/user-attachments/assets/7ae19c1f-1041-418a-a09e-b56a2ead1141" />


### 2. Add the card to a view

Edit any view, click **+ Add Card**, search for **Navigation Menu**, and you'll see a live preview in the picker.

<img width="1006" height="538" alt="image" src="https://github.com/user-attachments/assets/e28f897e-83ba-4b7e-8ace-d0f8985b63ad" />


Or paste this YAML:

```yaml
type: custom:navigation-menu-manager-card
menu: main
```

That's it. The card loads the menu defined in the panel and highlights whichever button matches the current view.

#### Optional card overrides

```yaml
type: custom:navigation-menu-manager-card
menu: main
style: icons          # override default style (buttons | icons | compact)
columns: 6            # number of grid columns; defaults to one per item
card_style: false     # remove the surrounding ha-card background
```

## Theming

The card styles itself with your active HA theme by default. You can fine-tune via CSS variables on the card-mod / `card_mod` style block, or globally in your theme:

```yaml
navigation-menu-manager-card:
  card-mod-card: |
    :host {
      --nmm-gap: 12px;
      --nmm-item-radius: 16px;
      --nmm-item-padding: 16px 8px;
      --nmm-icon-size: 36px;
      --nmm-icon-color: var(--primary-color);
      --nmm-item-bg: rgba(0,0,0,0.4);
      --nmm-item-active-bg: var(--primary-color);
      --nmm-item-active-fg: white;
      --nmm-active-icon-color: white;
    }
```

Full list of available CSS variables:

| Variable | Default |
| --- | --- |
| `--nmm-card-padding` | `8px` |
| `--nmm-gap` | `8px` |
| `--nmm-item-bg` | `var(--card-background-color)` |
| `--nmm-item-fg` | `var(--primary-text-color)` |
| `--nmm-item-radius` | `var(--ha-card-border-radius, 12px)` |
| `--nmm-item-border` | `1px solid var(--divider-color)` |
| `--nmm-item-padding` | `12px 8px` |
| `--nmm-item-min-height` | `72px` |
| `--nmm-item-hover-bg` | `var(--primary-color)` |
| `--nmm-item-hover-fg` | `var(--text-primary-color)` |
| `--nmm-item-active-bg` | `var(--primary-color)` |
| `--nmm-item-active-fg` | `var(--text-primary-color)` |
| `--nmm-icon-size` | `32px` |
| `--nmm-icon-color` | `var(--paper-item-icon-color)` |
| `--nmm-active-icon-color` | `var(--text-primary-color)` |
| `--nmm-label-size` | `13px` |

## How it works

- The integration stores menus in HA's `.storage` directory under `navigation_menu_manager.menus`
- The card subscribes via a WebSocket command (`navigation_menu_manager/subscribe_menu`) and receives push updates whenever the menu is saved
- The card listens for the `location-changed` and `popstate` window events to re-evaluate the active button as you navigate
- Tap actions use SPA-style `history.pushState` + a synthetic `location-changed` event, so navigation never causes a full reload
- The card resource is auto-registered via `frontend.add_extra_js_url` — no manual `/local/...js` resource entry required

## Permissions

The admin panel and the save/delete WebSocket commands require an admin account. The `list/get/subscribe` commands are available to any authenticated user, so non-admins can still *use* dashboards built with this card.

## Uninstall

Remove the integration from *Settings → Devices & Services*. Menu definitions are stored in `.storage/navigation_menu_manager.menus` — delete the file to wipe them.

## Contributing

Issues and PRs welcome at <https://github.com/loryanstrant/HA-Navigation-Menu-Manager>.

## License

MIT — see [LICENSE](LICENSE).
