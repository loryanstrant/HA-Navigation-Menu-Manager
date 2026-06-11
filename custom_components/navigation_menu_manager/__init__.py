"""The Navigation Menu Manager integration."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.typing import ConfigType

from .const import (
    CARD_URL,
    DOMAIN,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    PANEL_URL_PATH,
    URL_BASE,
    VERSION,
)
from .store import MenuStore
from .websocket_api import async_register_websocket_handlers

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Navigation Menu Manager component (no YAML config)."""
    hass.data.setdefault(DOMAIN, {})
    return True


def _resource_attr(item: object, key: str) -> object:
    """Read a field from a Lovelace resource item (dict or object)."""
    if isinstance(item, dict):
        return item.get(key)
    return getattr(item, key, None)


async def _async_register_card_resource(hass: HomeAssistant) -> None:
    """Register the card as a Lovelace resource so the frontend loads it before
    rendering cards.

    ``add_extra_js_url`` loads asynchronously and can race with dashboard
    rendering, which intermittently shows "Custom element doesn't exist:
    navigation-menu-manager-card". Lovelace loads its resources *before*
    rendering cards, so registering one removes the race. The URL is identical
    to the ``add_extra_js_url`` one, so the browser fetches the module only once
    (ES modules dedupe by URL). Storage mode only; YAML dashboards keep relying
    on ``add_extra_js_url``.
    """
    desired_url = f"{CARD_URL}?v={VERSION}"
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None) if lovelace else None
    if resources is None:
        return  # YAML mode or resource manager unavailable

    try:
        if hasattr(resources, "loaded") and not resources.loaded:
            await resources.async_load()
            resources.loaded = True

        items = list(resources.async_items() or [])
        ours = [
            item
            for item in items
            if str(_resource_attr(item, "url") or "").split("?")[0] == CARD_URL
        ]
        if any(_resource_attr(item, "url") == desired_url for item in ours):
            return  # already registered at the current version

        async def _call(func, *args) -> bool:
            # The collection's payload schema varies across HA versions
            # ("res_type" vs "type"); try both shapes.
            for payload in (
                {"res_type": "module", "url": desired_url},
                {"type": "module", "url": desired_url},
            ):
                try:
                    await func(*args, payload)
                    return True
                except Exception:  # noqa: BLE001
                    continue
            return False

        if ours:
            resource_id = _resource_attr(ours[0], "id")
            if not await _call(resources.async_update_item, resource_id):
                await _call(resources.async_create_item)
            for duplicate in ours[1:]:
                try:
                    await resources.async_delete_item(_resource_attr(duplicate, "id"))
                except Exception:  # noqa: BLE001
                    pass
        else:
            await _call(resources.async_create_item)
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning(
            "Navigation Menu Manager: could not register the card as a Lovelace "
            "resource (%s); falling back to add_extra_js_url only",
            err,
        )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Navigation Menu Manager from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    store = MenuStore(hass)
    await store.async_load()
    hass.data[DOMAIN]["store"] = store

    component_path = Path(__file__).parent / "frontend"
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(URL_BASE, str(component_path), True)]
        )
    except (RuntimeError, ValueError):
        # Already registered (e.g. on a config-entry reload). Re-registering the
        # same path raises; ignoring it keeps the card's JS being served.
        _LOGGER.debug("Static path %s already registered", URL_BASE)

    # Load the card via a Lovelace resource ONLY. We intentionally do NOT use
    # add_extra_js_url: it loads modules in a way that races with card rendering
    # (intermittent "Custom element doesn't exist"), and because it requests the
    # same module URL it pre-empts the resource's reliable load. Lovelace loads
    # its resources before rendering cards, so the element is always defined in
    # time — this is the same path the well-behaved community cards use.
    # Registered at HA-started (the resource manager isn't ready during boot) or
    # immediately if added at runtime; async_at_started is thread-safe.
    async_at_started(hass, _async_register_card_resource)

    # Register admin panel — guard so we don't double-register on reload
    existing_panels = hass.data.get("frontend_panels", {}) or {}
    if PANEL_URL_PATH not in existing_panels:
        await panel_custom.async_register_panel(
            hass,
            webcomponent_name="navigation-menu-manager-panel",
            frontend_url_path=PANEL_URL_PATH,
            module_url=f"{PANEL_URL}?v={VERSION}",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=True,
            embed_iframe=False,
        )

    async_register_websocket_handlers(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    try:
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
    except Exception:  # noqa: BLE001
        pass
    hass.data.pop(DOMAIN, None)
    return True
