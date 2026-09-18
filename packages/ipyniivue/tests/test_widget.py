from __future__ import annotations

import base64

import pytest
import traitlets

from ipyniivue import NiiVue
from ipyniivue._generated import _JS_UNDEFINED, _UNSET, _make_args
from ipyniivue.widget import _decode_js_value


def test_generated_optional_args_omit_trailing_unset_values() -> None:
    assert _make_args(_UNSET, _UNSET) == []
    assert _make_args("scene.nvd", _UNSET) == ["scene.nvd"]
    assert _make_args(_UNSET, 0.5) == [_JS_UNDEFINED, 0.5]


def test_generated_optional_args_preserve_explicit_none() -> None:
    nv = NiiVue()

    nv.save_document()
    assert nv._msg_inbox[-1]["body"] == {"cmd": "saveDocument", "args": []}

    nv.save_document(None)
    assert nv._msg_inbox[-1]["body"] == {"cmd": "saveDocument", "args": [None]}


def test_non_json_serializable_loader_hook_is_not_exposed() -> None:
    assert not hasattr(NiiVue, "use_loader")


def test_non_json_serializable_overlay_hooks_are_not_exposed() -> None:
    assert not hasattr(NiiVue, "register_overlay_renderer")
    assert not hasattr(NiiVue, "unregister_overlay_renderer")


def test_binary_response_payload_decodes_to_bytes() -> None:
    payload = {
        "__ipyniivue_binary__": True,
        "data": base64.b64encode(b"nvd bytes").decode("ascii"),
        "byteLength": 9,
        "dtype": "Uint8Array",
    }

    assert _decode_js_value(payload) == b"nvd bytes"


def test_generated_wheel_zoom_anchor_is_an_enum_trait() -> None:
    # Paired public accessors on NVControlBase become synced traits; a string
    # union becomes an Enum so a typo cannot reach the widget.
    nv = NiiVue()
    assert nv.wheel_zoom_anchor is None
    nv.wheel_zoom_anchor = "pointer"
    assert nv.wheel_zoom_anchor == "pointer"
    with pytest.raises(traitlets.TraitError):
        nv.wheel_zoom_anchor = "cursor"


def test_generated_single_view_fill_canvas_is_a_bool_trait() -> None:
    nv = NiiVue()
    assert nv.is_single_view_fill_canvas is None
    nv.is_single_view_fill_canvas = False
    assert nv.is_single_view_fill_canvas is False


def test_generated_pan_following_crosshair_is_a_bool_trait() -> None:
    nv = NiiVue()
    assert nv.is_pan_following_crosshair is None
    nv.is_pan_following_crosshair = True
    assert nv.is_pan_following_crosshair is True
