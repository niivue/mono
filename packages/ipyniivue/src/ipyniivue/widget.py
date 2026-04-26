"""Hand-written wrapper class for the NiiVue widget.

Inherits the auto-generated reactive properties and command methods from
`_generated.py`. Adds:

  * a stable public class name (`NiiVue`)
  * the `_esm` / `_css` paths anywidget needs to load the JS bundle
  * `on()` / `off()` for subscribing to NiiVue events from Python (the JS
    side dispatches events via `model.send({kind: "event", ...})`; this
    class routes them to user callbacks, validating against the
    auto-generated `NIIVUE_EVENT_NAMES` set)
  * a few bespoke helpers for properties whose JS types do not map onto
    JSON-serializable traitlets (volumes, meshes, drawingVolume)
"""

from __future__ import annotations

import asyncio
import itertools
import pathlib
from collections.abc import Callable
from typing import Any

from ipyniivue._generated import NIIVUE_EVENT_NAMES, _GeneratedNiiVue

_HERE = pathlib.Path(__file__).parent
_STATIC = _HERE / "static"


class NiiVue(_GeneratedNiiVue):
    """A NiiVue widget for Jupyter.

    Reactive properties (e.g. ``is_colorbar_visible``, ``slice_type``,
    ``crosshair_pos``) are kept in sync with the JS view automatically —
    set them like any traitlet.

    Methods send command messages to the JS view. Use them for actions
    that don't have an obvious "set this value" form, e.g. loading
    volumes, undoing a drawing stroke, saving a screenshot.

    Subscribe to NiiVue events with :meth:`on`. Available event names are
    in :data:`NIIVUE_EVENT_NAMES`.
    """

    _esm = _STATIC / "widget.js"
    # No CSS yet; anywidget treats _css as optional.

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._event_callbacks: dict[str, list[Callable[[Any], None]]] = {}
        # Request/response infrastructure for value-returning methods.
        # Each outbound `_request()` allocates a monotonic id and parks a
        # Future in `_pending`; `_dispatch_message` routes the response.
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._req_counter = itertools.count(1)
        self.on_msg(self._dispatch_message)

    # ─── Request/response (used by codegen-emitted async methods) ────

    async def _request(self, cmd: str, args: list[Any]) -> Any:
        """Send a command to JS and await its response.

        Used internally by codegen-emitted async methods (e.g.
        ``get_crosshair_pos``). Returns the JSON-roundtripped result, or
        raises :class:`RuntimeError` if the JS side reports an error.
        """
        req_id = next(self._req_counter)
        loop = asyncio.get_event_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._pending[req_id] = future
        self.send({"cmd": cmd, "args": args, "req_id": req_id})
        try:
            return await future
        finally:
            self._pending.pop(req_id, None)

    # ─── Event subscription ──────────────────────────────────────────

    def on(
        self,
        event: str,
        callback: Callable[[Any], None],
    ) -> Callable[[], None]:
        """Subscribe to a NiiVue event. Returns an unsubscribe function.

        The callback receives the event's ``detail`` payload (whatever JS
        attaches to the corresponding ``CustomEvent``). Detail shapes are
        documented in the niivue ``NVEventMap`` interface and are
        delivered to Python as plain dicts/lists/scalars.

        Example::

            nv = NiiVue()
            unsubscribe = nv.on(
                "locationChange",
                lambda detail: print(detail.get("string")),
            )
            # ... later ...
            unsubscribe()

        Raises
        ------
        ValueError
            If ``event`` is not a known NiiVue event.
        """
        if event not in NIIVUE_EVENT_NAMES:
            known = ", ".join(sorted(NIIVUE_EVENT_NAMES))
            msg = f"Unknown NiiVue event {event!r}. Known events: {known}"
            raise ValueError(msg)
        self._event_callbacks.setdefault(event, []).append(callback)

        def unsubscribe() -> None:
            cbs = self._event_callbacks.get(event, [])
            if callback in cbs:
                cbs.remove(callback)

        return unsubscribe

    def off(
        self,
        event: str,
        callback: Callable[[Any], None] | None = None,
    ) -> None:
        """Remove a previously-registered event callback.

        If ``callback`` is omitted, all callbacks for ``event`` are removed.
        """
        if callback is None:
            self._event_callbacks.pop(event, None)
            return
        cbs = self._event_callbacks.get(event)
        if cbs and callback in cbs:
            cbs.remove(callback)

    # ─── Internal: route messages from JS ────────────────────────────

    def _dispatch_message(self, _widget: Any, content: Any, _buffers: Any) -> None:
        if not isinstance(content, dict):
            return
        kind = content.get("kind")
        if kind == "event":
            name = content.get("name")
            if not isinstance(name, str):
                return
            for cb in list(self._event_callbacks.get(name, [])):
                try:
                    cb(content.get("detail"))
                except Exception:  # noqa: BLE001
                    # Swallow callback errors so one bad callback doesn't
                    # break the widget. Users can wrap their own try/except
                    # if they want richer handling.
                    import traceback

                    traceback.print_exc()
        elif kind == "response":
            req_id = content.get("req_id")
            future = self._pending.get(req_id) if req_id is not None else None
            if future is None or future.done():
                return
            if content.get("ok"):
                future.set_result(content.get("result"))
            else:
                err = content.get("error", "unknown error from JS side")
                future.set_exception(RuntimeError(str(err)))
