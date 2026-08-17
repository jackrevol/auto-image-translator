"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { selectReliableRegions, averageConfidence } = require("../bridge/ocr-results.js");

test("신뢰도가 낮은 OCR 문구는 이미지 교체 대상에서 제외한다", () => {
  const high = { original: "こんにちは", confidence: 0.91 };
  const low = { original: "読めない", confidence: 0.31 };
  const selected = selectReliableRegions([high, low]);

  assert.deepEqual(selected.accepted, [high]);
  assert.deepEqual(selected.rejected, [low]);
});

test("평균 OCR 신뢰도를 계산한다", () => {
  assert.equal(averageConfidence([{ confidence: 0.8 }, { confidence: 0.6 }]), 0.7);
  assert.equal(averageConfidence([]), null);
});
