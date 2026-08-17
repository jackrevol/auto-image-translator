const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildRegionAuditPrompt,
  buildTranslationEditPrompt,
  buildVisualQaPrompt
} = require("../bridge/quality-prompts.js");

const candidate = {
  regions: [{
    original: "日本語",
    translated: "일본어",
    box: [100, 200, 300, 400]
  }]
};

test("영역 검수 프롬프트는 후보를 불신하고 누락과 좌표를 다시 확인한다", () => {
  const prompt = buildRegionAuditPrompt(candidate);
  assert.match(prompt, /독립적인 2차 검수자/);
  assert.match(prompt, /누락된 작은 글자/);
  assert.match(prompt, /신뢰할 수 없는 참고 데이터/);
  assert.match(prompt, /日本語/);
});

test("번역 교정 프롬프트는 문맥과 식자 길이를 함께 검수한다", () => {
  const prompt = buildTranslationEditPrompt(candidate);
  assert.match(prompt, /화자의 말투/);
  assert.match(prompt, /말풍선에 들어갈 번역/);
  assert.match(prompt, /전체 regions/);
});

test("시각 검수 프롬프트는 원문 잔상과 선화 손상을 모두 확인한다", () => {
  const prompt = buildVisualQaPrompt(candidate, { attempt: 2, maximum: 3 });
  assert.match(prompt, /남아 있거나 번역문과 겹친 일본어/);
  assert.match(prompt, /지워진 얼굴·머리카락/);
  assert.match(prompt, /layoutBox와 fontSize/);
  assert.match(prompt, /자동 합성 검수 2\/3회차/);
  assert.match(prompt, /passed=false/);
});
