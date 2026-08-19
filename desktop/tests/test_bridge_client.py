from __future__ import annotations

import base64
import io
from typing import Any

from PIL import Image

from zip_translator.bridge_client import (
    BridgeClient,
    CODEX_IMAGE_TRANSLATION_TIMEOUT_SECONDS,
    TRANSLATION_TIMEOUT_SECONDS,
    _http_error_detail,
)


def _image_bytes(image_format: str, color: str = "white") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (80, 60), color).save(buffer, format=image_format)
    return buffer.getvalue()


class StubBridgeClient(BridgeClient):
    def __init__(self, edited: bytes | None) -> None:
        super().__init__("http://127.0.0.1:38473", "test-token")
        self.edited = edited
        self.requests: list[tuple[str, str, dict[str, Any] | None]] = []

    def _request_json(
        self,
        method: str,
        route: str,
        payload: dict[str, Any] | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        self.requests.append((method, route, payload))
        if route == "/translate":
            return {
                "bridgeRequestId": 7,
                "regions": [{"translated": "번역"}],
                "qualityReview": {
                    "requiresUserReview": True,
                    "attempts": 3,
                },
                "editedImage": None
                if self.edited is None
                else {"mimeType": "image/webp", "data": base64.b64encode(self.edited).decode("ascii")},
            }
        if route == "/cancel-all":
            return {"ok": True, "cancelledCount": 4}
        return {"ok": True}


def test_default_translation_timeout_covers_three_visual_qa_attempts() -> None:
    client = BridgeClient("http://127.0.0.1:38473", "test-token")

    assert TRANSLATION_TIMEOUT_SECONDS == 3600
    assert client.timeout == 3600


def test_codex_image_render_mode_uses_extended_timeout() -> None:
    client = BridgeClient(
        "http://127.0.0.1:38473",
        "test-token",
        render_mode="codex-image",
    )

    assert client.timeout == CODEX_IMAGE_TRANSLATION_TIMEOUT_SECONDS == 10800


def test_translated_webp_is_restored_to_original_png_format() -> None:
    client = StubBridgeClient(_image_bytes("WEBP", "gray"))

    result = client.translate_image(_image_bytes("PNG"), ".png", "pages/001.png", 1)

    assert result.changed
    assert result.region_count == 1
    assert result.quality_review_required
    assert result.quality_attempts == 3
    with Image.open(io.BytesIO(result.data)) as image:
        assert image.format == "PNG"
        assert image.size == (80, 60)
    assert [route for _, route, _ in client.requests] == ["/translate", "/commit"]


def test_manual_review_mode_is_sent_to_bridge() -> None:
    client = StubBridgeClient(_image_bytes("WEBP", "gray"))

    client.translate_image(_image_bytes("PNG"), ".png", "pages/001.png", 1, manual_review=True)

    translate_payload = client.requests[0][2]
    assert translate_payload is not None
    assert translate_payload["metadata"]["qualityReviewMode"] == "manual"
    assert translate_payload["metadata"]["maxAutoQaAttempts"] == 1


def test_selected_auto_review_limit_is_sent_to_bridge() -> None:
    client = StubBridgeClient(_image_bytes("WEBP", "gray"))
    client.max_auto_qa_attempts = 5

    client.translate_image(_image_bytes("PNG"), ".png", "pages/001.png", 1)

    translate_payload = client.requests[0][2]
    assert translate_payload is not None
    assert translate_payload["metadata"]["maxAutoQaAttempts"] == 5


def test_visual_qa_skip_setting_is_sent_to_bridge_but_manual_review_overrides_it() -> None:
    client = StubBridgeClient(_image_bytes("WEBP", "gray"))
    client.skip_visual_qa = True

    client.translate_image(_image_bytes("PNG"), ".png", "pages/001.png", 1)
    automatic_payload = client.requests[0][2]
    assert automatic_payload is not None
    assert automatic_payload["metadata"]["skipVisualQa"] is True

    client.requests.clear()
    client.translate_image(_image_bytes("PNG"), ".png", "pages/001.png", 1, manual_review=True)
    manual_payload = client.requests[0][2]
    assert manual_payload is not None
    assert manual_payload["metadata"]["skipVisualQa"] is False


def test_codex_image_render_mode_is_sent_to_bridge() -> None:
    client = StubBridgeClient(_image_bytes("WEBP", "gray"))
    client.render_mode = "codex-image"

    client.translate_image(_image_bytes("PNG"), ".png", "pages/001.png", 1)

    translate_payload = client.requests[0][2]
    assert translate_payload is not None
    assert translate_payload["metadata"]["renderMode"] == "codex-image"


def test_no_regions_keeps_original_bytes() -> None:
    original = _image_bytes("JPEG")
    client = StubBridgeClient(None)

    result = client.translate_image(original, ".jpg", "001.jpg", 1)

    assert not result.changed
    assert result.data == original


def test_skip_request_calls_bridge_cancel_endpoint() -> None:
    client = StubBridgeClient(None)

    cancelled = client.skip_request(7, 3)

    assert cancelled is False
    method, route, payload = client.requests[-1]
    assert (method, route) == ("POST", "/cancel")
    assert payload == {"bridgeRequestId": 7, "imageIndex": 3}


def test_cancel_all_requests_calls_bridge_endpoint() -> None:
    client = StubBridgeClient(None)

    cancelled = client.cancel_all_requests()

    assert cancelled == 4
    method, route, payload = client.requests[-1]
    assert (method, route) == ("POST", "/cancel-all")
    assert payload == {}


def test_http_error_detail_includes_codex_diagnostics() -> None:
    class FakeHttpError:
        reason = "Internal Server Error"

        @staticmethod
        def read() -> bytes:
            return (
                b'{"error":"Codex model compatibility error",'
                b'"details":["stage: render","prompt_cache_retention unsupported"]}'
            )

    detail = _http_error_detail(FakeHttpError())  # type: ignore[arg-type]

    assert "Codex model compatibility error" in detail
    assert "stage: render" in detail
    assert "prompt_cache_retention unsupported" in detail
