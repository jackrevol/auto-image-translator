"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const {
  planRegionCrops,
  renderRegionCrops,
  renderRegionAtlases,
  layoutCropAtlas,
  createRegionRenderSignature,
  planAtlasBatches,
  rebuildRenderedTile
} = require("../bridge/codex-region-renderer.js");

function region(box, translated) {
  return {
    box,
    layoutBox: box,
    original: "原文",
    translated,
    regionKind: "dialogue",
    fontSize: 36,
    strokeWidth: 2
  };
}

test("가까워서 확장 영역이 겹치는 대사는 하나의 크롭으로 묶는다", () => {
  const crops = planRegionCrops([
    region([100, 100, 180, 240], "첫 번째"),
    region([190, 110, 270, 250], "두 번째")
  ], 1000, 1000);

  assert.equal(crops.length, 1);
  assert.equal(crops[0].regions.length, 2);
  assert.ok(crops[0].regions[0].fontSize > 36);
  for (const item of crops[0].regions.flatMap((value) => [value.box, value.layoutBox])) {
    assert.ok(item.every((coordinate) => coordinate >= 0 && coordinate <= 1000));
  }
});

test("멀리 떨어진 대사 영역은 별도 크롭으로 유지한다", () => {
  const crops = planRegionCrops([
    region([50, 50, 120, 160], "왼쪽"),
    region([800, 750, 900, 900], "오른쪽")
  ], 1200, 1800);

  assert.equal(crops.length, 2);
});

test("연쇄적으로 겹치는 문구가 페이지 전체 크롭 하나로 합쳐지지 않는다", () => {
  const regions = Array.from({ length: 8 }, (_, index) =>
    region([100 + index * 75, 200, 170 + index * 75, 350], `문구 ${index + 1}`)
  );
  const crops = planRegionCrops(regions, 1000, 1400);

  assert.ok(crops.length >= 3);
  assert.ok(crops.every((crop) => crop.regions.length <= 3));
  assert.ok(crops.every((crop) => (crop.box.right - crop.box.left) <= 480));
});

test("Codex가 편집한 크롭을 원래 좌표에 순차 재조립한다", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-region-compose-"));
  const source = path.join(directory, "source.png");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await sharp({ create: { width: 200, height: 100, channels: 3, background: "white" } }).png().toFile(source);
  const colors = ["#ff0000", "#0000ff"];
  let callCount = 0;
  const result = await renderRegionCrops({
    imagePath: source,
    regions: [
      region([40, 100, 220, 800], "왼쪽"),
      region([780, 100, 960, 800], "오른쪽")
    ],
    renderCrop: async ({ input }) => {
      const metadata = await sharp(input).metadata();
      const color = colors[callCount++];
      return sharp({
        create: { width: metadata.width, height: metadata.height, channels: 3, background: color }
      }).png().toBuffer();
    }
  });

  assert.equal(result.cropCount, 2);
  const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
  const left = (50 * info.width + 10) * info.channels;
  const right = (50 * info.width + 190) * info.channels;
  assert.deepEqual([...data.subarray(left, left + 3)], [255, 0, 0]);
  assert.deepEqual([...data.subarray(right, right + 3)], [0, 0, 255]);
});

test("여러 대사 크롭을 한 작업 시트로 결합하고 다시 분할한다", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-region-atlas-"));
  const source = path.join(directory, "source.png");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await sharp({ create: { width: 320, height: 180, channels: 3, background: "white" } }).png().toFile(source);
  const regions = [
    region([40, 100, 220, 800], "왼쪽"),
    region([780, 100, 960, 800], "오른쪽")
  ];
  const planned = planRegionCrops(regions, 320, 180);
  const layout = layoutCropAtlas(planned);
  assert.equal(layout.tiles.length, 2);
  assert.ok(layout.regions.every((item) => item.box.every((coordinate) => coordinate >= 0 && coordinate <= 1000)));

  let atlasCalls = 0;
  const result = await renderRegionAtlases({
    imagePath: source,
    regions,
    renderAtlas: async ({ input, tiles }) => {
      atlasCalls += 1;
      assert.equal(tiles.length, 2);
      return input;
    }
  });

  assert.equal(atlasCalls, 1);
  assert.equal(result.cropCount, 2);
  assert.equal(result.atlasCount, 1);
  const metadata = await sharp(result.buffer).metadata();
  assert.deepEqual([metadata.width, metadata.height], [320, 180]);
});

test("변경 없는 작업 시트는 캐시하고 동일 영역의 중복 렌더를 생략한다", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-region-cache-"));
  const source = path.join(directory, "source.png");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await sharp({ create: { width: 320, height: 180, channels: 3, background: "white" } }).png().toFile(source);
  const regions = [
    region([40, 100, 220, 800], "왼쪽"),
    region([780, 100, 960, 800], "오른쪽")
  ];
  const renderCache = new Map();
  let atlasCalls = 0;
  const renderAtlas = async ({ input }) => {
    atlasCalls += 1;
    return input;
  };

  await renderRegionAtlases({ imagePath: source, regions, renderAtlas, renderCache });
  const phases = [];
  await renderRegionAtlases({
    imagePath: source,
    regions,
    renderAtlas,
    renderCache,
    onProgress: ({ phase }) => phases.push(phase)
  });

  assert.equal(atlasCalls, 1);
  assert.ok(phases.includes("cache"));
});

test("영역 렌더 서명은 객체 키 순서와 무관하고 실제 변경은 구분한다", () => {
  const first = [{ original: "原文", translated: "번역", box: [1, 2, 3, 4] }];
  const reordered = [{ box: [1, 2, 3, 4], translated: "번역", original: "原文" }];
  const changed = [{ box: [1, 2, 3, 4], translated: "수정", original: "原文" }];

  assert.equal(createRegionRenderSignature(first), createRegionRenderSignature(reordered));
  assert.notEqual(createRegionRenderSignature(first), createRegionRenderSignature(changed));
});

test("미통과 결과를 그대로 다시 만들 때는 작업 시트 캐시를 우회한다", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-region-cache-bypass-"));
  const source = path.join(directory, "source.png");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await sharp({ create: { width: 200, height: 100, channels: 3, background: "white" } }).png().toFile(source);
  const regions = [region([200, 100, 800, 900], "다시 렌더")];
  const renderCache = new Map();
  let atlasCalls = 0;
  const renderAtlas = async ({ input }) => {
    atlasCalls += 1;
    return input;
  };

  await renderRegionAtlases({ imagePath: source, regions, renderAtlas, renderCache });
  await renderRegionAtlases({
    imagePath: source,
    regions,
    renderAtlas,
    renderCache,
    bypassRenderCache: true
  });

  assert.equal(atlasCalls, 2);
});

test("작업 시트가 축소될 조합은 원본 해상도를 유지하도록 더 작은 배치로 나눈다", () => {
  const crops = Array.from({ length: 4 }, (_, index) => ({
    index: index + 1,
    box: { left: 0, top: 0, right: 800, bottom: 2100 },
    regions: [region([100, 100, 900, 900], `문구 ${index + 1}`)]
  }));

  const batches = planAtlasBatches(crops, 4, 4096);

  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.length), [2, 2]);
  assert.ok(batches.every((batch) => layoutCropAtlas(batch).scale === 1));
});

test("Codex 타일의 그림자와 배경 변형은 버리고 한국어 글자 픽셀만 원본 위에 재조립한다", async () => {
  const original = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "#ffffff" }
  }).png().toBuffer();
  const generated = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "#aaaaaa" }
  }).composite([{
    input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect x="43" y="28" width="14" height="24" fill="#111111"/></svg>', "utf8"),
    left: 0,
    top: 0
  }]).png().toBuffer();
  const crop = {
    box: { left: 0, top: 0, right: 100, bottom: 80 },
    regions: [{
      ...region([350, 250, 650, 750], "한"),
      textColor: "#111111",
      backgroundColor: "#ffffff",
      strokeWidth: 0
    }]
  };

  const rebuilt = await rebuildRenderedTile(original, generated, crop);
  const { data, info } = await sharp(rebuilt).raw().toBuffer({ resolveWithObject: true });
  const corner = (5 * info.width + 5) * info.channels;
  const text = (40 * info.width + 50) * info.channels;
  assert.deepEqual([...data.subarray(corner, corner + 3)], [255, 255, 255]);
  assert.deepEqual([...data.subarray(text, text + 3)], [17, 17, 17]);
});
