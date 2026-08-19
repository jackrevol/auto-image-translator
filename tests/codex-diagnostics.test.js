"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectCodexDiagnostics,
  createCodexExecutionError,
  attachCodexDiagnostics
} = require("../bridge/codex-diagnostics.js");

test("Codex JSON 이벤트의 모델 메시지와 도구 실패를 상세 사유로 수집한다", () => {
  const stdout = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "이미지 생성 도구 호출에 실패했습니다." } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", exit_code: 2, aggregated_output: "permission denied" } })
  ].join("\n");

  assert.deepEqual(collectCodexDiagnostics({ stdout, stage: "Codex 통합 번역·렌더" }), [
    "실패 단계: Codex 통합 번역·렌더",
    "모델 메시지: 이미지 생성 도구 호출에 실패했습니다.",
    "도구 종료 코드: 2",
    "도구 출력: permission denied"
  ]);
});

test("Codex 비정상 종료 오류는 종료 코드와 상세 배열을 보존한다", () => {
  const error = createCodexExecutionError({
    exitCode: 1,
    stdout: "",
    stderr: "rate limit exceeded",
    stage: "Codex 이미지 분석"
  });

  assert.equal(error.code, "CODEX_EXEC_FAILED");
  assert.match(error.message, /종료 코드 1/);
  assert.deepEqual(error.details, [
    "실패 단계: Codex 이미지 분석",
    "stderr: rate limit exceeded"
  ]);
});

test("결과 경로 해석 오류에도 해당 실행의 모델 메시지를 첨부한다", () => {
  const error = attachCodexDiagnostics(new Error("결과 경로 없음"), {
    stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "생성을 완료하지 못했습니다." } }),
    stage: "Codex 통합 번역·렌더"
  });

  assert.equal(error.code, "CODEX_IMAGE_RESULT_FAILED");
  assert.match(error.details.join(" "), /생성을 완료하지 못했습니다/);
});

test("prompt_cache_retention 모델 호환성 오류에는 업데이트 안내를 제공한다", () => {
  const error = createCodexExecutionError({
    exitCode: 1,
    stderr: "prompt_cache_retention is not supported on this model",
    stage: "Codex 통합 번역·렌더"
  });

  assert.equal(error.code, "CODEX_MODEL_COMPATIBILITY");
  assert.match(error.message, /모델 호환성 오류/);
  assert.match(error.details.join(" "), /codex update/);
});
