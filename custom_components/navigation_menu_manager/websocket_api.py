"""WebSocket API for Navigation Menu Manager."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import DOMAIN, SIGNAL_MENUS_UPDATED
from .store import MenuStore, get_store

_LOGGER = logging.getLogger(__name__)


MENU_ITEM_SCHEMA = vol.Schema(
    {
        vol.Required("label"): str,
        vol.Required("path"): str,
        vol.Optional("icon"): vol.Any(str, None),
        vol.Optional("match"): vol.In(["exact", "suffix", "prefix"]),
    },
    extra=vol.ALLOW_EXTRA,
)

MENU_SCHEMA = vol.Schema(
    {
        vol.Required("name"): str,
        vol.Optional("style", default="buttons"): vol.In(
            ["buttons", "icons", "compact"]
        ),
        vol.Required("items"): [MENU_ITEM_SCHEMA],
    },
    extra=vol.ALLOW_EXTRA,
)


@callback
def async_register_websocket_handlers(hass: HomeAssistant) -> None:
    """Register all WS handlers for this integration."""
    websocket_api.async_register_command(hass, ws_list_menus)
    websocket_api.async_register_command(hass, ws_get_menu)
    websocket_api.async_register_command(hass, ws_save_menu)
    websocket_api.async_register_command(hass, ws_delete_menu)
    websocket_api.async_register_command(hass, ws_subscribe_menu)


def _menus_payload(store: MenuStore) -> dict[str, Any]:
    return {"menus": store.menus}


def _get_store(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg_id: int,
) -> MenuStore | None:
    """Return the MenuStore, or send a not_ready error and return None."""
    try:
        return get_store(hass)
    except (KeyError, AttributeError):
        connection.send_error(msg_id, "not_ready", "Integration is not ready yet")
        return None


# --- Read commands: available to any authenticated user (no admin gate) ----


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list_menus"})
@websocket_api.async_response
async def ws_list_menus(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return all menus."""
    store = _get_store(hass, connection, msg["id"])
    if store is None:
        return
    connection.send_result(msg["id"], _menus_payload(store))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/get_menu",
        vol.Required("menu_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_menu(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return one menu."""
    store = _get_store(hass, connection, msg["id"])
    if store is None:
        return
    menu = store.get_menu(msg["menu_id"])
    if menu is None:
        connection.send_error(msg["id"], "not_found", f"Menu '{msg['menu_id']}' not found")
        return
    connection.send_result(msg["id"], {"menu_id": msg["menu_id"], "menu": menu})


# --- Write commands: admin only --------------------------------------------
#
# Decorator order matters. ``require_admin`` must be applied to the handler
# *before* ``websocket_command`` registers it, so it has to sit *inside*
# (below) ``websocket_command`` in the stack:
#
#     @websocket_api.websocket_command({...})   # outermost: registers command
#     @websocket_api.require_admin              # marks handler admin-only
#     @websocket_api.async_response             # innermost: async wrapper
#     async def handler(...): ...
#
# If ``require_admin`` is placed on the outside, the admin flag is never
# baked into the registered command correctly and the command set ends up
# malformed — which raised a spurious ``Unauthorized`` for non-admin users
# even on the unrelated read/subscribe commands.


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/save_menu",
        vol.Required("menu_id"): str,
        vol.Required("menu"): MENU_SCHEMA,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_menu(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create or update a menu."""
    store = get_store(hass)
    menu_id = msg["menu_id"].strip()
    if not menu_id:
        connection.send_error(msg["id"], "invalid_id", "Menu id is required")
        return
    await store.async_save_menu(menu_id, msg["menu"])
    connection.send_result(msg["id"], {"menu_id": menu_id, "menu": store.get_menu(menu_id)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/delete_menu",
        vol.Required("menu_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_menu(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete a menu."""
    store = get_store(hass)
    deleted = await store.async_delete_menu(msg["menu_id"])
    if not deleted:
        connection.send_error(msg["id"], "not_found", f"Menu '{msg['menu_id']}' not found")
        return
    connection.send_result(msg["id"], {"menu_id": msg["menu_id"], "deleted": True})


# --- Subscribe: available to any authenticated user (no admin gate) --------


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/subscribe_menu",
        vol.Required("menu_id"): str,
    }
)
@websocket_api.async_response
async def ws_subscribe_menu(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Subscribe to live updates for a single menu.

    The subscriber receives the current menu state immediately, then any
    time the menu (or any menu — clients filter by id) is saved/deleted.
    """
    menu_id = msg["menu_id"]
    store = _get_store(hass, connection, msg["id"])
    if store is None:
        return

    _LOGGER.debug("subscribe_menu: id=%s menu_id=%s", msg["id"], menu_id)

    def _send_current() -> None:
        menu = store.get_menu(menu_id)
        connection.send_message(
            websocket_api.event_message(
                msg["id"], {"menu_id": menu_id, "menu": menu}
            )
        )

    @callback
    def _on_update(updated_menu_id: str) -> None:
        # Re-send whenever anything changes — cheap and avoids missed updates
        # when a rename has changed the id of the menu the client is watching.
        if updated_menu_id == menu_id or updated_menu_id == "*":
            _send_current()

    unsub = async_dispatcher_connect(hass, SIGNAL_MENUS_UPDATED, _on_update)

    def _unsubscribe() -> None:
        unsub()

    connection.subscriptions[msg["id"]] = _unsubscribe
    connection.send_result(msg["id"])
    _send_current()
