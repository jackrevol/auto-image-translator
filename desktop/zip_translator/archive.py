from __future__ import annotations

import os
import io
import threading
import time
import zipfile
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from PIL import Image, ImageOps, UnidentifiedImageError

from .bridge_client import ImageTranslation


SUPPORTED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


class ImageTranslator(Protocol):
    def translate_image(
        self,
        raw: bytes,
        suffix: str,
        name: str,
        image_number: int,
    ) -> ImageTranslation: ...


ProgressCallback = Callable[[int, int, str], None]
LogCallback = Callable[[str], None]
StageCallback = Callable[[int, str, str, str, str], None]
ThumbnailCallback = Callable[[int, str, bytes], None]
ResultImageCallback = Callable[[int, str, bytes], None]
SkipPredicate = Callable[[int], bool]
ParallelismProvider = Callable[[], int]


class TranslationCancelled(Exception):
    pass


class _DynamicConcurrencyGate:
    def __init__(
        self,
        provider: ParallelismProvider,
        cancel_event: threading.Event | None = None,
    ) -> None:
        self.provider = provider
        self.cancel_event = cancel_event
        self.active = 0
        self.condition = threading.Condition()

    def acquire(self) -> None:
        with self.condition:
            while self.active >= self._limit():
                if self.cancel_event and self.cancel_event.is_set():
                    raise TranslationCancelled("사용자가 작업을 취소했습니다.")
                self.condition.wait(timeout=0.2)
            if self.cancel_event and self.cancel_event.is_set():
                raise TranslationCancelled("사용자가 작업을 취소했습니다.")
            self.active += 1

    def release(self) -> None:
        with self.condition:
            self.active = max(0, self.active - 1)
            self.condition.notify_all()

    def _limit(self) -> int:
        try:
            value = int(self.provider())
        except (TypeError, ValueError):
            value = 1
        return max(1, min(6, value))


@dataclass(frozen=True)
class _ImageInput:
    entry_index: int
    image_number: int
    name: str
    raw: bytes
    suffix: str


@dataclass(frozen=True)
class _ImageResult:
    entry_index: int
    image_number: int
    name: str
    data: bytes
    translated: bool
    failed: bool
    skipped: bool
    review_required: bool
    message: str


def default_output_path(source: Path) -> Path:
    return source.with_name(f"{source.stem}_ko.zip")


def translate_zip(
    source: Path,
    destination: Path,
    translator: ImageTranslator,
    progress: ProgressCallback | None = None,
    log: LogCallback | None = None,
    stage: StageCallback | None = None,
    thumbnail: ThumbnailCallback | None = None,
    result_image: ResultImageCallback | None = None,
    should_skip: SkipPredicate | None = None,
    cancel_event: threading.Event | None = None,
    parallelism: int = 3,
    parallelism_provider: ParallelismProvider | None = None,
) -> tuple[int, int, int]:
    if source.resolve() == destination.resolve():
        raise ValueError("입력 ZIP과 출력 ZIP 경로가 같을 수 없습니다.")
    if not zipfile.is_zipfile(source):
        raise ValueError("유효한 ZIP 파일이 아닙니다.")
    parallelism = max(1, min(6, int(parallelism)))
    concurrency_gate = _DynamicConcurrencyGate(
        parallelism_provider or (lambda: parallelism),
        cancel_event,
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.partial")
    translated_count = 0
    failed_count = 0
    skipped_count = 0

    try:
        with zipfile.ZipFile(source, "r") as archive:
            entries = archive.infolist()
            image_positions = [
                (entry_index, entry)
                for entry_index, entry in enumerate(entries)
                if not entry.is_dir() and Path(entry.filename).suffix.lower() in SUPPORTED_IMAGE_SUFFIXES
            ]
            if not image_positions:
                raise ValueError("ZIP 안에 지원되는 이미지가 없습니다. (PNG, JPG, JPEG, WEBP, BMP)")

            total_images = len(image_positions)
            image_number_by_entry = {
                entry_index: image_number
                for image_number, (entry_index, _) in enumerate(image_positions, start=1)
            }
            image_entry_indexes = set(image_number_by_entry)
            if stage:
                for entry_index, entry in image_positions:
                    stage(image_number_by_entry[entry_index], entry.filename, "대기", "번역 요청 대기", "waiting")
            if thumbnail:
                for entry_index, entry in image_positions:
                    try:
                        thumbnail(
                            image_number_by_entry[entry_index],
                            entry.filename,
                            _make_thumbnail(archive.read(entry)),
                        )
                    except Exception:
                        # 미리보기 실패는 실제 번역과 ZIP 보존에 영향을 주지 않습니다.
                        pass
            ready: dict[int, _ImageResult] = {}
            next_entry_index = 0
            completed_images = 0

            with zipfile.ZipFile(temporary, "w") as output:
                output.comment = archive.comment
                if log:
                    log(f"이미지 {total_images}개 · 초기 병렬 실행 {parallelism}개 · 실행 중 1~6개 변경 가능")

                def flush_ready() -> None:
                    nonlocal next_entry_index, completed_images
                    while next_entry_index < len(entries):
                        entry = entries[next_entry_index]
                        if next_entry_index in image_entry_indexes:
                            result = ready.get(next_entry_index)
                            if result is None:
                                break
                            if stage:
                                stage(result.image_number, result.name, "ZIP 저장", "원본 위치에 결과 기록", "running")
                            output.writestr(entry, result.data)
                            ready.pop(next_entry_index)
                            completed_images += 1
                            if log:
                                log(f"[이미지 #{result.image_number}/{total_images}] {result.name}")
                                log(f"  {result.message}")
                            if progress:
                                progress(completed_images, total_images, result.name)
                            if stage:
                                if result.skipped:
                                    stage(result.image_number, result.name, "스킵 완료", result.message, "skipped")
                                elif result.failed:
                                    stage(result.image_number, result.name, "오류", result.message, "error")
                                elif result.review_required:
                                    stage(result.image_number, result.name, "사용자 검수 필요", result.message, "review")
                                elif result.translated:
                                    stage(result.image_number, result.name, "완료", result.message, "done")
                                else:
                                    stage(result.image_number, result.name, "원본 유지", result.message, "skipped")
                        else:
                            raw = archive.read(entry) if not entry.is_dir() else b""
                            output.writestr(entry, raw)
                        next_entry_index += 1

                pending: deque[Future[_ImageResult]] = deque()

                def receive_oldest() -> None:
                    nonlocal translated_count, failed_count, skipped_count
                    result = pending.popleft().result()
                    ready[result.entry_index] = result
                    if result_image and result.translated:
                        try:
                            result_image(result.image_number, result.name, result.data)
                        except Exception:
                            # 결과 미리보기 저장 실패는 ZIP 생성 자체에 영향을 주지 않습니다.
                            pass
                    translated_count += int(result.translated)
                    failed_count += int(result.failed)
                    skipped_count += int(result.skipped)
                    flush_ready()

                with ThreadPoolExecutor(
                    max_workers=6,
                    thread_name_prefix="zip-bridge-image",
                ) as executor:
                    for entry_index, entry in image_positions:
                        if cancel_event and cancel_event.is_set():
                            raise TranslationCancelled("사용자가 작업을 취소했습니다.")
                        image_number = image_number_by_entry[entry_index]
                        item = _ImageInput(
                            entry_index=entry_index,
                            image_number=image_number,
                            name=entry.filename,
                            raw=archive.read(entry),
                            suffix=Path(entry.filename).suffix.lower(),
                        )
                        if should_skip and should_skip(image_number):
                            ready[entry_index] = _skipped_result(item)
                            skipped_count += 1
                            if stage:
                                stage(image_number, entry.filename, "스킵 대기", "사용자 요청 · 번역 생략", "skipped")
                            flush_ready()
                            continue
                        if log:
                            log(f"[이미지 #{image_number}/{total_images}] 브리지 요청 대기 · {entry.filename}")
                        if stage:
                            stage(image_number, entry.filename, "브리지 요청", "병렬 처리 슬롯 요청", "running")
                        pending.append(executor.submit(
                            _process_image,
                            item,
                            translator,
                            should_skip,
                            concurrency_gate,
                        ))
                        if len(pending) >= 6:
                            receive_oldest()

                    while pending:
                        receive_oldest()
                        if cancel_event and cancel_event.is_set():
                            raise TranslationCancelled("사용자가 작업을 취소했습니다.")
                flush_ready()

        _replace_with_retry(temporary, destination)
        return translated_count, failed_count, skipped_count
    except Exception:
        _unlink_with_retry(temporary)
        raise


def _process_image(
    item: _ImageInput,
    translator: ImageTranslator,
    should_skip: SkipPredicate | None = None,
    concurrency_gate: _DynamicConcurrencyGate | None = None,
) -> _ImageResult:
    if should_skip and should_skip(item.image_number):
        return _skipped_result(item)
    acquired = False
    try:
        if concurrency_gate:
            concurrency_gate.acquire()
            acquired = True
        if should_skip and should_skip(item.image_number):
            return _skipped_result(item)
        result = translator.translate_image(item.raw, item.suffix, item.name, item.image_number)
        if should_skip and should_skip(item.image_number):
            return _skipped_result(item)
        if result.changed:
            review = (
                f" · 자동 검수 {result.quality_attempts}회 미통과 · 선택 후 추가 검수 가능"
                if result.quality_review_required else " · 품질검수 통과"
            )
            message = f"번역 문구 {result.region_count}개 적용 · 원본 확장자 유지{review}"
        else:
            message = "번역할 일본어 없음 · 원본 유지"
        return _ImageResult(
            item.entry_index,
            item.image_number,
            item.name,
            result.data,
            result.changed,
            False,
            False,
            result.quality_review_required,
            message,
        )
    except TranslationCancelled:
        raise
    except Exception as exc:
        if should_skip and should_skip(item.image_number):
            return _skipped_result(item)
        return _ImageResult(
            item.entry_index,
            item.image_number,
            item.name,
            item.raw,
            False,
            True,
            False,
            False,
            f"처리 실패로 원본 유지: {exc}",
        )
    finally:
        if acquired and concurrency_gate:
            concurrency_gate.release()


def _skipped_result(item: _ImageInput) -> _ImageResult:
    return _ImageResult(
        item.entry_index,
        item.image_number,
        item.name,
        item.raw,
        False,
        False,
        True,
        False,
        "사용자 스킵 · 원본 유지",
    )


def review_zip_image(
    source: Path,
    destination: Path,
    translator: object,
    image_number: int,
) -> ImageTranslation:
    """원본 ZIP의 한 이미지만 다시 검수하고 기존 결과 ZIP의 같은 항목을 교체합니다."""
    if not destination.is_file() or not zipfile.is_zipfile(destination):
        raise ValueError("먼저 번역된 출력 ZIP을 만들어 주세요.")
    with zipfile.ZipFile(source, "r") as original_archive:
        original_images = [
            entry for entry in original_archive.infolist()
            if not entry.is_dir() and Path(entry.filename).suffix.lower() in SUPPORTED_IMAGE_SUFFIXES
        ]
        if image_number < 1 or image_number > len(original_images):
            raise ValueError("추가 검수할 이미지 번호가 올바르지 않습니다.")
        original_entry = original_images[image_number - 1]
        raw = original_archive.read(original_entry)
        suffix = Path(original_entry.filename).suffix.lower()

    review_method = getattr(translator, "translate_image")
    result = review_method(
        raw,
        suffix,
        original_entry.filename,
        image_number,
        manual_review=True,
    )
    if not result.changed:
        return result

    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.review.partial")
    try:
        with zipfile.ZipFile(destination, "r") as current, zipfile.ZipFile(temporary, "w") as output:
            output.comment = current.comment
            found = False
            for entry in current.infolist():
                data = current.read(entry) if not entry.is_dir() else b""
                if entry.filename == original_entry.filename:
                    data = result.data
                    found = True
                output.writestr(entry, data)
            if not found:
                raise ValueError("출력 ZIP에서 추가 검수할 이미지 항목을 찾지 못했습니다.")
        _replace_with_retry(temporary, destination)
        return result
    except Exception:
        _unlink_with_retry(temporary)
        raise


def _make_thumbnail(raw: bytes, maximum: tuple[int, int] = (56, 56)) -> bytes:
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGBA")
            image.thumbnail(maximum, Image.Resampling.LANCZOS)
            canvas = Image.new("RGBA", maximum, (245, 245, 245, 255))
            left = (maximum[0] - image.width) // 2
            top = (maximum[1] - image.height) // 2
            canvas.alpha_composite(image, (left, top))
            output = io.BytesIO()
            canvas.save(output, format="PNG", optimize=True)
            return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError(f"섬네일을 만들지 못했습니다: {exc}") from exc


def _replace_with_retry(source: Path, destination: Path) -> None:
    last_error: OSError | None = None
    for attempt in range(6):
        try:
            source.replace(destination)
            return
        except OSError as exc:
            last_error = exc
            time.sleep(0.15 * (attempt + 1))
    if last_error:
        raise last_error


def _unlink_with_retry(path: Path) -> None:
    for attempt in range(4):
        try:
            path.unlink(missing_ok=True)
            return
        except OSError:
            time.sleep(0.15 * (attempt + 1))
