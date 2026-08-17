"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const {
  createOcrReference,
  createTextIsolationReference,
  createLightTextIsolationReference,
  createLocalizationReference,
  createCoordinateGridSvg,
  calculateOcrDimensions
} = require("../bridge/ocr-preprocessor.js");

test("저해상도 이미지는 OCR을 위해 확대한다", () => {
  assert.deepEqual(calculateOcrDimensions(640, 360), {
    width: 1600,
    height: 900,
    scale: 2.5
  });
});

test("글자 분리본은 검은 세로 글자를 남기고 옅은 회색 선화를 제거한다", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-isolation-test-"));
  const inputPath = path.join(tempDir, "input.png");
  const outputPath = path.join(tempDir, "isolated.png");
  try {
    await sharp({
      create: { width: 120, height: 100, channels: 3, background: "#ffffff" }
    }).composite([{
      input: Buffer.from(
        '<svg width="120" height="100"><line x1="5" y1="80" x2="115" y2="20" stroke="#bdbdbd" stroke-width="3"/><rect x="56" y="25" width="8" height="50" fill="#202020"/></svg>',
        "utf8"
      )
    }]).png().toFile(inputPath);

    const result = await createTextIsolationReference(inputPath, outputPath, { width: 120, height: 100 });
    const decoded = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
    const textPixel = decoded.data[(50 * decoded.info.width + 60) * decoded.info.channels];
    const sketchPixel = decoded.data[(60 * decoded.info.width + 42) * decoded.info.channels];

    assert.equal(result.threshold, 145);
    assert.ok(textPixel < 20, "진한 세로 글자는 검은색으로 남아야 한다");
    assert.ok(sketchPixel > 235, "옅은 회색 선화는 흰색으로 제거되어야 한다");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("밝은 글자 반전본은 검은 배경의 흰 글자를 검은색으로 반전한다", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-light-isolation-test-"));
  const inputPath = path.join(tempDir, "input.png");
  const outputPath = path.join(tempDir, "light-isolated.png");
  try {
    await sharp({
      create: { width: 120, height: 100, channels: 3, background: "#050505" }
    }).composite([{
      input: Buffer.from(
        '<svg width="120" height="100"><rect x="54" y="20" width="12" height="60" fill="#ffffff"/><line x1="5" y1="90" x2="115" y2="10" stroke="#777777" stroke-width="2"/></svg>',
        "utf8"
      )
    }]).png().toFile(inputPath);

    const result = await createLightTextIsolationReference(inputPath, outputPath, { width: 120, height: 100 });
    const decoded = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
    const textPixel = decoded.data[(50 * decoded.info.width + 60) * decoded.info.channels];
    const backgroundPixel = decoded.data[(10 * decoded.info.width + 10) * decoded.info.channels];

    assert.equal(result.threshold, 205);
    assert.equal(result.inverted, true);
    assert.ok(textPixel < 20, "흰 글자는 검은색으로 반전되어야 한다");
    assert.ok(backgroundPixel > 235, "검은 배경은 흰색으로 반전되어야 한다");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("위치 기준본에 0~1000 좌표 격자와 라벨을 생성한다", () => {
  const svg = createCoordinateGridSvg(1000, 800);
  assert.match(svg, /X500/);
  assert.match(svg, /Y500/);
  assert.match(svg, /x1="500\.00"/);
  assert.match(svg, /y1="400\.00"/);
});

test("위치 기준본은 OCR 강화본과 같은 크기로 생성한다", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-locator-test-"));
  const inputPath = path.join(tempDir, "input.png");
  const outputPath = path.join(tempDir, "locator.png");
  try {
    await sharp({
      create: { width: 320, height: 180, channels: 3, background: "#d0d0d0" }
    }).png().toFile(inputPath);
    const result = await createLocalizationReference(inputPath, outputPath, { width: 1280, height: 720 });
    const metadata = await sharp(outputPath).metadata();

    assert.deepEqual(result, { width: 1280, height: 720 });
    assert.equal(metadata.format, "png");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("고해상도 이미지는 불필요하게 확대하지 않는다", () => {
  assert.deepEqual(calculateOcrDimensions(3000, 2000), {
    width: 3000,
    height: 2000,
    scale: 1
  });
});

test("OCR 강화본을 확대된 무손실 PNG로 만든다", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-ocr-test-"));
  const inputPath = path.join(tempDir, "input.jpg");
  const outputPath = path.join(tempDir, "enhanced.png");

  try {
    await sharp({
      create: { width: 320, height: 180, channels: 3, background: "#d0d0d0" }
    }).jpeg({ quality: 45 }).toFile(inputPath);

    const result = await createOcrReference(inputPath, outputPath);
    const metadata = await sharp(outputPath).metadata();

    assert.equal(result.width, 1280);
    assert.equal(result.height, 720);
    assert.equal(result.scale, 4);
    assert.equal(metadata.format, "png");
    assert.equal(metadata.space, "b-w");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
