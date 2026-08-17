from __future__ import annotations

import re
from dataclasses import dataclass


BRIDGE_PROGRESS_PATTERN = re.compile(
    r"^\[(?P<time>\d{2}:\d{2}:\d{2})\] "
    r"\[작업 #(?P<task>\d+) · 이미지 #(?P<image>\d+)\] (?P<message>.+)$"
)


@dataclass(frozen=True)
class BridgeProgress:
    task_number: int
    image_number: int
    stage: str
    detail: str
    state: str
    source: str | None
    source_label: str
    terminal: bool = False

    @property
    def is_zip(self) -> bool:
        return self.source == "zip"


def parse_bridge_progress(line: str) -> BridgeProgress | None:
    match = BRIDGE_PROGRESS_PATTERN.match(line.strip())
    if not match:
        return None
    message = match.group("message")
    stage, state, terminal = _classify_message(message)
    source, source_label = _detect_source(message)
    return BridgeProgress(
        task_number=int(match.group("task")),
        image_number=int(match.group("image")),
        stage=stage,
        detail=message,
        state=state,
        source=source,
        source_label=source_label,
        terminal=terminal,
    )


def _classify_message(message: str) -> tuple[str, str, bool]:
    rules = (
        ("전체 취소 요청", "전체 취소", "skipped", False),
        ("사용자 추가 검수 미통과", "사용자 검수 필요", "review", False),
        ("사용자 추가 검수 통과", "검수 통과", "done", False),
        ("사용자 검수 필요", "사용자 검수 필요", "review", False),
        ("자동 검수 3회 미통과", "사용자 검수 필요", "review", False),
        ("자동 검수", "자동 재검수", "running", False),
        ("사용자 추가 검수", "사용자 추가 검수", "running", False),
        ("ZIP 이미지 저장 확인", "완료", "done", True),
        ("ZIP 이미지 저장 실패", "저장 실패", "error", True),
        ("페이지 이미지 교체 확인", "페이지 적용 완료", "done", True),
        ("페이지 이미지 교체 실패", "페이지 적용 실패", "error", True),
        ("클라이언트 연결 종료 감지", "결과 전달 실패", "error", True),
        ("사용자 스킵 완료", "스킵 완료", "skipped", True),
        ("사용자 스킵 요청", "스킵 요청", "skipped", False),
        ("오류 ·", "오류", "error", True),
        ("요청 수신", "요청 수신", "running", False),
        ("대기열 진입", "대기열", "waiting", False),
        ("병렬 처리 시작", "처리 시작", "running", False),
        ("원본 준비 완료", "원본 준비", "running", False),
        ("OCR 강화본 준비 완료", "OCR 강화", "running", False),
        ("OCR 강화본 생성 실패", "OCR 대체 처리", "running", False),
        ("글자 분리본 준비 완료", "글자 분리", "running", False),
        ("글자 분리본 생성 실패", "글자 분리 대체", "running", False),
        ("밝은 글자 반전본 준비 완료", "밝은 글자 분리", "running", False),
        ("밝은 글자 반전본 생성 실패", "밝은 글자 대체", "running", False),
        ("밝은 글자 상세 크롭", "밝은 효과음 확대", "running", False),
        ("밝은 글자 상세 #", "밝은 효과음 확대", "running", False),
        ("좌표 기준본 준비 완료", "좌표 검수", "running", False),
        ("좌표 기준본 생성 실패", "좌표 대체 처리", "running", False),
        ("정밀 판독 1/4", "1/4 정밀 판독", "running", False),
        ("누락·좌표 검수 2/4", "2/4 영역 검수", "running", False),
        ("번역·문맥 교정 3/4", "3/4 번역 교정", "running", False),
        ("품질 검수용 1차 합성", "검수본 합성", "running", False),
        ("품질 검수용 WebP", "검수본 준비", "running", False),
        ("합성 결과 검수 4/4", "4/4 시각 검수", "running", False),
        ("Codex 분석 시작", "Codex 분석", "running", False),
        ("Codex 분석 중", "Codex 분석", "running", False),
        ("Codex 분석 완료", "분석 완료", "running", False),
        ("일본어 문구", "문구 감지", "running", False),
        ("글자 영역 #", "영역 검수", "running", False),
        ("저신뢰 문구", "영역 검수", "running", False),
        ("번역할 문구 없음", "원본 유지", "skipped", False),
        ("원문 제거 및 한국어 이미지 재생성 시작", "원문 제거", "running", False),
        ("교체용 WebP 생성 완료", "최종 이미지 생성", "running", False),
        ("처리 슬롯", "결과 정리", "running", False),
        ("교체용 이미지 응답 전송 완료", "페이지 적용 대기", "running", False),
    )
    for marker, stage, state, terminal in rules:
        if marker in message:
            return stage, state, terminal
    return "처리 중", "running", False


def _detect_source(message: str) -> tuple[str | None, str]:
    element_match = re.search(r"<(?P<element>[a-zA-Z0-9_-]+)>", message)
    if element_match:
        element = element_match.group("element")
        if element == "zip":
            return "zip", "ZIP"
        return "web", f"웹 <{element}>"
    if "ZIP 이미지" in message:
        return "zip", "ZIP"
    if "페이지 이미지" in message:
        return "web", "웹"
    return None, ""
