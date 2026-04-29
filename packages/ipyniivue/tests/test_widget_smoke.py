"""Minimal sanity tests for ipyniivue.

These tests only verify that Python-side imports and widget
construction work. They do not exercise the browser-side rendering
path — that requires a headless Jupyter session with a real browser
(see ``packages/ipyniivue/README.md`` "Headless bitmap smoke testing").
"""

from __future__ import annotations

import ipyniivue
from ipyniivue import NIIVUE_EVENT_NAMES, NiiVue


def test_public_exports() -> None:
    assert NiiVue is ipyniivue.NiiVue
    assert NIIVUE_EVENT_NAMES is ipyniivue.NIIVUE_EVENT_NAMES


def test_event_names_is_non_empty_frozenset() -> None:
    assert isinstance(NIIVUE_EVENT_NAMES, frozenset)
    assert len(NIIVUE_EVENT_NAMES) > 0
    # NIIVUE_EVENT_NAMES is the curated allow-list for nv.on(...) and
    # must not include the high-frequency events the JS template silences.
    for silenced in ("canvasResize", "viewAttached", "viewDestroyed"):
        assert silenced not in NIIVUE_EVENT_NAMES


def test_construct_default_backend() -> None:
    # Plain construction should not touch the browser / require a display.
    nv = NiiVue()
    assert nv is not None
    # Backend is a constructor-only option; `NiiVue()` leaves it at the
    # traitlet default (None = let NiiVue pick WebGPU/WebGL2).
    assert nv.backend in (None, "", "webgpu", "webgl2")


def test_construct_with_webgl2_backend() -> None:
    nv = NiiVue(backend="webgl2")
    assert nv.backend == "webgl2"


def test_on_rejects_unknown_event() -> None:
    nv = NiiVue()
    try:
        nv.on("not-a-real-event", lambda _detail: None)
    except ValueError:
        return
    raise AssertionError("expected ValueError for unknown event name")
