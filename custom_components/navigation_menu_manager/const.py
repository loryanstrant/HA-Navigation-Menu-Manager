"""Constants for the Navigation Menu Manager integration."""
from __future__ import annotations

DOMAIN = "navigation_menu_manager"
VERSION = "0.1.3"

STORAGE_KEY = f"{DOMAIN}.menus"
STORAGE_VERSION = 1

URL_BASE = "/navigation_menu_manager_static"
CARD_FILENAME = "navigation-menu-manager-card.js"
PANEL_FILENAME = "navigation-menu-manager-panel.js"
CARD_URL = f"{URL_BASE}/{CARD_FILENAME}"
PANEL_URL = f"{URL_BASE}/{PANEL_FILENAME}"

PANEL_URL_PATH = "navigation-menus"
PANEL_TITLE = "Nav Menus"
PANEL_ICON = "mdi:menu"

SIGNAL_MENUS_UPDATED = f"{DOMAIN}_menus_updated"

DEFAULT_MENU_ID = "main"
DEFAULT_MENU = {
    "name": "Main Navigation",
    "style": "buttons",
    "items": [
        {"label": "Home", "icon": "mdi:home", "path": "home"},
        {"label": "Climate", "icon": "mdi:thermostat", "path": "climate"},
    ],
}
