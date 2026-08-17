from __future__ import annotations

import io
import threading
import time
import zipfile
from pathlib import Path

from PIL import Image

from zip_translator.archive import default_output_path, review_zip_image, translate_zip
from zip_translator.bridge_client import ImageTranslation


def _png_bytes(color: str = "white") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (200, 100), color).save(buffer, format="PNG")
    return buffer.getvalue()


class FakeTranslator:
    def translate_image(self, raw: bytes, suffix: str, name: str, image_number: int) -> ImageTranslation:
        return ImageTranslation(_png_bytes("gray"), True, 1, image_number)


class TrackingTranslator:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.active = 0
        self.maximum_active = 0

    def translate_image(self, raw: bytes, suffix: str, name: str, image_number: int) -> ImageTranslation:
        with self.lock:
            self.active += 1
            self.maximum_active = max(self.maximum_active, self.active)
        time.sleep(0.05)
        with self.lock:
            self.active -= 1
        return ImageTranslation(raw, False, 0, image_number)


class AdjustableTrackingTranslator:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.active = 0
        self.maximum_active = 0
        self.first_started = threading.Event()
        self.three_started = threading.Event()
        self.release = threading.Event()

    def translate_image(self, raw: bytes, suffix: str, name: str, image_number: int) -> ImageTranslation:
        with self.lock:
            self.active += 1
            self.maximum_active = max(self.maximum_active, self.active)
            self.first_started.set()
            if self.active >= 3:
                self.three_started.set()
        self.release.wait(timeout=3)
        with self.lock:
            self.active -= 1
        return ImageTranslation(raw, False, 0, image_number)


class InterruptedTranslator:
    def __init__(self, skipped: set[int]) -> None:
        self.skipped = skipped

    def translate_image(self, raw: bytes, suffix: str, name: str, image_number: int) -> ImageTranslation:
        self.skipped.add(image_number)
        raise RuntimeError("브리지 요청 중단")


def test_default_output_path() -> None:
    assert default_output_path(Path("sample.zip")) == Path("sample_ko.zip")


def test_translate_zip_preserves_paths_metadata_and_non_images(tmp_path: Path) -> None:
    source = tmp_path / "source.zip"
    destination = tmp_path / "result.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.comment = "테스트".encode("utf-8")
        archive.writestr("pages/001.png", _png_bytes())
        archive.writestr("notes/readme.txt", "hello")

    stages: list[tuple[int, str, str, str, str]] = []
    translated, failed, skipped = translate_zip(
        source,
        destination,
        FakeTranslator(),
        stage=lambda number, name, stage, detail, state: stages.append(
            (number, name, stage, detail, state)
        ),
    )

    assert (translated, failed, skipped) == (1, 0, 0)
    with zipfile.ZipFile(destination) as archive:
        assert archive.comment == "테스트".encode("utf-8")
        assert archive.namelist() == ["pages/001.png", "notes/readme.txt"]
        assert archive.read("notes/readme.txt") == b"hello"
        with Image.open(io.BytesIO(archive.read("pages/001.png"))) as image:
            assert image.size == (200, 100)
    assert [item[2] for item in stages] == ["대기", "브리지 요청", "ZIP 저장", "완료"]
    assert stages[-1][4] == "done"


def test_translate_zip_uses_configured_parallelism(tmp_path: Path) -> None:
    source = tmp_path / "many.zip"
    destination = tmp_path / "many-ko.zip"
    with zipfile.ZipFile(source, "w") as archive:
        for index in range(8):
            archive.writestr(f"pages/{index:03d}.png", _png_bytes())

    translator = TrackingTranslator()
    translated, failed, skipped = translate_zip(source, destination, translator, parallelism=3)

    assert (translated, failed, skipped) == (0, 0, 0)
    assert translator.maximum_active == 3


def test_translate_zip_applies_parallelism_change_while_running(tmp_path: Path) -> None:
    source = tmp_path / "dynamic.zip"
    destination = tmp_path / "dynamic-ko.zip"
    with zipfile.ZipFile(source, "w") as archive:
        for index in range(6):
            archive.writestr(f"pages/{index:03d}.png", _png_bytes())

    limit = {"value": 1}
    translator = AdjustableTrackingTranslator()
    errors: list[Exception] = []

    def run_translation() -> None:
        try:
            translate_zip(
                source,
                destination,
                translator,
                parallelism=1,
                parallelism_provider=lambda: limit["value"],
            )
        except Exception as exc:
            errors.append(exc)

    worker = threading.Thread(target=run_translation)
    worker.start()
    assert translator.first_started.wait(timeout=2)
    assert translator.maximum_active == 1
    limit["value"] = 3
    assert translator.three_started.wait(timeout=2)
    translator.release.set()
    worker.join(timeout=5)

    assert not worker.is_alive()
    assert not errors
    assert translator.maximum_active == 3


def test_translate_zip_emits_small_thumbnails_and_skips_selected_image(tmp_path: Path) -> None:
    source = tmp_path / "skip.zip"
    destination = tmp_path / "skip-ko.zip"
    original_first = _png_bytes("white")
    original_second = _png_bytes("red")
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("001.png", original_first)
        archive.writestr("002.png", original_second)

    thumbnails: list[tuple[int, str, bytes]] = []
    translated, failed, skipped = translate_zip(
        source,
        destination,
        FakeTranslator(),
        thumbnail=lambda number, name, data: thumbnails.append((number, name, data)),
        should_skip=lambda number: number == 2,
    )

    assert (translated, failed, skipped) == (1, 0, 1)
    assert [item[0] for item in thumbnails] == [1, 2]
    with Image.open(io.BytesIO(thumbnails[0][2])) as preview:
        assert preview.size == (56, 56)
    with zipfile.ZipFile(destination) as archive:
        assert archive.read("002.png") == original_second


def test_translate_zip_emits_finished_image_for_program_preview(tmp_path: Path) -> None:
    source = tmp_path / "preview.zip"
    destination = tmp_path / "preview-ko.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("001.png", _png_bytes("white"))
    previews: list[tuple[int, str, bytes]] = []

    translate_zip(
        source,
        destination,
        FakeTranslator(),
        result_image=lambda number, name, data: previews.append((number, name, data)),
    )

    assert len(previews) == 1
    assert previews[0][0:2] == (1, "001.png")
    with Image.open(io.BytesIO(previews[0][2])) as image:
        assert image.size == (200, 100)


def test_running_bridge_error_is_counted_as_skip_after_user_request(tmp_path: Path) -> None:
    source = tmp_path / "running-skip.zip"
    destination = tmp_path / "running-skip-ko.zip"
    original = _png_bytes("blue")
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("001.png", original)
    skipped_images: set[int] = set()

    translated, failed, skipped = translate_zip(
        source,
        destination,
        InterruptedTranslator(skipped_images),
        should_skip=lambda number: number in skipped_images,
    )

    assert (translated, failed, skipped) == (0, 0, 1)
    with zipfile.ZipFile(destination) as archive:
        assert archive.read("001.png") == original


class ManualReviewTranslator:
    def translate_image(
        self,
        raw: bytes,
        suffix: str,
        name: str,
        image_number: int,
        *,
        manual_review: bool = False,
    ) -> ImageTranslation:
        assert manual_review
        return ImageTranslation(
            _png_bytes("green"),
            True,
            2,
            quality_review_required=False,
            quality_attempts=1,
        )


def test_review_zip_image_replaces_only_selected_output_entry(tmp_path: Path) -> None:
    source = tmp_path / "source.zip"
    destination = tmp_path / "translated.zip"
    first = _png_bytes("red")
    second = _png_bytes("blue")
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("001.png", first)
        archive.writestr("002.png", second)
    with zipfile.ZipFile(destination, "w") as archive:
        archive.writestr("001.png", _png_bytes("yellow"))
        archive.writestr("002.png", _png_bytes("purple"))

    result = review_zip_image(source, destination, ManualReviewTranslator(), 2)

    assert result.changed
    with zipfile.ZipFile(destination, "r") as archive:
        assert archive.read("001.png") == _png_bytes("yellow")
        assert archive.read("002.png") == _png_bytes("green")
