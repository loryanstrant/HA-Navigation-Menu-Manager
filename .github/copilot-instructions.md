# Copilot instructions — HA-Navigation-Menu-Manager

> Canonical standards live in the `dev-standards` repo on SOUNDWAVE/Gitea.
> Read by Copilot chat **and** inline suggestions. For full HA build conventions,
> see the `build-ha-component` skill in dev-standards.

## What this repo is

A **Home Assistant custom component** that manages dashboard navigation menus —
ships a frontend **panel + card** and a **websocket API**, with a persistent
store. Domain: `navigation_menu_manager`.

## Repo shape

- `custom_components/navigation_menu_manager/` — `manifest.json`, `__init__.py`,
  `config_flow.py`, `const.py`, `store.py`, `websocket_api.py`, `strings.json`,
  `translations/`, `brand/`.
- `.../frontend/navigation-menu-manager-card.js` + `-panel.js` — bundled frontend.
- `hacs.json`, `.github/workflows/` (validate + release).

## Conventions

- Bump `manifest.json` **version** every release (semver); `domain` matches the
  folder name.
- Frontend assets are bundled JS — keep registered paths + websocket command
  names stable (the panel/card and stored configs depend on them).
- Test: `hassfest` + HACS validation, then `pytest` with
  `pytest-homeassistant-custom-component`.
- Deploy/test via the published release artifact into TEST1/TEST2, not host
  file-copy. Backup + auto-rollback.

## Never

- Don't commit HA long-lived tokens or deploy keys — Gitea Actions secrets only.
