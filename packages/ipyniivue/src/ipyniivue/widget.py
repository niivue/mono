"""Hand-written wrapper class for the NiiVue widget.

Inherits the auto-generated reactive properties and command methods from
`_generated.py`. Adds:

  * a stable public class name (`NiiVue`)
  * the `_esm` / `_css` paths anywidget needs to load the JS bundle
  * `on()` / `off()` for subscribing to NiiVue events from Python (the JS
    side dispatches events via `model.send({kind: "event", ...})`; this
    class routes them to user callbacks, validating against the
    auto-generated `NIIVUE_EVENT_NAMES` set)
  * Pythonic load helpers (``add_volume_from_url``, ``add_mesh_from_url``)
    that translate snake_case kwargs to NiiVue's camelCase option names
  * notes on skipped JS object handles (volumes, meshes, drawingVolume,
    annotations, etc.) and the method-based API to reach them
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
    ``crosshair_pos``) are kept in sync with the JS view automatically;
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
        self._inbox_counter = itertools.count(1)
        # JS-to-Python: state-update channel via `_msg_outbox`. See the trait's
        # docstring in _generated.py. We use a closure (not a bound method)
        # because some traitlets setups have flaky observer-registration
        # behavior with bound methods, and stash an explicit strong
        # reference on the instance to be safe.

        def _outbox_handler(change: Any) -> None:
            new = change.get("new") if isinstance(change, dict) else None
            if not isinstance(new, dict):
                return
            body = new.get("body")
            if isinstance(body, dict):
                self._dispatch_message(self, body, [])

        self._outbox_handler = _outbox_handler  # strong ref
        self.observe(_outbox_handler, names=["_msg_outbox"])
        # Kept for backward compatibility / future migration if the
        # underlying anywidget routing becomes reliable.
        self.on_msg(self._dispatch_message)

    def send(self, content: Any, buffers: list[bytes] | None = None) -> None:
        """Send widget commands through a synced-state inbox.

        ipywidgets custom messages can be dropped if Python sends them before
        the browser view has registered its handler. Command methods are often
        called immediately after ``display(nv)`` in example notebooks, so route
        those command messages through ``_msg_inbox`` instead. The JS side
        drains any unseen sequence numbers once it initializes.
        """
        if (
            isinstance(content, dict)
            and isinstance(content.get("cmd"), str)
            and not buffers
        ):
            self._msg_inbox = [
                *self._msg_inbox,
                {"seq": next(self._inbox_counter), "body": content},
            ]
            return
        super().send(content, buffers=buffers)

    # Request/response (used by codegen-emitted async methods)

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

    async def wait_ready(self, timeout: float | None = 30.0) -> None:
        """Wait until the JS side has mounted in the browser.

        Most fire-and-forget commands, including
        :meth:`add_volume_from_url`, do not need this method. The JS side
        queues those commands until the canvas is attached, so async web
        asset loading can happen entirely in the browser without a
        Python-visible ready round trip.

        Example::

            from IPython.display import display
            nv = NiiVue()
            display(nv)
            await nv.wait_ready()
            print("mounted")

        Implementation note: ``wait_ready`` piggybacks on the
        request/response correlation. Python sends ``{cmd:"__ready__"}``;
        the JS shim replies after :func:`render` runs and the widget is
        mounted. Because this method intentionally waits for a JS-to-Python
        response, it is best reserved for code that truly needs that
        confirmation.

        Parameters
        ----------
        timeout
            Seconds to wait before giving up. ``None`` to wait forever.
        """
        coro = self._request("__ready__", [])
        if timeout is None:
            await coro
        else:
            await asyncio.wait_for(coro, timeout=timeout)

    # Pythonic helpers for non-traitlet properties
    #
    # The codegen walker skips seven NVControlBase properties because
    # their TS types are non-serializable JS handles:
    #
    #   volumes: NVImage[]               - use add_volume_from_url(),
    #                                       load_volumes(), remove_volume(),
    #                                       remove_all_volumes(), set_volume()
    #   meshes: NVMesh[]                 - use add_mesh_from_url(),
    #                                       load_meshes(), remove_mesh(),
    #                                       remove_all_meshes(), set_mesh()
    #   drawingVolume: NVImage           - use load_drawing(),
    #                                       create_empty_drawing(),
    #                                       close_drawing(), draw_undo()
    #   annotations: VectorAnnotation[]  - use add_annotation(),
    #                                       remove_annotation(),
    #                                       clear_annotations(),
    #                                       get_annotations_json()
    #   annotationStyle: AnnotationStyle - set fields individually via the
    #                                       `annotation_*` reactive
    #                                       properties (e.g.
    #                                       annotation_brush_radius)
    #   customLayout: CustomLayoutTile[] - use set_custom_layout(),
    #                                       clear_custom_layout()
    #   volumeTransform: Record<...>     - use register_volume_transform()
    #                                       and apply_volume_transform()
    #
    # All of these flow through the auto-generated command methods;
    # this section adds only the Pythonic conveniences that wrap them.

    def add_volume_from_url(self, url: str, **opts: Any) -> None:
        """Load one volume from a URL.

        Convenience wrapper for ``self.load_volumes([{"url": url, ...}])``.
        Keyword arguments are translated snake_case to camelCase for the
        underlying NiiVue option names. Common options:

          * ``cal_min`` / ``cal_max``: window min/max
          * ``colormap``: e.g. "gray", "hot", "viridis"
          * ``opacity``: 0-1
          * ``visible``: bool
          * ``frame_4d``: int, frame index for 4D volumes

        Example::

            nv.add_volume_from_url(
                "https://niivue.github.io/niivue-demo-images/mni152.nii.gz",
                cal_min=30,
                cal_max=80,
                colormap="gray",
            )
        """
        opts_camel = {_snake_to_camel(k): v for k, v in opts.items()}
        opts_camel["url"] = url
        self.load_volumes([opts_camel])

    def add_mesh_from_url(self, url: str, **opts: Any) -> None:
        """Load one mesh from a URL.

        Convenience wrapper for ``self.load_meshes([{"url": url, ...}])``.
        See :meth:`add_volume_from_url` for the snake_case to camelCase
        translation rule.
        """
        opts_camel = {_snake_to_camel(k): v for k, v in opts.items()}
        opts_camel["url"] = url
        self.load_meshes([opts_camel])

    def download_bitmap(
        self,
        filename: str = "myBitmap.png",
        quality: float = 0.92,
    ) -> None:
        """Queue a browser download using NiiVue's ``saveBitmap`` method.

        This is intentionally fire-and-forget. The browser-side command
        queue preserves ordering, so callers can queue a volume load and
        then queue this method without waiting for a Python-visible ready
        response.
        """
        self.send({"cmd": "saveBitmap", "args": [filename, quality]})

    # Drawing extension (nv-ext-drawing)

    async def find_drawing_boundary_slices(
        self,
        axis: int = 0,
    ) -> dict[str, Any] | None:
        """Find first/last slices containing drawing data along an axis.

        Reads the live drawing bitmap from the JS-side extension context.
        Returns ``None`` if no drawing volume exists yet (call
        :meth:`create_empty_drawing` first) or if no voxels are drawn.

        Parameters
        ----------
        axis
            Slice axis: 0=Axial, 1=Coronal, 2=Sagittal.

        Returns
        -------
        dict | None
            ``{"first": int, "last": int, "elapsed_ms": float}`` or
            ``None``.
        """
        return await self._request("__ext_drawing_find_boundaries", [axis])

    async def interpolate_drawing_slices(
        self,
        axis: int = 0,
        use_intensity_guided: bool = False,
        intensity_weight: float = 0.7,
        intensity_sigma: float = 0.1,
        binary_threshold: float = 0.38,
        apply_smoothing_to_slices: bool = True,
    ) -> dict[str, Any]:
        """Interpolate between drawn slices to fill gaps.

        Use after drawing on a few non-adjacent slices to fill the
        in-between slices. Heavy work runs in a Web Worker on the JS
        side; the result is written back into NiiVue's drawing volume
        before this call returns.

        Parameters
        ----------
        axis
            Slice axis to interpolate along: 0=Axial, 1=Coronal,
            2=Sagittal.
        use_intensity_guided
            If True, use the background volume's intensity to guide
            interpolation (better for anatomical boundaries).
        intensity_weight
            Weight of the intensity term [0, 1] when
            ``use_intensity_guided`` is True.
        intensity_sigma
            Gaussian sigma for intensity similarity [0, 1].
        binary_threshold
            Final binarization threshold [0, 1].
        apply_smoothing_to_slices
            Smooth the source slices before interpolating.

        Returns
        -------
        dict
            ``{"before": int, "after": int, "elapsed_ms": float}``
            voxel counts.
        """
        options = {
            "intensityWeight": intensity_weight,
            "intensitySigma": intensity_sigma,
            "binaryThreshold": binary_threshold,
            "applySmoothingToSlices": apply_smoothing_to_slices,
        }
        return await self._request(
            "__ext_drawing_interpolate_slices",
            [axis, bool(use_intensity_guided), options],
        )

    # Image-processing extension (nv-ext-image-processing)

    async def apply_image_transform(
        self,
        name: str,
        volume_index: int = 0,
        options: dict[str, Any] | None = None,
        replace_background: bool = False,
    ) -> dict[str, Any]:
        """Apply a bundled image-processing transform to a loaded volume.

        Bundled transforms (registered automatically on widget mount):
        ``otsu``, ``removeHaze``, ``conform``, ``connectedLabel``. Use
        :meth:`get_volume_transform_info` to discover the option schema
        for any transform.

        Heavy work runs in a Web Worker on the JS side, so this does not
        block the browser. The result volume is added to the scene as an
        overlay; pass ``replace_background=True`` to remove existing
        volumes first (the right call for ``removeHaze``).

        Parameters
        ----------
        name
            Transform name. Must be present in
            :attr:`volume_transforms` (the read-only traitlet seeded
            from NiiVue at mount).
        volume_index
            Source volume index. Default 0 (background).
        options
            Transform-specific options. See
            :meth:`get_volume_transform_info`.
        replace_background
            If True, remove all volumes first and load the result as the
            new background. If False (default), add as an overlay.

        Returns
        -------
        dict
            ``{"name": str, "elapsed_ms": float}``.

        Example::

            info = await nv.get_volume_transform_info("otsu")
            await nv.apply_image_transform("otsu", 0)
        """
        return await self._request(
            "__ext_apply_image_transform",
            [name, volume_index, options or {}, bool(replace_background)],
        )

    # Event subscription

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

    # Internal: route messages from JS

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


def _snake_to_camel(name: str) -> str:
    """Convert snake_case to camelCase for NiiVue option keys.

    Used by ``NiiVue.add_volume_from_url`` etc. so Python users can pass
    ``cal_min=30`` and have it land at the JS side as ``calMin: 30``.

    Names without underscores are returned unchanged. Numeric runs after
    a digit-letter boundary collapse with the letter (e.g. ``in_3d`` to
    ``in3D`` is *not* what we do here; Python users would write ``in3d``
    directly because Python identifiers can include digits but underscore
    handling differs from the codegen direction).
    """
    parts = name.split("_")
    return parts[0] + "".join(p.title() for p in parts[1:] if p)
