"use strict";

const path = require("node:path");
const sharp = require("sharp");

const MAX_OCR_SIDE = 4096;
const MAX_OCR_PIXELS = 16_000_000;
const LIGHT_DETAIL_ANALYSIS_SIDE = 1200;
const LIGHT_DETAIL_OUTPUT_SIDE = 2200;
const MAX_LIGHT_DETAIL_REFERENCES = 4;

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

async function createLightTextDetailReferences(inputPath, outputDirectory, options = {}) {
  const metadata = await sharp(inputPath, { failOn: "none" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("밝은 글자 상세 분석용 이미지 크기를 읽지 못했습니다.");

  const originalWidth = metadata.autoOrient?.width || metadata.width;
  const originalHeight = metadata.autoOrient?.height || metadata.height;
  const maxReferences = Math.max(
    1,
    Math.min(MAX_LIGHT_DETAIL_REFERENCES, Math.round(Number(options.maxReferences) || MAX_LIGHT_DETAIL_REFERENCES))
  );
  const analysis = await sharp(inputPath, { failOn: "none" })
    .autoOrient()
    .flatten({ background: "#ffffff" })
    .resize({
      width: LIGHT_DETAIL_ANALYSIS_SIDE,
      height: LIGHT_DETAIL_ANALYSIS_SIDE,
      fit: "inside",
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3
    })
    .grayscale()
    // 축소 분석 단계에서 망점과 평행 해칭을 먼저 눌러 패널 점수가 그림의 고주파 무늬에 끌리지 않게 합니다.
    .median(3)
    .blur(1)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const candidates = scoreLightTextTiles(analysis.data, analysis.info, maxReferences);
  const references = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const crop = mapAnalysisBoxToOriginal(candidate.box, analysis.info, originalWidth, originalHeight);
    const outputPath = path.join(outputDirectory, `light-text-detail-${index + 1}.png`);
    const result = await sharp(inputPath, { failOn: "none" })
      .autoOrient()
      .flatten({ background: "#ffffff" })
      .extract(crop)
      .resize({
        width: LIGHT_DETAIL_OUTPUT_SIDE,
        height: LIGHT_DETAIL_OUTPUT_SIDE,
        fit: "inside",
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      // 망점과 1~2px 비산물을 먼저 약화해 굵은 흰색 효과음의 중심 획을 강조합니다.
      .median(5)
      .blur(1.1)
      .negate()
      .threshold(48)
      .toColourspace("b-w")
      .png({ compressionLevel: 6, adaptiveFiltering: true })
      .toFile(outputPath);
    references.push({
      path: outputPath,
      width: result.width,
      height: result.height,
      box: originalBoxToNormalized(crop, originalWidth, originalHeight),
      score: candidate.score,
      darkRatio: candidate.darkRatio,
      brightRatio: candidate.brightRatio,
      transitionRatio: candidate.transitionRatio
    });
  }

  return references;
}

function scoreLightTextTiles(data, info, maxReferences = MAX_LIGHT_DETAIL_REFERENCES) {
  const columns = info.width >= info.height ? 3 : 2;
  const rows = Math.max(2, Math.ceil(info.height / Math.max(1, info.width / columns)));
  const candidates = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const coreLeft = Math.floor(column * info.width / columns);
      const coreTop = Math.floor(row * info.height / rows);
      const coreRight = Math.floor((column + 1) * info.width / columns);
      const coreBottom = Math.floor((row + 1) * info.height / rows);
      const stats = lightTileStatistics(data, info, coreLeft, coreTop, coreRight, coreBottom);
      if (stats.darkRatio < 0.24 || stats.brightRatio < 0.012 || stats.transitionRatio < 0.003) continue;
      const contrastBalance = Math.min(stats.darkRatio, 0.72) * Math.min(stats.brightRatio, 0.38);
      const edgeBonus = 1 + Math.min(2.5, stats.transitionRatio * 18);
      const score = contrastBalance * edgeBonus;
      const paddingX = Math.round((coreRight - coreLeft) * 0.08);
      const paddingY = Math.round((coreBottom - coreTop) * 0.08);
      candidates.push({
        box: {
          left: Math.max(0, coreLeft - paddingX),
          top: Math.max(0, coreTop - paddingY),
          right: Math.min(info.width, coreRight + paddingX),
          bottom: Math.min(info.height, coreBottom + paddingY)
        },
        score,
        ...stats
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxReferences));
}

function lightTileStatistics(data, info, left, top, right, bottom) {
  let dark = 0;
  let bright = 0;
  let transitions = 0;
  let comparisons = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const value = data[(y * info.width + x) * info.channels];
      if (value < 50) dark += 1;
      if (value > 205) bright += 1;
      if (x > left) {
        const previous = data[(y * info.width + x - 1) * info.channels];
        transitions += (value > 205) !== (previous > 205) ? 1 : 0;
        comparisons += 1;
      }
      if (y > top) {
        const previous = data[((y - 1) * info.width + x) * info.channels];
        transitions += (value > 205) !== (previous > 205) ? 1 : 0;
        comparisons += 1;
      }
      total += 1;
    }
  }
  return {
    darkRatio: dark / Math.max(1, total),
    brightRatio: bright / Math.max(1, total),
    transitionRatio: transitions / Math.max(1, comparisons)
  };
}

function mapAnalysisBoxToOriginal(box, info, originalWidth, originalHeight) {
  const left = Math.floor(box.left / info.width * originalWidth);
  const top = Math.floor(box.top / info.height * originalHeight);
  const right = Math.ceil(box.right / info.width * originalWidth);
  const bottom = Math.ceil(box.bottom / info.height * originalHeight);
  return {
    left: Math.max(0, Math.min(originalWidth - 1, left)),
    top: Math.max(0, Math.min(originalHeight - 1, top)),
    width: Math.max(1, Math.min(originalWidth, right) - Math.max(0, left)),
    height: Math.max(1, Math.min(originalHeight, bottom) - Math.max(0, top))
  };
}

function originalBoxToNormalized(box, width, height) {
  return [
    Math.round(box.left / width * 1000),
    Math.round(box.top / height * 1000),
    Math.round((box.left + box.width) / width * 1000),
    Math.round((box.top + box.height) / height * 1000)
  ];
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
  createLightTextDetailReferences,
  createLocalizationReference,
  createCoordinateGridSvg,
  calculateOcrDimensions
};
