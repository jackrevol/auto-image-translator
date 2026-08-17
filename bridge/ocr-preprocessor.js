"use strict";

const sharp = require("sharp");

const MAX_OCR_SIDE = 4096;
const MAX_OCR_PIXELS = 16_000_000;

async function createOcrReference(inputPath, outputPath) {
  const metadata = await sharp(inputPath, { failOn: "none" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("OCR 전처리용 이미지 크기를 읽지 못했습니다.");

  const originalWidth = metadata.autoOrient?.width || metadata.width;
  const originalHeight = metadata.autoOrient?.height || metadata.height;
  const dimensions = calculateOcrDimensions(originalWidth, originalHeight);
  const result = await sharp(inputPath, { failOn: "none" })
    .autoOrient()
    .flatten({ background: "#ffffff" })
    .resize(dimensions.width, dimensions.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3
    })
    .grayscale()
    .normalize({ lower: 1, upper: 99 })
    .sharpen({ sigma: 1.15 })
    .toColourspace("b-w")
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toFile(outputPath);

  return {
    originalWidth,
    originalHeight,
    width: result.width,
    height: result.height,
    scale: dimensions.scale
  };
}

async function createTextIsolationReference(inputPath, outputPath, targetDimensions = null) {
  const metadata = await sharp(inputPath, { failOn: "none" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("글자 분리용 이미지 크기를 읽지 못했습니다.");

  const originalWidth = metadata.autoOrient?.width || metadata.width;
  const originalHeight = metadata.autoOrient?.height || metadata.height;
  const dimensions = targetDimensions?.width && targetDimensions?.height
    ? { width: targetDimensions.width, height: targetDimensions.height }
    : calculateOcrDimensions(originalWidth, originalHeight);
  const result = await sharp(inputPath, { failOn: "none" })
    .autoOrient()
    .flatten({ background: "#ffffff" })
    .resize(dimensions.width, dimensions.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3
    })
    .grayscale()
    // 저해상도 원고의 진한 글자는 유지하고 옅은 밑그림·회색 선화는 최대한 제거합니다.
    .sharpen({ sigma: 0.75 })
    .threshold(145)
    .toColourspace("b-w")
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toFile(outputPath);

  return { width: result.width, height: result.height, threshold: 145 };
}

async function createLightTextIsolationReference(inputPath, outputPath, targetDimensions = null) {
  const metadata = await sharp(inputPath, { failOn: "none" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("밝은 글자 분리용 이미지 크기를 읽지 못했습니다.");

  const originalWidth = metadata.autoOrient?.width || metadata.width;
  const originalHeight = metadata.autoOrient?.height || metadata.height;
  const dimensions = targetDimensions?.width && targetDimensions?.height
    ? { width: targetDimensions.width, height: targetDimensions.height }
    : calculateOcrDimensions(originalWidth, originalHeight);
  const result = await sharp(inputPath, { failOn: "none" })
    .autoOrient()
    .flatten({ background: "#ffffff" })
    .resize(dimensions.width, dimensions.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3
    })
    .grayscale()
    .sharpen({ sigma: 0.75 })
    .negate()
    // 원본 밝기 205 이상만 검은 글자로 남도록 반전 밝기 50에서 자릅니다.
    .threshold(50)
    .toColourspace("b-w")
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toFile(outputPath);

  return { width: result.width, height: result.height, threshold: 205, inverted: true };
}

async function createLocalizationReference(inputPath, outputPath, targetDimensions = null) {
  const metadata = await sharp(inputPath, { failOn: "none" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("위치 판독용 이미지 크기를 읽지 못했습니다.");

  const originalWidth = metadata.autoOrient?.width || metadata.width;
  const originalHeight = metadata.autoOrient?.height || metadata.height;
  const dimensions = targetDimensions?.width && targetDimensions?.height
    ? { width: targetDimensions.width, height: targetDimensions.height }
    : calculateOcrDimensions(originalWidth, originalHeight);
  const grid = createCoordinateGridSvg(dimensions.width, dimensions.height);
  const result = await sharp(inputPath, { failOn: "none" })
    .autoOrient()
    .flatten({ background: "#ffffff" })
    .resize(dimensions.width, dimensions.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3
    })
    .composite([{ input: Buffer.from(grid, "utf8"), top: 0, left: 0 }])
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toFile(outputPath);

  return { width: result.width, height: result.height };
}

function createCoordinateGridSvg(width, height) {
  const minorWidth = Math.max(1, Math.min(width, height) / 1400);
  const majorWidth = Math.max(1.2, Math.min(width, height) / 900);
  const fontSize = Math.max(11, Math.min(26, Math.min(width, height) / 42));
  const elements = [];

  for (let value = 50; value < 1000; value += 50) {
    const x = value / 1000 * width;
    const y = value / 1000 * height;
    const major = value % 100 === 0;
    const stroke = major ? "#00d8ff" : "#ff2bd6";
    const opacity = major ? 0.42 : 0.2;
    const strokeWidth = major ? majorWidth : minorWidth;
    elements.push(`<line x1="${x.toFixed(2)}" y1="0" x2="${x.toFixed(2)}" y2="${height}" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${strokeWidth.toFixed(2)}"/>`);
    elements.push(`<line x1="0" y1="${y.toFixed(2)}" x2="${width}" y2="${y.toFixed(2)}" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${strokeWidth.toFixed(2)}"/>`);
    if (major) {
      elements.push(`<text x="${Math.min(width - fontSize * 3, x + 3).toFixed(2)}" y="${(fontSize + 2).toFixed(2)}" font-family="Arial,sans-serif" font-size="${fontSize.toFixed(2)}" font-weight="700" fill="#0055ff" stroke="#ffffff" stroke-width="2" paint-order="stroke fill">X${value}</text>`);
      elements.push(`<text x="3" y="${Math.max(fontSize, y - 3).toFixed(2)}" font-family="Arial,sans-serif" font-size="${fontSize.toFixed(2)}" font-weight="700" fill="#0055ff" stroke="#ffffff" stroke-width="2" paint-order="stroke fill">Y${value}</text>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements.join("")}</svg>`;
}

function calculateOcrDimensions(width, height) {
  const safeWidth = Math.max(1, Math.round(Number(width) || 1));
  const safeHeight = Math.max(1, Math.round(Number(height) || 1));
  const longSide = Math.max(safeWidth, safeHeight);
  let desiredScale = 1;

  if (longSide < 1000) desiredScale = Math.min(4, 1600 / longSide);
  else if (longSide < 1800) desiredScale = 2400 / longSide;
  else if (longSide < 2600) desiredScale = 1.35;

  const sideLimit = MAX_OCR_SIDE / longSide;
  const pixelLimit = Math.sqrt(MAX_OCR_PIXELS / (safeWidth * safeHeight));
  const scale = Math.max(0.01, Math.min(desiredScale, sideLimit, pixelLimit));

  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
    scale
  };
}

module.exports = {
  createOcrReference,
  createTextIsolationReference,
  createLightTextIsolationReference,
  createLocalizationReference,
  createCoordinateGridSvg,
  calculateOcrDimensions
};
