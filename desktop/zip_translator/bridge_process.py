from __future__ import annotations

import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from .bridge_client import BridgeClient, BridgeError, default_bridge_url, load_bridge_token


LogCallback = Callable[[str], None]


@dataclass(frozen=True)
class BridgeRuntime:
    url: str
    token: str
    codex: str
    owned: bool


class IntegratedBridge:
    def __init__(self, log: LogCallback | None = None) -> None:
        self.log = log
        self.process: subprocess.Popen[str] | None = None
        self.runtime: BridgeRuntime | None = None
        self._owns_process = False
        self._state_lock = threading.Lock()
        self._start_lock = threading.Lock()
        self._reader: threading.Thread | None = None

    def ensure_running(self, preferred_url: str = "", preferred_token: str = "") -> BridgeRuntime:
        with self._start_lock:
            with self._state_lock:
                current = self.runtime
            if current and self._status_works(current.url, current.token):
                return current

            url = preferred_url.strip() or default_bridge_url()
            token = preferred_token.strip() or load_bridge_token() or load_or_create_integrated_token()
            existing = self._try_status(url, token)
            if existing:
                runtime = BridgeRuntime(url, token, existing, False)
                with self._state_lock:
                    self.runtime = runtime
                self._emit("이미 실행 중인 브리지에 연결했습니다.")
                return runtime

            requested_port = _url_port(url)
            port = requested_port if _port_is_available(requested_port) else _find_available_port()
            if port != requested_port:
                self._emit(f"기본 포트 {requested_port}이 사용 중이어서 {port} 포트를 사용합니다.")
            url = f"http://127.0.0.1:{port}"
            node_path, server_path = _embedded_runtime_paths()
            environment = os.environ.copy()
            environment["IMAGE_TRANSLATOR_PORT"] = str(port)
            environment["IMAGE_TRANSLATOR_TOKEN"] = token
            environment.setdefault("IMAGE_TRANSLATOR_CONCURRENCY", "6")
            creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            self._emit(f"통합 브리지 시작 · {url}")
            process = subprocess.Popen(
                [str(node_path), str(server_path)],
                cwd=str(server_path.parent),
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=creation_flags,
            )
            with self._state_lock:
                self.process = process
                self._owns_process = True
            self._reader = threading.Thread(
                target=self._read_output,
                args=(process,),
                daemon=True,
                name="integrated-bridge-log",
            )
            self._reader.start()

            deadline = time.monotonic() + 40
            last_error = "브리지 준비 시간 초과"
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    self._clear_process(process)
                    raise RuntimeError(f"통합 브리지가 종료되었습니다. (종료 코드: {process.returncode})")
                try:
                    status = BridgeClient(url, token, timeout=20).status()
                    if status.connected:
                        runtime = BridgeRuntime(url, token, status.codex, True)
                        with self._state_lock:
                            if self.process is not process:
                                raise RuntimeError("통합 브리지 시작이 중단되었습니다.")
                            self.runtime = runtime
                        return runtime
                    last_error = status.codex
                except Exception as exc:
                    last_error = str(exc)
                time.sleep(0.35)
            self.stop()
            raise RuntimeError(f"통합 브리지를 시작하지 못했습니다: {last_error}")

    def restart(self, preferred_url: str = "", preferred_token: str = "") -> BridgeRuntime:
        self.stop()
        return self.ensure_running(preferred_url, preferred_token)

    def stop(self) -> None:
        with self._state_lock:
            process = self.process
            owned = self._owns_process
            self.runtime = None
            self.process = None
            self._owns_process = False
        if not process or not owned or process.poll() is not None:
            return
        self._emit("통합 브리지를 종료합니다.")
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)

    def _try_status(self, url: str, token: str) -> str | None:
        if not token:
            return None
        try:
            status = BridgeClient(url, token, timeout=20).status()
            return status.codex if status.connected else None
        except (BridgeError, ValueError):
            return None

    def _status_works(self, url: str, token: str) -> bool:
        return self._try_status(url, token) is not None

    def _read_output(self, process: subprocess.Popen[str]) -> None:
        if not process.stdout:
            return
        for line in process.stdout:
            text = line.rstrip()
            if text:
                self._emit(text)

    def _clear_process(self, process: subprocess.Popen[str]) -> None:
        with self._state_lock:
            if self.process is process:
                self.process = None
                self.runtime = None
                self._owns_process = False

    def _emit(self, message: str) -> None:
        if self.log:
            self.log(message)


def load_or_create_integrated_token() -> str:
    token_path = _integrated_token_path()
    try:
        existing = token_path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass
    token = secrets.token_hex(24)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(f"{token}\n", encoding="utf-8")
    return token


def _integrated_token_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    root = Path(local_app_data) if local_app_data else Path.cwd()
    return root / "ImageKoreanTranslator" / "bridge-token.txt"


def _embedded_runtime_paths() -> tuple[Path, Path]:
    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        node_path = bundle_root / "runtime" / ("node.exe" if os.name == "nt" else "node")
        server_path = bundle_root / "bridge" / "server.js"
    else:
        node_command = shutil.which("node.exe") or shutil.which("node")
        if not node_command:
            raise FileNotFoundError("Node.js 실행 파일을 찾지 못했습니다.")
        node_path = Path(node_command)
        server_path = Path(__file__).resolve().parents[2] / "bridge" / "server.js"
    if not node_path.is_file():
        raise FileNotFoundError(f"내장 Node 런타임을 찾지 못했습니다: {node_path}")
    if not server_path.is_file():
        raise FileNotFoundError(f"내장 브리지 서버를 찾지 못했습니다: {server_path}")
    return node_path, server_path


def _url_port(url: str) -> int:
    parsed = urlparse(url)
    if parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise ValueError("통합 브리지는 이 PC의 로컬 주소만 사용할 수 있습니다.")
    return int(parsed.port or 38473)


def _port_is_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _find_available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])
