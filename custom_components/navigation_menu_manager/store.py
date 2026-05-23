"""Persistent storage for navigation menu definitions."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from .const import DOMAIN, SIGNAL_MENUS_UPDATED, STORAGE_KEY, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)


class MenuStore:
    """Wrapper around HA's Store for menu definitions.

    Storage layout:
        {
            "menus": {
                "<menu_id>": {
                    "name": "<display name>",
                    "style": "buttons" | "icons" | "compact",
                    "items": [
                        {
                            "label": "...",
                            "icon": "mdi:...",
                            "path": "<view-id-or-full-path>",
                            "match": "exact" | "suffix" | "prefix"  (optional)
                        }
                    ]
                }
            }
        }
    """

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict[str, Any] = {"menus": {}}

    async def async_load(self) -> None:
        """Load menus from disk into memory."""
        data = await self._store.async_load()
        if data and isinstance(data, dict):
            self._data = {"menus": data.get("menus", {}) or {}}
        else:
            self._data = {"menus": {}}

    @property
    def menus(self) -> dict[str, Any]:
        """Return all menus."""
        return self._data.get("menus", {}) or {}

    def get_menu(self, menu_id: str) -> dict[str, Any] | None:
        """Return a specific menu by id."""
        return self.menus.get(menu_id)

    async def async_save_menu(self, menu_id: str, menu: dict[str, Any]) -> None:
        """Create or update a menu."""
        cleaned = _clean_menu(menu)
        self._data.setdefault("menus", {})[menu_id] = cleaned
        await self._store.async_save(self._data)
        async_dispatcher_send(self.hass, SIGNAL_MENUS_UPDATED, menu_id)

    async def async_delete_menu(self, menu_id: str) -> bool:
        """Delete a menu. Returns True if a menu was removed."""
        menus = self._data.setdefault("menus", {})
        if menu_id not in menus:
            return False
        del menus[menu_id]
        await self._store.async_save(self._data)
        async_dispatcher_send(self.hass, SIGNAL_MENUS_UPDATED, menu_id)
        return True


def _clean_menu(menu: dict[str, Any]) -> dict[str, Any]:
    """Normalise an incoming menu definition."""
    name = str(menu.get("name") or "").strip() or "Untitled Menu"
    style = menu.get("style") or "buttons"
    if style not in ("buttons", "icons", "compact"):
        style = "buttons"

    items_in = menu.get("items") or []
    items_out: list[dict[str, Any]] = []
    for raw in items_in:
        if not isinstance(raw, dict):
            continue
        label = str(raw.get("label") or "").strip()
        path = str(raw.get("path") or "").strip()
        if not label or not path:
            continue
        item: dict[str, Any] = {"label": label, "path": path}
        icon = raw.get("icon")
        if icon:
            item["icon"] = str(icon).strip()
        match = raw.get("match")
        if match in ("exact", "suffix", "prefix"):
            item["match"] = match
        items_out.append(item)

    return {"name": name, "style": style, "items": items_out}


def get_store(hass: HomeAssistant) -> MenuStore:
    """Return the MenuStore from hass.data."""
    return hass.data[DOMAIN]["store"]
