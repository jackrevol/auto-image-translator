from __future__ import annotations

import os
import io
import queue
import re
import shutil
import tempfile
import threading
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageOps, ImageTk, UnidentifiedImageError

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
except ImportError:  # 개발 환경에 선택 의존성이 없으면 파일 선택 방식으로 계속 실행합니다.
    DND_FILES = None
    TkinterDnD = None

from .archive import TranslationCancelled, default_output_path, review_zip_image, translate_zip
from .bridge_client import (
    BridgeClient,
    default_bridge_url,
    load_bridge_token,
    open_codex_login_console,
)
from .bridge_process import IntegratedBridge, load_or_create_integrated_token
from .progress import parse_bridge_progress


APP_NAME = "이미지 한글 번역기 · ZIP"


def _natural_sort_key(value: str) -> tuple[object, ...]:
    return tuple(
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", str(value))
    )


def _should_follow_new_row(item_exists: bool, last_visible_fraction: float) -> bool:
    return not item_exists and last_visible_fraction >= 0.995


def _should_minimize_on_close(worker: threading.Thread | None) -> bool:
    return bool(worker and worker.is_alive())


def _can_request_review(
    selected_meta: list[dict[str, object]],
    *,
    worker_running: bool,
    source_exists: bool,
    destination_exists: bool,
) -> bool:
    if not source_exists or not (worker_running or destination_exists):
        return False
    return any(
        meta.get("source") == "zip"
        and meta.get("state") == "review"
        and not meta.get("review_queued")
        for meta in selected_meta
    )


class TranslatorApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(APP_NAME)
        self.root.geometry("1120x900")
        self.root.minsize(900, 740)
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.cancel_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.bridge_ready = False
        self.bridge_manager = IntegratedBridge(
            log=lambda message: self.events.put(("bridge_log", message))
        )
        self.image_rows: dict[str, str] = {}
        self.image_row_meta: dict[str, dict[str, object]] = {}
        self.thumbnail_images: dict[str, ImageTk.PhotoImage] = {}
        self.bridge_task_sources: dict[int, tuple[str, str]] = {}
        self.skipped_zip_images: set[int] = set()
        self.skip_lock = threading.Lock()
        self.parallel_lock = threading.Lock()
        self.parallel_limit = 3
        self.quality_attempt_limit = 3
        self.render_mode = "local"
        self.queued_review_images: dict[int, str] = {}
        self.preview_dir = Path(tempfile.mkdtemp(prefix="jit-result-preview-"))
        self.translated_preview_paths: dict[int, Path] = {}
        self.sort_column: str | None = None
        self.sort_reverse = False
        self.closing_after_cancel = False

        self.source_var = tk.StringVar()
        self.destination_var = tk.StringVar()
        self.bridge_url_var = tk.StringVar(value=default_bridge_url())
        self.bridge_token_var = tk.StringVar(value=load_bridge_token() or load_or_create_integrated_token())
        self.bridge_status_var = tk.StringVar(value="통합 브리지 시작 중...")
        self.parallel_var = tk.StringVar(value="3")
        self.quality_attempt_var = tk.StringVar(value="3")
        self.render_mode_var = tk.StringVar(value="로컬 정밀 렌더")
        self.status_var = tk.StringVar(value="ZIP 파일을 끌어다 놓거나 선택하세요.")
        self.progress_var = tk.DoubleVar(value=0)

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.after(100, self._poll_events)
        self.root.after(250, self._ensure_bridge)

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.root, padding=20)
        outer.pack(fill="both", expand=True)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(5, weight=1)
        outer.rowconfigure(6, weight=1)

        ttk.Label(outer, text=APP_NAME, font=("Malgun Gothic", 18, "bold")).grid(
            row=0, column=0, sticky="w", pady=(0, 6)
        )
        ttk.Label(
            outer,
            text="Chrome 확장 프로그램과 같은 고정밀 만화 번역 브리지로 ZIP 내부 이미지를 처리합니다.",
        ).grid(row=1, column=0, sticky="w", pady=(0, 16))

        drop = ttk.LabelFrame(outer, text="입력 ZIP", padding=14)
        drop.grid(row=2, column=0, sticky="ew", pady=(0, 12))
        drop.columnconfigure(0, weight=1)
        entry = ttk.Entry(drop, textvariable=self.source_var)
        entry.grid(row=0, column=0, sticky="ew", padx=(0, 8))
        ttk.Button(drop, text="찾아보기", command=self._browse_source).grid(row=0, column=1)
        drop_hint = "여기에 ZIP 파일을 끌어다 놓을 수 있습니다." if DND_FILES else "찾아보기로 ZIP 파일을 선택하세요."
        hint = ttk.Label(drop, text=drop_hint, foreground="#555555")
        hint.grid(row=1, column=0, columnspan=2, sticky="w", pady=(8, 0))
        if DND_FILES:
            for widget in (drop, entry, hint):
                widget.drop_target_register(DND_FILES)
                widget.dnd_bind("<<Drop>>", self._on_drop)

        bridge = ttk.LabelFrame(outer, text="통합 브리지 · 자동 실행", padding=14)
        bridge.grid(row=3, column=0, sticky="ew", pady=(0, 12))
        bridge.columnconfigure(1, weight=1)
        ttk.Label(bridge, text="주소").grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Entry(bridge, textvariable=self.bridge_url_var, state="readonly").grid(row=0, column=1, sticky="ew")
        ttk.Label(bridge, text="연결 토큰").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ttk.Entry(bridge, textvariable=self.bridge_token_var, show="●", state="readonly").grid(
            row=1, column=1, sticky="ew", pady=(8, 0)
        )
        bridge_buttons = ttk.Frame(bridge)
        bridge_buttons.grid(row=0, column=2, rowspan=2, sticky="e", padx=(10, 0))
        ttk.Button(bridge_buttons, text="다시 시작", command=self._restart_bridge).pack(side="left")
        ttk.Button(bridge_buttons, text="상태 확인", command=self._refresh_bridge_status).pack(
            side="left", padx=(8, 0)
        )
        ttk.Button(bridge_buttons, text="Codex 로그인", command=self._open_codex_login).pack(
            side="left", padx=(8, 0)
        )
        ttk.Button(bridge_buttons, text="연결 정보 복사", command=self._copy_bridge_info).pack(
            side="left", padx=(8, 0)
        )
        ttk.Label(bridge, textvariable=self.bridge_status_var).grid(
            row=2, column=0, columnspan=3, sticky="w", pady=(10, 0)
        )
        ttk.Label(
            bridge,
            text="별도 CMD 없이 앱이 브리지를 시작하고 종료합니다. API 키는 사용하지 않습니다.",
            foreground="#1f5f3f",
        ).grid(row=3, column=0, columnspan=3, sticky="w", pady=(6, 0))

        output = ttk.LabelFrame(outer, text="출력과 성능", padding=14)
        output.grid(row=4, column=0, sticky="ew", pady=(0, 12))
        output.columnconfigure(1, weight=1)
        ttk.Label(output, text="출력 ZIP").grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Entry(output, textvariable=self.destination_var).grid(row=0, column=1, sticky="ew")
        ttk.Button(output, text="변경", command=self._browse_destination).grid(row=0, column=2, padx=(8, 0))
        ttk.Label(output, text="병렬 이미지 수").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=(10, 0))
        self.parallel_combo = ttk.Combobox(
            output,
            textvariable=self.parallel_var,
            values=("1", "2", "3", "4", "5", "6"),
            state="readonly",
            width=5,
        )
        self.parallel_combo.grid(row=1, column=1, sticky="w", pady=(10, 0))
        self.parallel_combo.bind("<<ComboboxSelected>>", self._on_parallelism_changed)
        ttk.Label(output, text="자동 재검수 횟수").grid(row=2, column=0, sticky="w", padx=(0, 8), pady=(10, 0))
        self.quality_attempt_combo = ttk.Combobox(
            output,
            textvariable=self.quality_attempt_var,
            values=("1", "2", "3", "4", "5"),
            state="readonly",
            width=5,
        )
        self.quality_attempt_combo.grid(row=2, column=1, sticky="w", pady=(10, 0))
        self.quality_attempt_combo.bind("<<ComboboxSelected>>", self._on_quality_attempts_changed)
        ttk.Label(output, text="이미지 렌더 방식").grid(row=3, column=0, sticky="w", padx=(0, 8), pady=(10, 0))
        self.render_mode_combo = ttk.Combobox(
            output,
            textvariable=self.render_mode_var,
            values=("로컬 정밀 렌더", "Codex 전체 위임 렌더"),
            state="readonly",
            width=18,
        )
        self.render_mode_combo.grid(row=3, column=1, sticky="w", pady=(10, 0))
        self.render_mode_combo.bind("<<ComboboxSelected>>", self._on_render_mode_changed)
        ttk.Label(
            output,
            text="로컬 렌더는 빠르고 안정적입니다. 전체 위임 렌더는 Codex가 원문 제거와 식질 이미지를 직접 생성해 느리고 사용량이 큽니다.",
            foreground="#555555",
        ).grid(row=4, column=0, columnspan=3, sticky="w", pady=(8, 0))

        image_frame = ttk.LabelFrame(outer, text="이미지별 진행 상황 · ZIP + 웹", padding=8)
        image_frame.grid(row=5, column=0, sticky="nsew", pady=(0, 12))
        image_frame.columnconfigure(0, weight=1)
        image_frame.rowconfigure(1, weight=1)
        image_toolbar = ttk.Frame(image_frame)
        image_toolbar.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 7))
        self.skip_image_button = ttk.Button(
            image_toolbar,
            text="선택 이미지 스킵",
            command=self._skip_selected_images,
            state="disabled",
        )
        self.skip_image_button.pack(side="left")
        self.review_image_button = ttk.Button(
            image_toolbar,
            text="선택 이미지 추가 검수",
            command=self._review_selected_images,
            state="disabled",
        )
        self.review_image_button.pack(side="left", padx=(8, 0))
        self.preview_image_button = ttk.Button(
            image_toolbar,
            text="선택 결과 보기",
            command=self._show_selected_result,
            state="disabled",
        )
        self.preview_image_button.pack(side="left", padx=(8, 0))
        ttk.Label(
            image_toolbar,
            text="자동 3회 미통과 ZIP 이미지는 선택 후 추가 검수 · 웹 이미지는 페이지에서 우클릭",
            foreground="#555555",
        ).pack(side="left", padx=(10, 0))
        style = ttk.Style(self.root)
        style.configure("ImageProgress.Treeview", rowheight=60)
        self.image_tree = ttk.Treeview(
            image_frame,
            columns=("source", "number", "name", "stage", "detail"),
            show=("tree", "headings"),
            style="ImageProgress.Treeview",
            selectmode="extended",
            height=8,
        )
        self.image_tree.heading("#0", text="미리보기")
        self.image_tree.column("#0", width=72, minwidth=64, anchor="center", stretch=False)
        self.heading_labels = {
            "source": "출처",
            "number": "번호",
            "name": "이미지",
            "stage": "현재 단계",
            "detail": "상세",
        }
        for column, label in self.heading_labels.items():
            self.image_tree.heading(
                column,
                text=label,
                command=lambda selected=column: self._sort_image_rows(selected),
            )
        self.image_tree.column("source", width=82, minwidth=70, anchor="center", stretch=False)
        self.image_tree.column("number", width=58, minwidth=52, anchor="center", stretch=False)
        self.image_tree.column("name", width=220, minwidth=140)
        self.image_tree.column("stage", width=110, minwidth=90, anchor="center", stretch=False)
        self.image_tree.column("detail", width=430, minwidth=220)
        image_scrollbar = ttk.Scrollbar(image_frame, orient="vertical", command=self.image_tree.yview)
        image_horizontal = ttk.Scrollbar(image_frame, orient="horizontal", command=self.image_tree.xview)
        self.image_tree.configure(
            yscrollcommand=image_scrollbar.set,
            xscrollcommand=image_horizontal.set,
        )
        self.image_tree.grid(row=1, column=0, sticky="nsew")
        image_scrollbar.grid(row=1, column=1, sticky="ns")
        image_horizontal.grid(row=2, column=0, sticky="ew")
        self.image_tree.bind("<<TreeviewSelect>>", lambda _event: self._refresh_skip_button())
        self.image_tree.bind("<Double-1>", lambda _event: self._show_selected_result())
        self.image_tree.tag_configure("waiting", foreground="#666666")
        self.image_tree.tag_configure("running", foreground="#1456a0")
        self.image_tree.tag_configure("done", foreground="#18723a")
        self.image_tree.tag_configure("skipped", foreground="#996515")
        self.image_tree.tag_configure("error", foreground="#b3261e")
        self.image_tree.tag_configure("review", foreground="#7a3e9d")
        self.zip_placeholder = self._create_placeholder("#e8edf3", "#6c7a89")
        self.web_placeholder = self._create_placeholder("#e4f0fb", "#2c6fa3")

        log_frame = ttk.LabelFrame(outer, text="상세 기록", padding=8)
        log_frame.grid(row=6, column=0, sticky="nsew")
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        self.log_text = tk.Text(log_frame, height=7, wrap="word", state="disabled", font=("Consolas", 9))
        scrollbar = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=scrollbar.set)
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")

        ttk.Progressbar(outer, variable=self.progress_var, maximum=100).grid(
            row=7, column=0, sticky="ew", pady=(12, 4)
        )
        ttk.Label(outer, textvariable=self.status_var).grid(row=8, column=0, sticky="w")

        buttons = ttk.Frame(outer)
        buttons.grid(row=9, column=0, sticky="e", pady=(12, 0))
        self.open_button = ttk.Button(
            buttons, text="결과 폴더 열기", command=self._open_output_folder, state="disabled"
        )
        self.open_button.pack(side="left", padx=(0, 8))
        self.cancel_button = ttk.Button(buttons, text="취소", command=self._cancel, state="disabled")
        self.cancel_button.pack(side="left", padx=(0, 8))
        self.cancel_all_button = ttk.Button(
            buttons,
            text="전부 취소 후 종료",
            command=lambda: self._request_cancel_all_and_exit(confirm=True),
            state="disabled",
        )
        self.cancel_all_button.pack(side="left", padx=(0, 8))
        self.start_button = ttk.Button(buttons, text="ZIP 번역 시작", command=self._start)
        self.start_button.pack(side="left")
        self.start_button.configure(state="disabled")

    def _browse_source(self) -> None:
        selected = filedialog.askopenfilename(title="ZIP 파일 선택", filetypes=[("ZIP 파일", "*.zip")])
        if selected:
            self._set_source(Path(selected))

    def _browse_destination(self) -> None:
        initial = self.destination_var.get() or "translated_ko.zip"
        selected = filedialog.asksaveasfilename(
            title="출력 ZIP 저장",
            defaultextension=".zip",
            filetypes=[("ZIP 파일", "*.zip")],
            initialfile=Path(initial).name,
            initialdir=str(Path(initial).parent) if Path(initial).parent.exists() else None,
        )
        if selected:
            self.destination_var.set(selected)

    def _on_drop(self, event: tk.Event) -> None:
        paths = self.root.tk.splitlist(event.data)
        if paths:
            self._set_source(Path(paths[0]))

    def _set_source(self, path: Path) -> None:
        if path.suffix.lower() != ".zip":
            messagebox.showwarning(APP_NAME, "ZIP 파일만 사용할 수 있습니다.")
            return
        self.source_var.set(str(path))
        self.destination_var.set(str(default_output_path(path)))
        self.status_var.set("번역을 시작할 준비가 되었습니다.")

    def _client(self) -> BridgeClient:
        return BridgeClient(
            self.bridge_url_var.get().strip(),
            self.bridge_token_var.get().strip(),
            max_auto_qa_attempts=self.quality_attempt_limit,
            render_mode=(
                "codex-image" if self.render_mode_var.get() == "Codex 전체 위임 렌더" else "local"
            ),
        )

    def _start(self) -> None:
        source = Path(self.source_var.get().strip())
        destination = Path(self.destination_var.get().strip())
        if not source.is_file():
            messagebox.showerror(APP_NAME, "입력 ZIP 파일을 선택하세요.")
            return
        if not destination.name:
            messagebox.showerror(APP_NAME, "출력 ZIP 경로를 지정하세요.")
            return
        if not self.bridge_ready:
            messagebox.showwarning(APP_NAME, "통합 브리지가 준비될 때까지 잠시 기다려 주세요.")
            return
        self._set_parallel_limit(int(self.parallel_var.get()))
        self.quality_attempt_limit = max(1, min(5, int(self.quality_attempt_var.get())))
        self.render_mode = (
            "codex-image" if self.render_mode_var.get() == "Codex 전체 위임 렌더" else "local"
        )
        try:
            client = self._client()
        except Exception as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return
        self.cancel_event.clear()
        with self.skip_lock:
            self.skipped_zip_images.clear()
        self.queued_review_images.clear()
        self._reset_preview_cache()
        self.progress_var.set(0)
        self._clear_log()
        self._clear_image_progress()
        self.start_button.configure(state="disabled")
        self.quality_attempt_combo.configure(state="disabled")
        self.render_mode_combo.configure(state="disabled")
        self.cancel_button.configure(state="normal")
        self.cancel_all_button.configure(state="normal")
        self.open_button.configure(state="disabled")
        self.status_var.set("브리지 연결을 확인하고 있습니다...")
        self.worker = threading.Thread(
            target=self._worker,
            args=(source, destination, client, int(self.parallel_var.get())),
            daemon=True,
        )
        self.worker.start()

    def _worker(self, source: Path, destination: Path, client: BridgeClient, parallelism: int) -> None:
        try:
            status = client.status()
            if not status.connected:
                raise RuntimeError(f"브리지 상태가 올바르지 않습니다: {status.codex}")
            self.events.put(("log", f"브리지 연결 완료 · {status.codex}"))
            translated, failed, skipped = translate_zip(
                source,
                destination,
                client,
                progress=lambda done, total, name: self.events.put(("progress", (done, total, name))),
                log=lambda message: self.events.put(("log", message)),
                stage=lambda number, name, stage, detail, state: self.events.put(
                    ("image_stage", (number, name, stage, detail, state))
                ),
                thumbnail=lambda number, name, data: self.events.put(
                    ("thumbnail", (number, name, data))
                ),
                result_image=self._cache_result_preview,
                should_skip=self._is_zip_image_skipped,
                cancel_event=self.cancel_event,
                parallelism=parallelism,
                parallelism_provider=self._get_parallel_limit,
            )
            self.events.put(("done", (destination, translated, failed, skipped)))
        except TranslationCancelled as exc:
            self.events.put(("cancelled", str(exc)))
        except Exception as exc:
            self.events.put(("error", str(exc)))

    def _poll_events(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "log":
                    self._append_log(str(payload))
                elif kind == "bridge_log":
                    self._append_log(f"[브리지] {payload}")
                    self._apply_bridge_progress(str(payload))
                elif kind == "image_stage":
                    self._update_image_stage(*payload, source="zip", source_label="ZIP")
                elif kind == "thumbnail":
                    self._apply_thumbnail(*payload)
                elif kind == "result_preview":
                    self._apply_result_preview(*payload)
                elif kind == "progress":
                    done, total, name = payload
                    self.progress_var.set(done / total * 100 if total else 0)
                    self.status_var.set(f"{done}/{total} · {name}")
                elif kind == "done":
                    destination, translated, failed, skipped = payload
                    self.worker = None
                    if self.queued_review_images:
                        queued_count = len(self.queued_review_images)
                        self.open_button.configure(state="normal")
                        self.status_var.set(
                            f"1차 ZIP 저장 완료 · 예약된 이미지 {queued_count}개 추가 검수 시작"
                        )
                        self._launch_queued_reviews()
                        continue
                    self._finish_controls()
                    self.progress_var.set(100)
                    self.open_button.configure(state="normal")
                    self.status_var.set(
                        f"완료 · 번역 {translated}개 · 스킵 {skipped}개 · 실패/원본 유지 {failed}개"
                    )
                    messagebox.showinfo(APP_NAME, f"번역 ZIP을 만들었습니다.\n\n{destination}")
                elif kind == "review_result":
                    image_number, name, result = payload
                    if result.quality_review_required:
                        self._update_image_stage(
                            image_number, name, "사용자 검수 필요",
                            f"추가 검수 {result.quality_attempts}회 미통과 · 결과 ZIP 갱신 완료",
                            "review", source="zip", source_label="ZIP",
                        )
                    else:
                        self._update_image_stage(
                            image_number, name, "검수 통과",
                            f"사용자 추가 검수 통과 · 문구 {result.region_count}개 · 결과 ZIP 갱신 완료",
                            "done", source="zip", source_label="ZIP",
                        )
                elif kind == "review_done":
                    count = int(payload)
                    self.worker = None
                    if self.queued_review_images:
                        self.status_var.set(
                            f"추가 검수 {count}개 완료 · 새로 예약된 이미지 추가 검수 시작"
                        )
                        self._launch_queued_reviews()
                        continue
                    self._finish_controls()
                    self.open_button.configure(state="normal")
                    self.status_var.set(f"선택 이미지 {count}개 추가 검수 완료 · 결과 ZIP 갱신됨")
                elif kind == "review_error":
                    self.worker = None
                    self._finish_controls()
                    self.status_var.set("추가 검수에 실패했습니다.")
                    messagebox.showerror(APP_NAME, str(payload))
                elif kind == "cancelled":
                    self.worker = None
                    self._finish_controls()
                    self.status_var.set(str(payload))
                elif kind == "error":
                    self.worker = None
                    self._finish_controls()
                    self.status_var.set("작업에 실패했습니다.")
                    messagebox.showerror(APP_NAME, str(payload))
                elif kind == "bridge_status":
                    ok, detail = payload
                    self.bridge_status_var.set(f"● 연결됨 · {detail}" if ok else f"○ 연결 필요 · {detail}")
                    self.bridge_ready = bool(ok)
                    if not self.worker or not self.worker.is_alive():
                        self.start_button.configure(state="normal" if ok else "disabled")
                elif kind == "bridge_ready":
                    runtime = payload
                    self.bridge_url_var.set(runtime.url)
                    self.bridge_token_var.set(runtime.token)
                    self.bridge_ready = True
                    ownership = "앱에 내장됨" if runtime.owned else "기존 브리지 재사용"
                    self.bridge_status_var.set(f"● 연결됨 · {runtime.codex} · {ownership}")
                    self.start_button.configure(state="normal")
                elif kind == "bridge_error":
                    self.bridge_ready = False
                    self.bridge_status_var.set(f"○ 통합 브리지 시작 실패 · {payload}")
                    self.start_button.configure(state="disabled")
                elif kind == "force_close":
                    self._cleanup_preview_cache()
                    self.root.destroy()
                    return
        except queue.Empty:
            pass
        self.root.after(100, self._poll_events)

    def _finish_controls(self) -> None:
        self.start_button.configure(state="normal" if self.bridge_ready else "disabled")
        self.quality_attempt_combo.configure(state="readonly")
        self.render_mode_combo.configure(state="readonly")
        self.cancel_button.configure(state="disabled")
        self.cancel_all_button.configure(state="disabled")
        self._refresh_skip_button()

    def _set_parallel_limit(self, value: int) -> int:
        normalized = max(1, min(6, int(value)))
        with self.parallel_lock:
            self.parallel_limit = normalized
        return normalized

    def _get_parallel_limit(self) -> int:
        with self.parallel_lock:
            return self.parallel_limit

    def _on_parallelism_changed(self, _event: tk.Event | None = None) -> None:
        previous = self._get_parallel_limit()
        current = self._set_parallel_limit(int(self.parallel_var.get()))
        if self.worker and self.worker.is_alive() and current != previous:
            direction = "확대" if current > previous else "축소"
            message = f"병렬 이미지 수 {previous} → {current} · 실행 제한 {direction} 적용"
            self.status_var.set(message)
            self._append_log(message)

    def _on_quality_attempts_changed(self, _event: tk.Event | None = None) -> None:
        self.quality_attempt_limit = max(1, min(5, int(self.quality_attempt_var.get())))
        self.status_var.set(f"자동 재검수 한도를 이미지당 {self.quality_attempt_limit}회로 설정했습니다.")

    def _on_render_mode_changed(self, _event: tk.Event | None = None) -> None:
        self.render_mode = (
            "codex-image" if self.render_mode_var.get() == "Codex 전체 위임 렌더" else "local"
        )
        self.status_var.set(f"이미지 렌더 방식을 '{self.render_mode_var.get()}'로 설정했습니다.")

    def _cancel(self) -> None:
        self.cancel_event.set()
        self.cancel_button.configure(state="disabled")
        self.status_var.set("현재 실행 중인 이미지 요청이 끝나면 취소합니다...")

    def _request_cancel_all_and_exit(self, *, confirm: bool) -> None:
        if self.closing_after_cancel:
            return
        if confirm and not messagebox.askyesno(
            APP_NAME,
            "진행 중인 ZIP 작업과 모든 이미지별 Codex 작업을 즉시 취소하고 종료할까요?\n\n"
            "완료되지 않은 출력 ZIP은 저장되지 않습니다.",
        ):
            return
        self.closing_after_cancel = True
        self.cancel_event.set()
        self.start_button.configure(state="disabled")
        self.cancel_button.configure(state="disabled")
        self.cancel_all_button.configure(state="disabled")
        self.review_image_button.configure(state="disabled")
        self.status_var.set("모든 이미지 작업을 취소하고 종료하는 중입니다...")
        self._append_log("전체 취소 후 종료 요청 · 실행 중인 브리지/Codex 작업 중단")
        threading.Thread(
            target=self._cancel_all_and_close_worker,
            daemon=True,
            name="cancel-all-and-close",
        ).start()

    def _cancel_all_and_close_worker(self) -> None:
        active_worker = self.worker
        try:
            cancelled = self._client().cancel_all_requests()
            self.events.put(("log", f"실행 중인 브리지 작업 {cancelled}개에 전체 취소 전달"))
        except Exception as exc:
            self.events.put(("log", f"전체 취소 전달 중 브리지 연결 종료 · {exc}"))
        finally:
            self.bridge_manager.stop()
            if active_worker and active_worker is not threading.current_thread():
                active_worker.join(timeout=12)
            self.events.put(("force_close", None))

    def _skip_selected_images(self) -> None:
        selected = self.image_tree.selection()
        if not selected:
            self.status_var.set("스킵할 이미지 행을 먼저 선택하세요.")
            return
        task_requests: list[tuple[int, int]] = []
        requested = 0
        for item_id in selected:
            meta = self.image_row_meta.get(item_id)
            if not meta or meta.get("state") in {"done", "error", "skipped"}:
                continue
            image_number = int(meta["image_number"])
            if meta.get("source") == "zip":
                with self.skip_lock:
                    self.skipped_zip_images.add(image_number)
            task_number = meta.get("task_number")
            if isinstance(task_number, int) and task_number > 0:
                task_requests.append((task_number, image_number))
            meta["skip_requested"] = True
            meta["state"] = "skipped"
            values = list(self.image_tree.item(item_id, "values"))
            values[3] = "스킵 요청"
            values[4] = "현재 작업 중단 또는 대기 작업 생략 요청됨"
            self.image_tree.item(item_id, values=values, tags=("skipped",))
            requested += 1
        if task_requests:
            threading.Thread(
                target=self._cancel_bridge_tasks,
                args=(task_requests,),
                daemon=True,
                name="skip-image-requests",
            ).start()
        self.status_var.set(f"선택 이미지 {requested}개의 스킵을 요청했습니다.")
        self._refresh_skip_button()

    def _cancel_bridge_tasks(self, requests: list[tuple[int, int]]) -> None:
        try:
            client = self._client()
        except Exception as exc:
            self.events.put(("log", f"이미지 스킵 연결 실패 · {exc}"))
            return
        for task_number, image_number in requests:
            try:
                cancelled = client.skip_request(task_number, image_number)
                detail = "실행 중 작업 중단" if cancelled else "이미 완료된 작업"
                self.events.put(("log", f"[이미지 #{image_number}] 스킵 요청 · {detail}"))
            except Exception as exc:
                self.events.put(("log", f"[이미지 #{image_number}] 스킵 요청 전달 실패 · {exc}"))

    def _is_zip_image_skipped(self, image_number: int) -> bool:
        with self.skip_lock:
            return image_number in self.skipped_zip_images

    def _refresh_skip_button(self) -> None:
        worker_running = bool(self.worker and self.worker.is_alive())
        can_skip = any(
            self.image_row_meta.get(item_id, {}).get("state") not in {"done", "error", "skipped"}
            for item_id in self.image_tree.selection()
        ) and worker_running
        self.skip_image_button.configure(state="normal" if can_skip else "disabled")
        can_review = _can_request_review(
            [self.image_row_meta.get(item_id, {}) for item_id in self.image_tree.selection()],
            worker_running=worker_running,
            source_exists=Path(self.source_var.get().strip()).is_file(),
            destination_exists=Path(self.destination_var.get().strip()).is_file(),
        )
        self.review_image_button.configure(state="normal" if can_review else "disabled")
        can_preview = any(
            Path(str(self.image_row_meta.get(item_id, {}).get("preview_path", ""))).is_file()
            for item_id in self.image_tree.selection()
        )
        self.preview_image_button.configure(state="normal" if can_preview else "disabled")

    def _review_selected_images(self) -> None:
        selected: list[tuple[int, str]] = []
        for item_id in self.image_tree.selection():
            meta = self.image_row_meta.get(item_id, {})
            if meta.get("source") != "zip" or meta.get("state") != "review":
                continue
            values = self.image_tree.item(item_id, "values")
            image_number = int(meta["image_number"])
            name = str(values[2])
            if meta.get("review_queued"):
                continue
            selected.append((image_number, name))
        if not selected:
            self.status_var.set("사용자 검수가 필요한 ZIP 이미지 행을 선택하세요.")
            return
        if self.worker and self.worker.is_alive():
            for image_number, name in selected:
                self.queued_review_images[image_number] = name
                item_id = self.image_rows.get(f"zip:{image_number}")
                if item_id:
                    self.image_row_meta[item_id]["review_queued"] = True
                self._update_image_stage(
                    image_number, name, "추가 검수 예약",
                    "현재 ZIP 작업 완료 후 사용자 추가 검수를 자동 실행합니다.", "review",
                    source="zip", source_label="ZIP",
                )
                if item_id:
                    self.image_row_meta[item_id]["review_queued"] = True
            self.status_var.set(f"선택 이미지 {len(selected)}개를 추가 검수 예약했습니다.")
            self._refresh_skip_button()
            return
        self._launch_manual_reviews(selected)

    def _launch_queued_reviews(self) -> None:
        selected = sorted(self.queued_review_images.items())
        self.queued_review_images.clear()
        for image_number, _name in selected:
            item_id = self.image_rows.get(f"zip:{image_number}")
            if item_id:
                self.image_row_meta[item_id]["review_queued"] = False
        self._launch_manual_reviews(selected)

    def _launch_manual_reviews(self, selected: list[tuple[int, str]]) -> None:
        for image_number, name in selected:
            self._update_image_stage(
                image_number, name, "추가 검수 요청",
                "사용자가 확인 후 1회 재합성·재검수를 요청함", "running",
                source="zip", source_label="ZIP",
            )
        source = Path(self.source_var.get().strip())
        destination = Path(self.destination_var.get().strip())
        self.start_button.configure(state="disabled")
        self.cancel_button.configure(state="disabled")
        self.cancel_all_button.configure(state="normal")
        self.review_image_button.configure(state="disabled")
        self.status_var.set(f"선택 이미지 {len(selected)}개를 추가 검수하고 있습니다...")
        self.worker = threading.Thread(
            target=self._review_worker,
            args=(source, destination, selected),
            daemon=True,
            name="manual-quality-review",
        )
        self.worker.start()

    def _review_worker(
        self,
        source: Path,
        destination: Path,
        selected: list[tuple[int, str]],
    ) -> None:
        try:
            client = self._client()
            for image_number, name in selected:
                result = review_zip_image(source, destination, client, image_number)
                if result.changed:
                    self._cache_result_preview(image_number, name, result.data)
                self.events.put(("review_result", (image_number, name, result)))
            self.events.put(("review_done", len(selected)))
        except Exception as exc:
            self.events.put(("review_error", str(exc)))

    def _apply_thumbnail(self, image_number: int, name: str, data: bytes) -> None:
        row_key = f"zip:{image_number}"
        item_id = self.image_rows.get(row_key)
        if not item_id:
            self._update_image_stage(
                image_number,
                name,
                "대기",
                "번역 요청 대기",
                "waiting",
                source="zip",
                source_label="ZIP",
            )
            item_id = self.image_rows.get(row_key)
        if not item_id:
            return
        try:
            with Image.open(io.BytesIO(data)) as opened:
                photo = ImageTk.PhotoImage(opened.convert("RGBA"), master=self.root)
        except (UnidentifiedImageError, OSError, ValueError, tk.TclError):
            return
        self.thumbnail_images[row_key] = photo
        self.image_tree.item(item_id, image=photo)

    def _reset_preview_cache(self) -> None:
        shutil.rmtree(self.preview_dir, ignore_errors=True)
        self.preview_dir.mkdir(parents=True, exist_ok=True)
        self.translated_preview_paths.clear()

    def _cleanup_preview_cache(self) -> None:
        shutil.rmtree(self.preview_dir, ignore_errors=True)
        self.translated_preview_paths.clear()

    def _cache_result_preview(self, image_number: int, name: str, data: bytes) -> None:
        suffix = Path(name).suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
            suffix = ".png"
        preview_path = self.preview_dir / f"{image_number:06d}{suffix}"
        preview_path.write_bytes(data)
        self.events.put(("result_preview", (image_number, name, str(preview_path))))

    def _apply_result_preview(self, image_number: int, name: str, preview_path: str) -> None:
        path = Path(preview_path)
        if not path.is_file():
            return
        self.translated_preview_paths[image_number] = path
        row_key = f"zip:{image_number}"
        item_id = self.image_rows.get(row_key)
        if not item_id:
            return
        self.image_row_meta[item_id]["preview_path"] = str(path)
        try:
            with Image.open(path) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGBA")
                image.thumbnail((56, 56), Image.Resampling.LANCZOS)
                canvas = Image.new("RGBA", (56, 56), (236, 248, 239, 255))
                canvas.alpha_composite(image, ((56 - image.width) // 2, (56 - image.height) // 2))
                photo = ImageTk.PhotoImage(canvas, master=self.root)
        except (UnidentifiedImageError, OSError, ValueError, tk.TclError):
            return
        self.thumbnail_images[row_key] = photo
        self.image_tree.item(item_id, image=photo)
        self._refresh_skip_button()

    def _show_selected_result(self) -> None:
        selected = self.image_tree.selection()
        preview_item = next(
            (
                item_id for item_id in selected
                if Path(str(self.image_row_meta.get(item_id, {}).get("preview_path", ""))).is_file()
            ),
            None,
        )
        if not preview_item:
            self.status_var.set("먼저 번역 결과가 준비된 이미지 행을 선택하세요.")
            return
        meta = self.image_row_meta[preview_item]
        path = Path(str(meta["preview_path"]))
        name = str(self.image_tree.set(preview_item, "name"))
        self._open_result_preview(path, name)

    def _open_result_preview(self, path: Path, name: str) -> None:
        try:
            with Image.open(path) as opened:
                source = ImageOps.exif_transpose(opened).convert("RGBA")
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            messagebox.showerror(APP_NAME, f"번역 결과 이미지를 열지 못했습니다.\n\n{exc}")
            return

        window = tk.Toplevel(self.root)
        window.title(f"번역 결과 검수 · {name}")
        window.geometry("1100x820")
        window.minsize(640, 480)
        toolbar = ttk.Frame(window, padding=(8, 6))
        toolbar.pack(fill="x")
        zoom_label = ttk.Label(toolbar, text="")
        zoom_label.pack(side="left", padx=(0, 10))
        canvas_frame = ttk.Frame(window)
        canvas_frame.pack(fill="both", expand=True)
        canvas_frame.rowconfigure(0, weight=1)
        canvas_frame.columnconfigure(0, weight=1)
        canvas = tk.Canvas(canvas_frame, background="#202124", highlightthickness=0)
        vertical = ttk.Scrollbar(canvas_frame, orient="vertical", command=canvas.yview)
        horizontal = ttk.Scrollbar(canvas_frame, orient="horizontal", command=canvas.xview)
        canvas.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        canvas.grid(row=0, column=0, sticky="nsew")
        vertical.grid(row=0, column=1, sticky="ns")
        horizontal.grid(row=1, column=0, sticky="ew")
        state = {"scale": 1.0, "photo": None}

        def render() -> None:
            scale = max(0.05, min(2.0, float(state["scale"])))
            pixel_limit_scale = (24_000_000 / max(1, source.width * source.height)) ** 0.5
            scale = min(scale, max(0.05, pixel_limit_scale))
            state["scale"] = scale
            width = max(1, round(source.width * scale))
            height = max(1, round(source.height * scale))
            displayed = source if (width, height) == source.size else source.resize(
                (width, height), Image.Resampling.LANCZOS
            )
            photo = ImageTk.PhotoImage(displayed, master=window)
            state["photo"] = photo
            canvas.delete("all")
            canvas.create_image(0, 0, image=photo, anchor="nw")
            canvas.configure(scrollregion=(0, 0, width, height))
            zoom_label.configure(text=f"{round(scale * 100)}% · {source.width}×{source.height}")

        def fit() -> None:
            window.update_idletasks()
            available_width = max(100, canvas.winfo_width() - 16)
            available_height = max(100, canvas.winfo_height() - 16)
            state["scale"] = min(1.0, available_width / source.width, available_height / source.height)
            render()

        def zoom(factor: float) -> None:
            state["scale"] = float(state["scale"]) * factor
            render()

        ttk.Button(toolbar, text="－", width=4, command=lambda: zoom(0.8)).pack(side="left")
        ttk.Button(toolbar, text="＋", width=4, command=lambda: zoom(1.25)).pack(side="left", padx=(5, 0))
        ttk.Button(toolbar, text="창 맞춤", command=fit).pack(side="left", padx=(8, 0))
        ttk.Label(toolbar, text="스크롤바로 이동 · 최대 200%", foreground="#555555").pack(side="left", padx=(12, 0))
        window.after(50, fit)

    def _sort_image_rows(self, column: str, *, toggle: bool = True) -> None:
        if toggle:
            if self.sort_column == column:
                self.sort_reverse = not self.sort_reverse
            else:
                self.sort_column = column
                self.sort_reverse = False
        rows = list(self.image_tree.get_children(""))

        def sort_key(item_id: str) -> tuple[object, ...]:
            value = str(self.image_tree.set(item_id, column))
            if column == "number":
                try:
                    return (int(value.lstrip("#")),)
                except ValueError:
                    return (10**9,)
            return _natural_sort_key(value)

        rows.sort(key=sort_key, reverse=self.sort_reverse)
        for position, item_id in enumerate(rows):
            self.image_tree.move(item_id, "", position)
        for name, label in self.heading_labels.items():
            indicator = ""
            if name == self.sort_column:
                indicator = " ▼" if self.sort_reverse else " ▲"
            self.image_tree.heading(
                name,
                text=f"{label}{indicator}",
                command=lambda selected=name: self._sort_image_rows(selected),
            )

    def _create_placeholder(self, background: str, foreground: str) -> tk.PhotoImage:
        image = tk.PhotoImage(master=self.root, width=56, height=56)
        image.put(background, to=(0, 0, 56, 56))
        image.put(foreground, to=(12, 14, 44, 42))
        image.put(background, to=(15, 17, 41, 39))
        image.put(foreground, to=(18, 30, 27, 37))
        image.put(foreground, to=(29, 23, 39, 37))
        return image

    def _open_output_folder(self) -> None:
        path = Path(self.destination_var.get()).parent
        if path.exists() and os.name == "nt":
            os.startfile(path)

    def _refresh_bridge_status(self) -> None:
        self.bridge_status_var.set("브리지 상태 확인 중...")

        def check() -> None:
            try:
                status = self._client().status()
                self.events.put(("bridge_status", (status.connected, status.codex)))
            except Exception as exc:
                self.events.put(("bridge_status", (False, str(exc))))

        threading.Thread(target=check, daemon=True).start()

    def _ensure_bridge(self) -> None:
        self.bridge_ready = False
        self.start_button.configure(state="disabled")
        self.bridge_status_var.set("통합 브리지 시작 중...")

        def start() -> None:
            try:
                runtime = self.bridge_manager.ensure_running(
                    self.bridge_url_var.get().strip(),
                    self.bridge_token_var.get().strip(),
                )
                self.events.put(("bridge_ready", runtime))
            except Exception as exc:
                self.events.put(("bridge_error", str(exc)))

        threading.Thread(target=start, daemon=True, name="integrated-bridge-start").start()

    def _restart_bridge(self) -> None:
        self.bridge_ready = False
        self.start_button.configure(state="disabled")
        self.bridge_status_var.set("통합 브리지 다시 시작 중...")

        def restart() -> None:
            try:
                runtime = self.bridge_manager.restart(
                    self.bridge_url_var.get().strip(),
                    self.bridge_token_var.get().strip(),
                )
                self.events.put(("bridge_ready", runtime))
            except Exception as exc:
                self.events.put(("bridge_error", str(exc)))

        threading.Thread(target=restart, daemon=True, name="integrated-bridge-restart").start()

    def _open_codex_login(self) -> None:
        try:
            open_codex_login_console()
            self.bridge_status_var.set("로그인 완료 후 상태 확인을 누르세요.")
        except Exception as exc:
            messagebox.showerror(APP_NAME, str(exc))

    def _copy_bridge_info(self) -> None:
        value = f"주소: {self.bridge_url_var.get()}\n토큰: {self.bridge_token_var.get()}"
        self.root.clipboard_clear()
        self.root.clipboard_append(value)
        self.bridge_status_var.set("연결 정보를 클립보드에 복사했습니다.")

    def _append_log(self, message: str) -> None:
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{timestamp}] {message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _clear_log(self) -> None:
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    def _clear_image_progress(self) -> None:
        for item in self.image_tree.get_children():
            self.image_tree.delete(item)
        self.image_rows.clear()
        self.image_row_meta.clear()
        self.thumbnail_images.clear()
        self.bridge_task_sources.clear()
        self.sort_column = None
        self.sort_reverse = False
        for column, label in self.heading_labels.items():
            self.image_tree.heading(
                column,
                text=label,
                command=lambda selected=column: self._sort_image_rows(selected),
            )
        self._refresh_skip_button()

    def _update_image_stage(
        self,
        image_number: int,
        name: str,
        stage: str,
        detail: str,
        state: str,
        *,
        source: str,
        source_label: str,
        task_number: int | None = None,
    ) -> None:
        row_key = f"zip:{image_number}" if source == "zip" else f"web:{task_number or image_number}"
        item_id = self.image_rows.get(row_key)
        try:
            _first_visible, last_visible = self.image_tree.yview()
        except tk.TclError:
            last_visible = 1.0
        follow_new_row = _should_follow_new_row(bool(item_id), last_visible)
        display_name = name
        if item_id and not display_name:
            display_name = str(self.image_tree.set(item_id, "name"))
        meta = self.image_row_meta.get(item_id or "", {})
        if task_number:
            meta["task_number"] = task_number
        meta.update({
            "row_key": row_key,
            "source": source,
            "image_number": image_number,
            "state": state,
        })
        if meta.get("skip_requested") and state not in {"done", "error", "skipped"}:
            stage = "스킵 요청"
            detail = "현재 작업 중단 또는 대기 작업 생략 요청됨"
            state = "skipped"
            meta["state"] = state
        values = (source_label, f"#{image_number}", display_name, stage, detail)
        if item_id:
            self.image_tree.item(item_id, values=values, tags=(state,))
        else:
            placeholder = self.zip_placeholder if source == "zip" else self.web_placeholder
            item_id = self.image_tree.insert(
                "",
                "end",
                image=placeholder,
                values=values,
                tags=(state,),
            )
            self.image_rows[row_key] = item_id
        self.image_row_meta[item_id] = meta
        if self.sort_column:
            self._sort_image_rows(self.sort_column, toggle=False)
        if follow_new_row:
            self.image_tree.see(item_id)
        self._refresh_skip_button()

    def _apply_bridge_progress(self, line: str) -> None:
        progress = parse_bridge_progress(line)
        if not progress:
            return
        if progress.source:
            self.bridge_task_sources[progress.task_number] = (
                progress.source,
                progress.source_label,
            )
        task_source = self.bridge_task_sources.get(progress.task_number)
        if not task_source:
            return
        source, source_label = task_source
        name = ""
        if source == "web":
            name = self._web_source_name(progress.detail, progress.image_number)
        self._update_image_stage(
            progress.image_number,
            name,
            progress.stage,
            progress.detail,
            progress.state,
            source=source,
            source_label=source_label,
            task_number=progress.task_number,
        )

    @staticmethod
    def _web_source_name(detail: str, image_number: int) -> str:
        match = re.search(r"<[a-zA-Z0-9_-]+> · ([^?]+)$", detail)
        return match.group(1) if match else f"웹 이미지 #{image_number}"

    def _on_close(self) -> None:
        if _should_minimize_on_close(self.worker):
            decision = messagebox.askyesnocancel(
                APP_NAME,
                "번역 작업이 실행 중입니다.\n\n"
                "예: 모든 작업을 즉시 취소하고 종료\n"
                "아니요: 창만 최소화하고 계속 실행\n"
                "취소: 현재 창으로 돌아가기",
            )
            if decision is True:
                self._request_cancel_all_and_exit(confirm=False)
            elif decision is False:
                self.status_var.set("작업이 계속 실행 중입니다. 창을 최소화했습니다.")
                self._append_log("작업 중 닫기 요청 · 창만 최소화하고 번역은 계속 실행")
                self.root.iconify()
            return
        self.bridge_manager.stop()
        self._cleanup_preview_cache()
        self.root.destroy()


def run() -> None:
    root = TkinterDnD.Tk() if TkinterDnD else tk.Tk()
    TranslatorApp(root)
    root.mainloop()
