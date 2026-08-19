from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from PIL import Image, ImageOps, UnidentifiedImageError


MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
# JSON Base64 오버헤드를 포함해 브리지의 20MB 본문 한도 안에 들어가게 합니다.
MAX_UPLOAD_BYTES = 14 * 1024 * 1024
TRANSLATION_TIMEOUT_SECONDS = 60 * 60
CODEX_IMAGE_TRANSLATION_TIMEOUT_SECONDS = 3 * 60 * 60


@dataclass(frozen=True)
class BridgeStatus:
    connected: bool
    codex: str


@dataclass(frozen=True)
class ImageTranslation:
    data: bytes
    changed: bool
    region_count: int
    bridge_request_id: int | None = None
    quality_review_required: bool = False
    quality_attempts: int = 0


class BridgeError(RuntimeError):
    pass


class BridgeClient:
    def __init__(
        self,
        url: str,
        token: str,
        timeout: int = TRANSLATION_TIMEOUT_SECONDS,
        max_auto_qa_attempts: int = 3,
        render_mode: str = "local",
    ) -> None:
        self.url = url.rstrip("/")
        self.token = token.strip()
        self.render_mode = "codex-image" if render_mode == "codex-image" else "local"
        selected_timeout = max(30, int(timeout))
        self.timeout = max(
            selected_timeout,
            CODEX_IMAGE_TRANSLATION_TIMEOUT_SECONDS if self.render_mode == "codex-image" else 30,
        )
        self.max_auto_qa_attempts = max(1, min(5, int(max_auto_qa_attempts)))
        if not self.url.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise ValueError("브리지 주소는 이 PC의 127.0.0.1 또는 localhost만 사용할 수 있습니다.")
        if not self.token:
            raise ValueError("브리지 연결 토큰이 없습니다.")

    def status(self) -> BridgeStatus:
        payload = self._request_json("GET", "/status")
        return BridgeStatus(bool(payload.get("ok")), str(payload.get("codex", "상태 확인 실패")))

    def skip_request(self, request_id: int, image_number: int | None = None) -> bool:
        payload = self._request_json(
            "POST",
            "/cancel",
            {
                "bridgeRequestId": int(request_id),
                "imageIndex": image_number,
            },
            timeout=15,
        )
        return bool(payload.get("cancelled"))

    def cancel_all_requests(self) -> int:
        payload = self._request_json("POST", "/cancel-all", {}, timeout=15)
        return max(0, int(payload.get("cancelledCount") or 0))

    def translate_image(
        self,
        raw: bytes,
        suffix: str,
        name: str,
        image_number: int,
        *,
        manual_review: bool = False,
    ) -> ImageTranslation:
        upload, mime_type = _prepare_upload(raw, suffix)
        payload = {
            "image": {
                "mimeType": mime_type,
                "data": base64.b64encode(upload).decode("ascii"),
            },
            "metadata": {
                "index": image_number,
                "elementType": "zip",
                "sourceUrl": f"zip://{name}",
                "archiveName": name,
                "qualityReviewMode": "manual" if manual_review else "automatic",
                "maxAutoQaAttempts": 1 if manual_review else self.max_auto_qa_attempts,
                "renderMode": self.render_mode,
            },
        }
        response = self._request_json("POST", "/translate", payload)
        request_id = _positive_int(response.get("bridgeRequestId"))
        quality_review = response.get("qualityReview") if isinstance(response.get("qualityReview"), dict) else {}
        review_required = bool(quality_review.get("requiresUserReview"))
        quality_attempts = max(0, int(quality_review.get("attempts") or 0))
        edited = response.get("editedImage")
        if not isinstance(edited, dict) or not edited.get("data"):
            self._commit(request_id, image_number, True)
            return ImageTranslation(raw, False, len(response.get("regions") or []), request_id, review_required, quality_attempts)

        try:
            edited_bytes = base64.b64decode(str(edited["data"]), validate=True)
            restored = _restore_original_format(edited_bytes, suffix)
        except Exception as exc:
            self._commit(request_id, image_number, False, str(exc))
            raise BridgeError(f"브리지 결과 이미지를 {suffix} 형식으로 복원하지 못했습니다: {exc}") from exc

        self._commit(request_id, image_number, True)
        return ImageTranslation(restored, True, len(response.get("regions") or []), request_id, review_required, quality_attempts)

    def _commit(
        self,
        request_id: int | None,
        image_number: int,
        success: bool,
        error: str = "",
    ) -> None:
        if request_id is None:
            return
        try:
            self._request_json(
                "POST",
                "/commit",
                {
                    "bridgeRequestId": request_id,
                    "imageIndex": image_number,
                    "elementType": "zip",
                    "success": success,
                    "error": error[:500],
                },
                timeout=15,
            )
        except BridgeError:
            # 번역 결과 자체는 이미 받았으므로 확인 로그 전송 실패는 작업 실패로 만들지 않습니다.
            pass

    def _request_json(
        self,
        method: str,
        route: str,
        payload: dict[str, Any] | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        data = None
        headers = {
            "Accept": "application/json",
            "X-Bridge-Token": self.token,
        }
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        request = Request(f"{self.url}{route}", data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=timeout or self.timeout) as response:
                body = response.read().decode("utf-8")
        except HTTPError as exc:
            detail = _http_error_detail(exc)
            raise BridgeError(f"브리지 오류 ({exc.code}): {detail}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise BridgeError(
                "로컬 브리지에 연결하지 못했습니다. bridge\\start-bridge.cmd가 실행 중인지 확인하세요. "
                f"({exc})"
            ) from exc
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as exc:
            raise BridgeError("브리지가 올바른 JSON을 반환하지 않았습니다.") from exc
        if not isinstance(parsed, dict):
            raise BridgeError("브리지 응답 형식이 올바르지 않습니다.")
        if parsed.get("error"):
            raise BridgeError(str(parsed["error"]))
        return parsed


def default_bridge_url() -> str:
    port = os.environ.get("IMAGE_TRANSLATOR_PORT", "38473").strip() or "38473"
    return f"http://127.0.0.1:{port}"


def load_bridge_token() -> str:
    environment_token = os.environ.get("IMAGE_TRANSLATOR_TOKEN", "").strip()
    if environment_token:
        return environment_token
    for root in _project_root_candidates():
        token_path = root / "bridge" / ".bridge-token"
        try:
            token = token_path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if token:
            return token
    return ""


def find_bridge_start_script() -> Path | None:
    for root in _project_root_candidates():
        script = root / "bridge" / "start-bridge.cmd"
        if script.is_file():
            return script
    return None


def start_bridge_console() -> Path:
    script = find_bridge_start_script()
    if script is None:
        raise FileNotFoundError("bridge\\start-bridge.cmd를 찾지 못했습니다.")
    comspec = os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe")
    creation_flags = subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0
    subprocess.Popen(
        [comspec, "/d", "/c", str(script)],
        cwd=str(script.parent),
        creationflags=creation_flags,
    )
    return script


def open_codex_login_console() -> None:
    import shutil

    executable = shutil.which("codex.cmd") or shutil.which("codex.exe") or shutil.which("codex")
    if not executable:
        raise FileNotFoundError("Codex CLI를 찾지 못했습니다.")
    comspec = os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe")
    command_line = subprocess.list2cmdline([executable, "login"])
    creation_flags = subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0
    subprocess.Popen(
        [comspec, "/d", "/k", command_line],
        creationflags=creation_flags,
    )


def _project_root_candidates() -> list[Path]:
    candidates = [Path(__file__).resolve().parents[2], Path.cwd()]
    if getattr(sys, "frozen", False):
        executable_dir = Path(sys.executable).resolve().parent
        candidates.extend([executable_dir, executable_dir.parent, executable_dir.parent.parent])
    unique: list[Path] = []
    for candidate in candidates:
        if candidate not in unique:
            unique.append(candidate)
    return unique


def _prepare_upload(raw: bytes, suffix: str) -> tuple[bytes, str]:
    normalized = suffix.lower()
    if normalized in MIME_TYPES and len(raw) <= MAX_UPLOAD_BYTES:
        return raw, MIME_TYPES[normalized]
    if normalized not in MIME_TYPES and normalized != ".bmp":
        raise BridgeError(f"지원하지 않는 이미지 형식입니다: {suffix}")
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            converted = ImageOps.exif_transpose(opened).convert("RGBA")
            buffer = io.BytesIO()
            converted.save(buffer, format="PNG", optimize=True)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise BridgeError(f"이미지를 읽지 못했습니다: {exc}") from exc
    prepared = buffer.getvalue()
    if len(prepared) > MAX_UPLOAD_BYTES:
        raise BridgeError("이미지 데이터가 15MB를 넘어 브리지로 보낼 수 없습니다.")
    return prepared, "image/png"


def _restore_original_format(edited_webp: bytes, suffix: str) -> bytes:
    normalized = suffix.lower()
    buffer = io.BytesIO()
    with Image.open(io.BytesIO(edited_webp)) as opened:
        image = opened.convert("RGBA")
        if normalized in {".jpg", ".jpeg"}:
            background = Image.new("RGB", image.size, "white")
            background.paste(image, mask=image.getchannel("A"))
            background.save(buffer, format="JPEG", quality=96, subsampling=0, optimize=True)
        elif normalized == ".webp":
            image.save(buffer, format="WEBP", lossless=True, method=6)
        elif normalized == ".bmp":
            image.convert("RGB").save(buffer, format="BMP")
        else:
            image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _http_error_detail(error: HTTPError) -> str:
    try:
        body = error.read().decode("utf-8", errors="replace")
        parsed = json.loads(body)
        if isinstance(parsed, dict) and parsed.get("error"):
            return str(parsed["error"])
        return body[-800:] or str(error.reason)
    except Exception:
        return str(error.reason)
