from __future__ import annotations

import base64

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


def test_binary_response_payload_decodes_to_bytes() -> None:
    payload = {
        "__ipyniivue_binary__": True,
        "data": base64.b64encode(b"nvd bytes").decode("ascii"),
        "byteLength": 9,
        "dtype": "Uint8Array",
    }

    assert _decode_js_value(payload) == b"nvd bytes"
