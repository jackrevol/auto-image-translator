const assert = require("node:assert/strict");
const test = require("node:test");
const sharp = require("sharp");
const {
  renderTranslatedImage,
  normalizeRegion,
  wrapKorean,
  deduplicateRegions,
  removeOriginalText,
  recenterRegionOnBounds,
  chooseRenderOrientation,
  fitHorizontalFontSize
} = require("../bridge/image-renderer.js");

test("한국어 문장을 원문 폭에 맞춰 줄바꿈한다", () => {
  assert.deepEqual(wrapKorean("이미지번역", 3), ["이미지", "번역"]);
  assert.deepEqual(wrapKorean("안녕, 괜찮아?", 7), ["안녕,", "괜찮아?"]);
});

test("스타일 영역을 실제 이미지 픽셀 좌표로 변환한다", () => {
  const region = normalizeRegion({
    box: [200, 100, 800, 500],
    translated: "안녕하세요",
    fontSize: 80,
    textColor: "#112233",
    backgroundColor: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 2,
    rotation: 4
  }, 1000, 500);
  assert.equal(region.left, 200);
  assert.equal(region.top, 50);
  assert.equal(region.width, 600);
  assert.equal(region.fontSize, 40);
  assert.deepEqual(region.textRgb, [17, 34, 51]);
});

test("원문 제거 영역과 한국어 조판 영역을 별도로 변환한다", () => {
  const region = normalizeRegion({
    box: [300, 200, 500, 400],
    layoutBox: [200, 100, 700, 600],
    translated: "한국어",
    fontSize: 60
  }, 1000, 500);

  assert.equal(region.left, 300);
  assert.equal(region.top, 100);
  assert.equal(region.layoutLeft, 200);
  assert.equal(region.layoutTop, 50);
  assert.equal(region.layoutWidth, 500);
  assert.equal(region.layoutHeight, 250);
});

test("모델의 조판 영역이 원문 영역보다 지나치게 작으면 원문 영역을 사용한다", () => {
  const region = normalizeRegion({
    box: [300, 200, 700, 800],
    layoutBox: [320, 500, 500, 750],
    translated: "좁은 말풍선",
    regionKind: "dialogue",
    fontSize: 60
  }, 1000, 1000);

  assert.equal(region.hasLayoutBox, false);
  assert.equal(region.layoutLeft, 300);
  assert.equal(region.layoutTop, 200);
  assert.equal(region.layoutWidth, 400);
  assert.equal(region.layoutHeight, 600);
});

test("한국어 대사는 세로 원문이어도 말풍선 안에 가로로 조판한다", () => {
  assert.equal(chooseRenderOrientation({ translated: "괜찮아?", orientation: "vertical", regionKind: "dialogue" }), "horizontal");
  assert.equal(chooseRenderOrientation({ translated: "괜찮아?", orientation: "vertical", regionKind: "dialogue", layoutWidth: 100, layoutHeight: 220 }), "vertical");
  assert.equal(chooseRenderOrientation({ translated: "괜찮아?", orientation: "vertical", regionKind: "dialogue", layoutWidth: 300, layoutHeight: 700 }), "horizontal");
  assert.equal(chooseRenderOrientation({ translated: "쾅", orientation: "vertical", regionKind: "sfx" }), "vertical");
});

test("긴 한국어 번역은 말풍선 조판 영역 안에 들어갈 때까지 축소한다", () => {
  const fontSize = fitHorizontalFontSize({
    translated: "이 문장은 좁은 말풍선 안에 들어가도록 크기가 자동으로 조절되어야 합니다.",
    orientation: "vertical",
    regionKind: "dialogue",
    fontSize: 80,
    layoutWidth: 220,
    layoutHeight: 300
  });

  assert.ok(fontSize < 80 * 0.72);
  assert.ok(fontSize >= 7);
});

test("짧은 세로 원문을 가로 한국어로 바꿀 때 원문 글자 크기를 최대한 유지한다", () => {
  const fontSize = fitHorizontalFontSize({
    translated: "괜찮아?",
    orientation: "vertical",
    regionKind: "dialogue",
    fontSize: 80,
    layoutWidth: 500,
    layoutHeight: 260
  });

  assert.ok(fontSize >= 71 && fontSize <= 72);
});

test("원문을 지우고 번역문이 합성된 WebP 이미지를 생성한다", async () => {
  const input = await sharp({
    create: { width: 320, height: 160, channels: 4, background: "#f5e8cf" }
  })
    .composite([{
      input: Buffer.from('<svg width="320" height="160"><text x="60" y="95" font-size="48" fill="#111111">日本語</text></svg>', "utf8")
    }])
    .png()
    .toBuffer();

  const output = await renderTranslatedImage(input, [{
    box: [140, 220, 860, 700],
    original: "日本語",
    translated: "일본어",
    orientation: "horizontal",
    fontSize: 300,
    textColor: "#111111",
    backgroundColor: "#f5e8cf",
    bold: false,
    fontStyle: "sans",
    strokeColor: "#f5e8cf",
    strokeWidth: 0,
    italic: false,
    rotation: 0,
    align: "center",
    backgroundComplex: false
  }]);

  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 160);
  assert.ok(output.length > 100);
});

test("만화 말풍선 테두리와 긴 선화를 지우지 않는다", async () => {
  const input = await sharp({
    create: { width: 320, height: 240, channels: 4, background: "#ffffff" }
  })
    .composite([{
      input: Buffer.from('<svg width="320" height="240"><ellipse cx="160" cy="120" rx="130" ry="95" fill="none" stroke="#111" stroke-width="6"/><line x1="35" y1="35" x2="35" y2="205" stroke="#111" stroke-width="5"/><text x="95" y="135" font-size="42" fill="#111">日本語</text></svg>', "utf8")
    }])
    .png()
    .toBuffer();

  const output = await renderTranslatedImage(input, [{
    box: [60, 70, 940, 930],
    original: "日本語",
    translated: "일본어",
    confidence: 0.95,
    regionKind: "dialogue",
    orientation: "horizontal",
    fontSize: 175,
    textColor: "#111111",
    backgroundColor: "#ffffff",
    bold: false,
    fontStyle: "sans",
    strokeColor: "#ffffff",
    strokeWidth: 0,
    italic: false,
    rotation: 0,
    align: "center",
    backgroundComplex: false
  }]);

  const decoded = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const topBorder = (25 * decoded.info.width + 160) * decoded.info.channels;
  const artLine = (120 * decoded.info.width + 35) * decoded.info.channels;
  assert.ok(decoded.data[topBorder] < 80, "말풍선 테두리가 보존되어야 한다");
  assert.ok(decoded.data[artLine] < 80, "긴 선화가 보존되어야 한다");
});

test("겹쳐 검출된 같은 영역은 신뢰도가 높은 하나만 남긴다", () => {
  const low = normalizeRegion({ box: [100, 100, 500, 500], translated: "낮음", confidence: 0.6 }, 1000, 1000);
  const high = normalizeRegion({ box: [105, 105, 495, 495], translated: "높음", confidence: 0.95 }, 1000, 1000);
  const unique = deduplicateRegions([low, high]);

  assert.equal(unique.length, 1);
  assert.equal(unique[0].translated, "높음");
});

test("EXIF 회전 방향을 최종 이미지에 적용한다", async () => {
  const input = await sharp({
    create: { width: 120, height: 60, channels: 3, background: "#eeeeee" }
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const output = await renderTranslatedImage(input, []);
  const metadata = await sharp(output).metadata();

  assert.equal(metadata.width, 60);
  assert.equal(metadata.height, 120);
});

test("말풍선 글자는 완전히 지우고 긴 만화 선은 유지한다", () => {
  const width = 100;
  const height = 100;
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels, 255);
  const paintBlack = (x, y) => {
    const index = (y * width + x) * channels;
    pixels[index] = 17;
    pixels[index + 1] = 17;
    pixels[index + 2] = 17;
  };
  for (let x = 5; x < 95; x += 1) paintBlack(x, 10);
  for (let y = 40; y < 56; y += 1) {
    for (let x = 38; x < 49; x += 1) paintBlack(x, y);
  }

  const region = {
    left: 30,
    top: 0,
    right: 70,
    bottom: 70,
    width: 40,
    height: 70,
    fontSize: 20,
    strokePx: 0,
    textRgb: [17, 17, 17],
    strokeRgb: [255, 255, 255],
    backgroundRgb: [255, 255, 255],
    backgroundComplex: false,
    regionKind: "dialogue"
  };
  removeOriginalText(pixels, width, height, channels, region);

  assert.equal(pixels[(47 * width + 43) * channels], 255, "원문 글자 영역이 배경색으로 지워져야 한다");
  assert.equal(pixels[(10 * width + 50) * channels], 17, "긴 선화는 그대로 남아야 한다");
});

test("단색 영역에서는 부정확한 제거 box 밖의 원문도 layoutBox 안에서 지운다", () => {
  const width = 120;
  const height = 80;
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels, 255);
  const paintBlack = (x, y) => {
    const index = (y * width + x) * channels;
    pixels[index] = 17;
    pixels[index + 1] = 17;
    pixels[index + 2] = 17;
  };
  for (let y = 30; y < 42; y += 1) {
    for (let x = 72; x < 79; x += 1) {
      const index = (y * width + x) * channels;
      pixels[index] = 155;
      pixels[index + 1] = 155;
      pixels[index + 2] = 155;
    }
  }
  for (let x = 15; x < 105; x += 1) {
    const index = (48 * width + x) * channels;
    pixels[index] = 210;
    pixels[index + 1] = 210;
    pixels[index + 2] = 210;
  }
  for (let y = 42; y <= 48; y += 1) paintBlack(75, y);

  const region = {
    left: 30,
    top: 25,
    right: 60,
    bottom: 50,
    width: 30,
    height: 25,
    layoutLeft: 25,
    layoutTop: 20,
    layoutRight: 90,
    layoutBottom: 55,
    fontSize: 16,
    strokePx: 0,
    textRgb: [17, 17, 17],
    strokeRgb: [255, 255, 255],
    backgroundRgb: [255, 255, 255],
    backgroundComplex: false,
    regionKind: "narration"
  };
  removeOriginalText(pixels, width, height, channels, region);

  assert.equal(pixels[(35 * width + 75) * channels], 255, "layoutBox 안에 남은 원문까지 지워야 한다");
  assert.equal(pixels[(48 * width + 60) * channels], 210, "원문과 맞닿은 흐린 구분선도 유지해야 한다");
});

test("긴 일본어 가로획은 구분선으로 오인하지 않고 제거한다", () => {
  const width = 200;
  const height = 80;
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels, 255);
  const paint = (x, y, value) => {
    const index = (y * width + x) * channels;
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
  };
  for (let y = 25; y <= 35; y += 1) {
    for (let x = 40; x <= 44; x += 1) paint(x, y, 17);
  }
  for (let x = 44; x <= 96; x += 1) paint(x, 30, 80);
  for (let x = 15; x < 185; x += 1) paint(x, 55, 210);

  const region = {
    left: 35,
    top: 20,
    right: 105,
    bottom: 60,
    width: 70,
    height: 40,
    layoutLeft: 20,
    layoutTop: 20,
    layoutRight: 180,
    layoutBottom: 60,
    orientation: "horizontal",
    fontSize: 10,
    strokePx: 0,
    textRgb: [17, 17, 17],
    strokeRgb: [255, 255, 255],
    backgroundRgb: [255, 255, 255],
    backgroundComplex: false,
    regionKind: "narration"
  };
  removeOriginalText(pixels, width, height, channels, region);

  assert.equal(pixels[(30 * width + 70) * channels], 255, "글자에 속한 긴 가로획은 제거해야 한다");
  assert.equal(pixels[(55 * width + 100) * channels], 210, "영역 전체를 가로지르는 구분선은 유지해야 한다");
});

test("말풍선 옆의 큰 검은 선화는 글자로 오인해 지우지 않는다", () => {
  const width = 120;
  const height = 120;
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels, 255);
  const paintBlack = (x, y) => {
    const index = (y * width + x) * channels;
    pixels[index] = 17;
    pixels[index + 1] = 17;
    pixels[index + 2] = 17;
  };
  for (let y = 20; y <= 80; y += 1) {
    for (let x = 5; x <= 35; x += 1) paintBlack(x, y);
  }
  for (let y = 42; y <= 52; y += 1) {
    for (let x = 55; x <= 61; x += 1) paintBlack(x, y);
  }

  const region = {
    left: 30,
    top: 20,
    right: 80,
    bottom: 90,
    width: 50,
    height: 70,
    fontSize: 10,
    strokePx: 0,
    textRgb: [17, 17, 17],
    strokeRgb: [17, 17, 17],
    backgroundRgb: [255, 255, 255],
    backgroundComplex: false,
    regionKind: "dialogue"
  };
  removeOriginalText(pixels, width, height, channels, region);

  assert.equal(pixels[(50 * width + 20) * channels], 17, "인물이나 머리카락 같은 큰 선화는 유지해야 한다");
  assert.equal(pixels[(47 * width + 58) * channels], 255, "작은 원문 글자 획은 지워야 한다");
});

test("복잡 배경으로 오인된 흰 말풍선에서도 곡선 테두리를 유지한다", () => {
  const width = 120;
  const height = 90;
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels, 255);
  const paintBlack = (x, y) => {
    const index = (y * width + x) * channels;
    pixels[index] = 17;
    pixels[index + 1] = 17;
    pixels[index + 2] = 17;
  };
  for (let x = 25; x <= 85; x += 1) {
    const y = 18 + Math.round(((x - 55) / 30) ** 2 * 10);
    paintBlack(x, y);
    paintBlack(x, y + 1);
  }
  for (let y = 42; y <= 54; y += 1) {
    for (let x = 52; x <= 58; x += 1) paintBlack(x, y);
  }

  const region = {
    left: 20,
    top: 10,
    right: 90,
    bottom: 65,
    width: 70,
    height: 55,
    fontSize: 20,
    strokePx: 0,
    textRgb: [17, 17, 17],
    strokeRgb: [17, 17, 17],
    backgroundRgb: [255, 255, 255],
    backgroundComplex: true,
    regionKind: "dialogue"
  };
  removeOriginalText(pixels, width, height, channels, region);

  assert.equal(pixels[(18 * width + 55) * channels], 17, "곡선형 말풍선 테두리는 유지해야 한다");
  assert.equal(pixels[(48 * width + 55) * channels], 255, "테두리 안의 원문 글자는 지워야 한다");
});

test("실제 글자 픽셀 중심으로 번역 영역 위치를 보정한다", () => {
  const region = { left: 50, top: 50, right: 90, bottom: 90, width: 40, height: 40 };
  recenterRegionOnBounds(region, { left: 30, top: 20, right: 70, bottom: 60 }, 200, 200);

  assert.equal(region.left, 30);
  assert.equal(region.top, 20);
  assert.equal(region.right, 70);
  assert.equal(region.bottom, 60);
});

test("번역문 주변에는 불투명한 배경 패널을 만들지 않는다", async () => {
  const input = await sharp({
    create: { width: 200, height: 100, channels: 4, background: "#d02030" }
  }).png().toBuffer();
  const output = await renderTranslatedImage(input, [{
    box: [250, 200, 750, 800],
    original: "仮",
    translated: "번역",
    confidence: 0.9,
    regionKind: "label",
    orientation: "horizontal",
    fontSize: 200,
    textColor: "#ffffff",
    backgroundColor: "#000000",
    bold: false,
    fontStyle: "sans",
    strokeColor: "#000000",
    strokeWidth: 0,
    italic: false,
    rotation: 0,
    align: "center",
    backgroundComplex: true
  }]);
  const decoded = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sample = (25 * decoded.info.width + 55) * decoded.info.channels;

  assert.ok(decoded.data[sample] > 180, "번역 영역의 원래 붉은 배경이 유지되어야 한다");
  assert.ok(decoded.data[sample + 1] < 70, "불투명한 검은 배경 패널이 없어야 한다");
});

test("회색 선화 위 작은 세로 글자의 안티앨리어싱 획만 정리한다", () => {
  const width = 100;
  const height = 100;
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels, 255);
  const setGray = (x, y, value) => {
    const index = (y * width + x) * channels;
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
    pixels[index + 3] = 255;
  };

  // 옅은 밑그림 선과, 가운데의 작은 세로 글자(검은 중심 + 회색 가장자리)를 흉내 냅니다.
  for (let y = 10; y < 90; y += 1) setGray(20 + Math.floor(y / 8), y, 185);
  for (let y = 32; y < 66; y += 1) {
    setGray(52, y, 45);
    setGray(53, y, 12);
    setGray(54, y, 45);
  }

  const region = {
    left: 48,
    top: 28,
    right: 59,
    bottom: 70,
    width: 11,
    height: 42,
    fontSize: 34,
    strokePx: 0,
    textRgb: [0, 0, 0],
    strokeRgb: [0, 0, 0],
    // 회색 선화가 많은 이미지에서는 모델이 배경색을 회색으로 판단할 수도 있습니다.
    backgroundRgb: [88, 88, 88],
    backgroundComplex: true,
    regionKind: "label",
    orientation: "vertical"
  };

  const result = removeOriginalText(pixels, width, height, channels, region);
  assert.ok(result.removedPixels > 0, "작은 세로 글자 픽셀을 찾아야 한다");
  assert.ok(pixels[(48 * width + 52) * channels] > 180, "글자의 회색 가장자리도 지워야 한다");
  assert.equal(pixels[(48 * width + 26) * channels], 185, "떨어져 있는 회색 선화는 유지해야 한다");
});

test("검은 패널의 대형 흰색 효과음은 지우고 긴 효과선은 보존한다", () => {
  const width = 200;
  const height = 150;
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels, 0);
  for (let index = 3; index < pixels.length; index += channels) pixels[index] = 255;
  const paintWhite = (x, y) => {
    const index = (y * width + x) * channels;
    pixels[index] = 255;
    pixels[index + 1] = 255;
    pixels[index + 2] = 255;
  };

  // 굵고 큰 장식 효과음 획을 흉내 냅니다. 기존 로직에서는 큰 선화로 분류되어 남았습니다.
  for (let y = 35; y <= 90; y += 1) {
    for (let x = 50; x <= 130; x += 1) paintWhite(x, y);
  }
  for (let y = 55; y <= 72; y += 1) {
    for (let x = 80; x <= 130; x += 1) {
      const index = (y * width + x) * channels;
      pixels[index] = 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = 0;
    }
  }
  // 패널을 가로지르는 얇은 광선은 텍스트와 같은 흰색이어도 보존되어야 합니다.
  for (let x = 0; x < width; x += 1) paintWhite(x, 110);

  const region = {
    left: 25,
    top: 20,
    right: 175,
    bottom: 125,
    width: 150,
    height: 105,
    fontSize: 20,
    strokePx: 0,
    textRgb: [255, 255, 255],
    strokeRgb: [0, 0, 0],
    backgroundRgb: [0, 0, 0],
    backgroundComplex: true,
    regionKind: "sfx",
    orientation: "horizontal"
  };

  const result = removeOriginalText(pixels, width, height, channels, region);

  assert.ok(result.removedPixels > 2000, "대형 흰색 효과음 획을 충분히 제거해야 한다");
  assert.ok(pixels[(45 * width + 60) * channels] < 40, "효과음 중심이 검은 배경으로 복원되어야 한다");
  assert.equal(pixels[(110 * width + 100) * channels], 255, "패널 전체를 가로지르는 흰 광선은 유지해야 한다");
});
