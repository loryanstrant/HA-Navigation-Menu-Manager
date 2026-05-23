"""The Navigation Menu Manager integration."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
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


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Navigation Menu Manager from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    store = MenuStore(hass)
    await store.async_load()
    hass.data[DOMAIN]["store"] = store

    component_path = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(URL_BASE, str(component_path), True)]
    )

    add_extra_js_url(hass, f"{CARD_URL}?v={VERSION}")

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
