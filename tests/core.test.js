const assert = require("node:assert/strict");
const test = require("node:test");
const Core = require("../core.js");

test("normalizeBox는 뒤집힌 좌표를 정렬하고 범위를 제한한다", () => {
  assert.deepEqual(Core.normalizeBox([-20, 900, 1200, 100]), {
    top: 100,
    left: 0,
    bottom: 900,
    right: 1000
  });
});

test("normalizeBox는 사용할 수 없는 박스를 거부한다", () => {
  assert.equal(Core.normalizeBox([1, 1, 1, 10]), null);
  assert.equal(Core.normalizeBox([1, 2, 3]), null);
});

test("mapRegionToAnchor는 잘린 화면 좌표를 원본 요소 비율로 변환한다", () => {
  const mapped = Core.mapRegionToAnchor([200, 100, 800, 500], {
    left: 0.1,
    top: 0.2,
    width: 0.5,
    height: 0.6
  });
  assert.deepEqual(mapped, {
    left: 0.2,
    top: 0.26,
    width: 0.3,
    height: 0.24
  });
});

test("normalizeColor는 안전한 6자리 색상만 허용한다", () => {
  assert.equal(Core.normalizeColor("#A0b1C2", "#000000"), "#A0b1C2");
  assert.equal(Core.normalizeColor("red", "#000000"), "#000000");
});

test("regionFontRatio는 잘린 영역 비율을 반영해 원문 글자 크기를 유지한다", () => {
  assert.equal(Core.regionFontRatio({ fontSize: 80 }, { height: 0.5 }), 0.04);
});
