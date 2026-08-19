from __future__ import annotations

from zip_translator.progress import parse_bridge_progress


def test_zip_codex_log_is_mapped_to_image_stage() -> None:
    progress = parse_bridge_progress(
        "[14:03:21] [작업 #7 · 이미지 #23] Codex 분석 시작 · <zip> · pages/023.png"
    )

    assert progress is not None
    assert progress.task_number == 7
    assert progress.image_number == 23
    assert progress.stage == "Codex 분석"
    assert progress.state == "running"
    assert progress.is_zip


def test_quality_pass_logs_are_mapped_to_detailed_stages() -> None:
    translation = parse_bridge_progress(
        "[14:03:25] [작업 #7 · 이미지 #23] 번역·문맥 교정 3/4 진행 중 · 20초 경과"
    )
    visual = parse_bridge_progress(
        "[14:04:11] [작업 #7 · 이미지 #23] 합성 결과 검수 4/4 시작 · 첨부 자료 5개"
    )

    assert translation is not None and translation.stage == "3/4 번역 교정"
    assert visual is not None and visual.stage == "4/4 시각 검수"


def test_bright_sfx_detail_logs_are_mapped() -> None:
    progress = parse_bridge_progress(
        "[21:10:00] [작업 #9 · 이미지 #9] 밝은 글자 상세 크롭 3개 준비 완료 · 어두운 고대비 패널 확대"
    )

    assert progress is not None
    assert progress.stage == "밝은 효과음 확대"
    assert progress.state == "running"


def test_codex_image_render_log_is_mapped() -> None:
    progress = parse_bridge_progress(
        "[21:12:00] [작업 #10 · 이미지 #4] Codex 대사 영역 렌더 1회차 진행 중 · 30초 경과"
    )

    assert progress is not None
    assert progress.stage == "Codex 영역 렌더"
    assert progress.state == "running"


def test_codex_safety_fallback_log_is_mapped() -> None:
    progress = parse_bridge_progress(
        "[21:12:00] [작업 #10 · 이미지 #4] Codex 대사 작업 시트 2/3 안전 필터 차단 · 크롭 4개만 로컬 정밀 식질로 대체"
    )

    assert progress is not None
    assert progress.stage == "로컬 대체 식질"
    assert progress.state == "running"


def test_codex_atlas_log_is_mapped() -> None:
    progress = parse_bridge_progress(
        "[21:12:00] [작업 #10 · 이미지 #4] Codex 대사 작업 시트 1/3 준비 · 크롭 4개 · 번역·식질 위임"
    )

    assert progress is not None
    assert progress.stage == "Codex 작업 시트"
    assert progress.state == "running"


def test_zip_commit_is_a_terminal_completed_stage() -> None:
    progress = parse_bridge_progress(
        "[14:03:40] [작업 #7 · 이미지 #23] ZIP 이미지 저장 확인 · <zip>"
    )

    assert progress is not None
    assert progress.stage == "완료"
    assert progress.state == "done"
    assert progress.terminal


def test_non_progress_log_is_ignored() -> None:
    assert parse_bridge_progress("이미지 한글 번역기 로컬 브리지") is None


def test_web_request_and_page_commit_are_mapped_separately() -> None:
    request = parse_bridge_progress(
        "[09:10:11] [작업 #12 · 이미지 #3] 요청 수신 · 800 KB · <img> · example.com/page.png"
    )
    commit = parse_bridge_progress(
        "[09:10:30] [작업 #12 · 이미지 #3] 페이지 이미지 교체 확인 · <img>"
    )

    assert request is not None and request.source == "web"
    assert request.source_label == "웹 <img>"
    assert commit is not None and commit.stage == "페이지 적용 완료"
    assert commit.state == "done"
    assert commit.terminal


def test_user_skip_log_is_a_terminal_skipped_stage() -> None:
    progress = parse_bridge_progress(
        "[09:10:20] [작업 #12 · 이미지 #3] 사용자 스킵 완료 · 원본 유지"
    )

    assert progress is not None
    assert progress.stage == "스킵 완료"
    assert progress.state == "skipped"
    assert progress.terminal


def test_three_failed_visual_checks_wait_for_user_review() -> None:
    progress = parse_bridge_progress(
        "[14:08:11] [작업 #9 · 이미지 #4] 자동 검수 3회 미통과 · 사용자 검수 필요"
    )

    assert progress is not None
    assert progress.stage == "사용자 검수 필요"
    assert progress.state == "review"
    assert not progress.terminal


def test_cancel_all_log_is_visible_in_image_progress() -> None:
    progress = parse_bridge_progress(
        "[14:09:12] [작업 #10 · 이미지 #5] 전체 취소 요청 · 현재 Codex 단계 중단"
    )

    assert progress is not None
    assert progress.stage == "전체 취소"
    assert progress.state == "skipped"
