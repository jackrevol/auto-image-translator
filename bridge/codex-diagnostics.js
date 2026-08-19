"use strict";

function collectCodexDiagnostics({ stdout = "", stderr = "", stage = "" } = {}) {
  const details = [];
  if (stage) addDetail(details, `실패 단계: ${stage}`);

  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      const event = JSON.parse(trimmed);
      collectEventDetails(event, details);
    } catch {
      // JSONL이 아닌 일반 출력은 아래 stdout 꼬리에서 처리한다.
    }
  }

  const stderrLines = meaningfulLines(stderr);
  for (const line of stderrLines.slice(-6)) addDetail(details, `stderr: ${line}`);
  if (details.length <= (stage ? 1 : 0)) {
    for (const line of meaningfulLines(stdout).slice(-4)) addDetail(details, `stdout: ${line}`);
  }
  return details.slice(0, 12);
}

function createCodexExecutionError({ exitCode, stdout, stderr, spawnError, stage = "Codex 실행" }) {
  const details = collectCodexDiagnostics({ stdout, stderr, stage });
  if (spawnError) addDetail(details, `프로세스 오류: ${spawnError.message || spawnError}`);
  const combined = `${stdout || ""}\n${stderr || ""}`;
  if (/prompt_cache_retention is not supported on this model/i.test(combined)) {
    addDetail(details, "해결 방법: Codex CLI를 최신 버전으로 업데이트한 뒤 프로그램과 Codex를 다시 시작하세요. (codex update)");
    const error = new Error("Codex 모델 호환성 오류 · prompt_cache_retention을 현재 모델이 지원하지 않습니다.");
    error.code = "CODEX_MODEL_COMPATIBILITY";
    error.details = details;
    return error;
  }
  const summary = selectSummary(details) || "Codex 프로세스가 상세 사유 없이 종료되었습니다.";
  const codeLabel = Number.isInteger(exitCode) ? `종료 코드 ${exitCode}` : "실행 실패";
  const error = new Error(`Codex ${codeLabel} · ${summary.replace(/^([^:]+):\s*/, "")}`);
  error.code = "CODEX_EXEC_FAILED";
  error.details = details;
  return error;
}

function attachCodexDiagnostics(error, { stdout = "", stderr = "", stage = "" } = {}) {
  const current = Array.isArray(error.details) ? error.details : [];
  const details = [...current, ...collectCodexDiagnostics({ stdout, stderr, stage })];
  error.details = unique(details).slice(0, 12);
  if (!error.code) error.code = "CODEX_IMAGE_RESULT_FAILED";
  return error;
}

function isCodexImageSafetyBlocked(output) {
  const normalized = singleLine(output);
  return /(?:안전 필터|safety filter).{0,160}(?:차단|거부|중단|block|reject|refus)/i.test(normalized) ||
    /(?:성적 묘사|sexual (?:content|depiction)).{0,160}(?:차단|거부|block|reject|refus)/i.test(normalized);
}

function createCodexImageSafetyError(output, stage = "Codex 이미지 렌더") {
  const error = new Error("Codex 이미지 생성 안전 필터에 차단되었습니다.");
  error.code = "CODEX_IMAGE_SAFETY_BLOCKED";
  error.details = collectCodexDiagnostics({ stdout: output, stage });
  return error;
}

function collectEventDetails(event, details) {
  if (!event || typeof event !== "object") return;
  const item = event.item && typeof event.item === "object" ? event.item : null;
  if (item?.type === "agent_message" && item.text) {
    addDetail(details, `모델 메시지: ${item.text}`);
  }
  if (item?.type === "command_execution" && item.exit_code !== null && Number(item.exit_code) !== 0) {
    addDetail(details, `도구 종료 코드: ${item.exit_code}`);
    if (item.aggregated_output) addDetail(details, `도구 출력: ${item.aggregated_output}`);
  }
  if (/error|failed/i.test(String(event.type || ""))) {
    for (const value of [event.message, event.error, event.detail, item?.error, item?.message]) {
      collectErrorValue(value, details, "Codex 이벤트 오류");
    }
  }
}

function collectErrorValue(value, details, label) {
  if (!value) return;
  if (typeof value === "string") {
    addDetail(details, `${label}: ${value}`);
    return;
  }
  if (typeof value === "object") {
    const message = value.message || value.detail || value.error;
    if (message) addDetail(details, `${label}: ${message}`);
  }
}

function meaningfulLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => singleLine(line));
}

function addDetail(details, value) {
  const normalized = singleLine(value);
  if (!normalized || details.includes(normalized)) return;
  details.push(normalized);
}

function selectSummary(details) {
  return details.find((detail) => !detail.startsWith("실패 단계:") && !/models cache|shell snapshot/i.test(detail));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function singleLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

module.exports = {
  collectCodexDiagnostics,
  createCodexExecutionError,
  attachCodexDiagnostics,
  isCodexImageSafetyBlocked,
  createCodexImageSafetyError
};
