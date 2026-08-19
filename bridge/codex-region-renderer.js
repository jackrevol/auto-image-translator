"use strict";

const crypto = require("node:crypto");
const sharp = require("sharp");
const { renderTranslatedImage } = require("./image-renderer.js");

function planRegionCrops(regions, imageWidth, imageHeight) {
  const width = Math.max(1, Math.round(Number(imageWidth) || 0));
  const height = Math.max(1, Math.round(Number(imageHeight) || 0));
  const candidates = [];
  for (const region of Array.isArray(regions) ? regions : []) {
    if (!String(region?.translated || "").trim()) continue;
    const removal = normalizedBoxToPixels(region.box, width, height);
    const layout = normalizedBoxToPixels(region.layoutBox, width, height);
    const content = unionBoxes([removal, layout].filter(Boolean));
    if (!content) continue;
    const contentWidth = content.right - content.left;
    const contentHeight = content.bottom - content.top;
    const paddingX = Math.round(clamp(
      Math.max(24, contentWidth * 0.65, contentHeight * 0.18),
      24,
      width * 0.14
    ));
    const paddingY = Math.round(clamp(
      Math.max(24, contentHeight * 0.28, contentWidth * 0.18),
      24,
      height * 0.12
    ));
    candidates.push({
      box: {
        left: Math.max(0, content.left - paddingX),
        top: Math.max(0, content.top - paddingY),
        right: Math.min(width, content.right + paddingX),
        bottom: Math.min(height, content.bottom + paddingY)
      },
      contentBox: content,
      regions: [region]
    });
  }

  const groups = [];
  for (const candidate of candidates) {
    let merged = candidate;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (!canMergeGroups(merged, groups[index], width, height)) continue;
      const existing = groups.splice(index, 1)[0];
      merged = {
        box: unionBoxes([merged.box, existing.box]),
        contentBox: unionBoxes([merged.contentBox, existing.contentBox]),
        regions: [...existing.regions, ...merged.regions]
      };
    }
    groups.push(merged);
  }

  return groups
    .sort((left, right) => left.box.top - right.box.top || left.box.left - right.box.left)
    .map((group, index) => {
      const box = integerBox(group.box, width, height);
      return {
        index: index + 1,
        box,
        regions: group.regions.map((region) => remapRegionToCrop(region, box, width, height))
      };
    });
}

function canMergeGroups(left, right, imageWidth, imageHeight) {
  if (!boxesOverlap(left.box, right.box)) return false;
  if (left.regions.length + right.regions.length > 3) return false;
  const combined = unionBoxes([left.box, right.box]);
  const combinedWidth = combined.right - combined.left;
  const combinedHeight = combined.bottom - combined.top;
  const combinedArea = combinedWidth * combinedHeight;
  if (combinedWidth > imageWidth * 0.48) return false;
  if (combinedHeight > imageHeight * 0.38) return false;
  if (combinedArea > imageWidth * imageHeight * 0.16) return false;
  return true;
}

async function renderRegionCrops({ imagePath, regions, renderCrop, onProgress = null }) {
  if (typeof renderCrop !== "function") throw new TypeError("renderCrop 콜백이 필요합니다.");
  let working = await sharp(imagePath).autoOrient().png().toBuffer();
  const metadata = await sharp(working).metadata();
  if (!metadata.width || !metadata.height) throw new Error("영역 재조립용 이미지 크기를 읽지 못했습니다.");
  const crops = planRegionCrops(regions, metadata.width, metadata.height);
  for (let index = 0; index < crops.length; index += 1) {
    const crop = crops[index];
    const width = crop.box.right - crop.box.left;
    const height = crop.box.bottom - crop.box.top;
    if (onProgress) onProgress({ phase: "crop", index: index + 1, total: crops.length, crop });
    const input = await sharp(working)
      .extract({ left: crop.box.left, top: crop.box.top, width, height })
      .png()
      .toBuffer();
    const rendered = await renderCrop({
      input,
      regions: crop.regions,
      box: crop.box,
      index: index + 1,
      total: crops.length
    });
    const normalized = await sharp(rendered)
      .autoOrient()
      .resize(width, height, { fit: "fill" })
      .png()
      .toBuffer();
    working = await sharp(working)
      .composite([{ input: normalized, left: crop.box.left, top: crop.box.top }])
      .png()
      .toBuffer();
    if (onProgress) onProgress({ phase: "composite", index: index + 1, total: crops.length, crop });
  }
  return {
    buffer: await sharp(working).webp({ lossless: true, effort: 4 }).toBuffer(),
    cropCount: crops.length
  };
}

async function renderRegionAtlases({
  imagePath,
  regions,
  renderAtlas,
  onProgress = null,
  maximumTiles = 4,
  renderCache = null,
  bypassRenderCache = false
}) {
  if (typeof renderAtlas !== "function") throw new TypeError("renderAtlas 콜백이 필요합니다.");
  let working = await sharp(imagePath).autoOrient().png().toBuffer();
  const metadata = await sharp(working).metadata();
  if (!metadata.width || !metadata.height) throw new Error("영역 재조립용 이미지 크기를 읽지 못했습니다.");
  const crops = planRegionCrops(regions, metadata.width, metadata.height);
  const batches = planAtlasBatches(crops, maximumTiles);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const atlas = await createCropAtlas(working, batch);
    const cacheKey = createAtlasRenderCacheKey(atlas.buffer, atlas.regions);
    let rendered;
    if (!bypassRenderCache && renderCache?.has(cacheKey)) {
      rendered = renderCache.get(cacheKey);
      if (onProgress) onProgress({
        phase: "cache",
        index: batchIndex + 1,
        total: batches.length,
        cropCount: batch.length,
        atlas
      });
    } else {
      if (onProgress) onProgress({
        phase: "atlas",
        index: batchIndex + 1,
        total: batches.length,
        cropCount: batch.length,
        atlas
      });
      rendered = await renderAtlas({
        input: atlas.buffer,
        regions: atlas.regions,
        tiles: atlas.tiles,
        index: batchIndex + 1,
        total: batches.length
      });
      renderCache?.set(cacheKey, rendered);
    }
    const normalizedAtlas = await sharp(rendered)
      .autoOrient()
      .resize(atlas.width, atlas.height, { fit: "fill" })
      .png()
      .toBuffer();

    for (const tile of atlas.tiles) {
      const originalTile = await sharp(working)
        .extract({
          left: tile.crop.box.left,
          top: tile.crop.box.top,
          width: tile.originalWidth,
          height: tile.originalHeight
        })
        .png()
        .toBuffer();
      const renderedTile = await sharp(normalizedAtlas)
        .extract({ left: tile.left, top: tile.top, width: tile.width, height: tile.height })
        .resize(tile.originalWidth, tile.originalHeight, { fit: "fill" })
        .png()
        .toBuffer();
      const rebuiltTile = await rebuildRenderedTile(originalTile, renderedTile, tile.crop);
      working = await sharp(working)
        .composite([{ input: rebuiltTile, left: tile.crop.box.left, top: tile.crop.box.top }])
        .png()
        .toBuffer();
    }
    if (onProgress) onProgress({
      phase: "composite",
      index: batchIndex + 1,
      total: batches.length,
      cropCount: batch.length,
      atlas
    });
  }

  return {
    buffer: await sharp(working).webp({ lossless: true, effort: 4 }).toBuffer(),
    cropCount: crops.length,
    atlasCount: batches.length
  };
}

function planAtlasBatches(crops, maximumTiles = 4, maximumDimension = 4096) {
  const limit = Math.max(1, Number(maximumTiles) || 1);
  const batches = [];
  let current = [];
  for (const crop of crops) {
    const candidate = [...current, crop];
    const layout = layoutCropAtlas(candidate, maximumDimension);
    if (current.length > 0 && (candidate.length > limit || layout.scale < 1)) {
      batches.push(current);
      current = [crop];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function createRegionRenderSignature(regions) {
  return crypto
    .createHash("sha256")
    .update(stableSerialize(Array.isArray(regions) ? regions : []), "utf8")
    .digest("hex");
}

function createAtlasRenderCacheKey(input, regions) {
  const hash = crypto.createHash("sha256");
  hash.update(input);
  hash.update(createRegionRenderSignature(regions), "utf8");
  return hash.digest("hex");
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function createCropAtlas(working, crops) {
  const layout = layoutCropAtlas(crops);
  const composites = [];
  for (const tile of layout.tiles) {
    const cropBuffer = await sharp(working)
      .extract({
        left: tile.crop.box.left,
        top: tile.crop.box.top,
        width: tile.originalWidth,
        height: tile.originalHeight
      })
      .resize(tile.width, tile.height, { fit: "fill" })
      .png()
      .toBuffer();
    composites.push({ input: cropBuffer, left: tile.left, top: tile.top });
  }
  return {
    ...layout,
    buffer: await sharp({
      create: { width: layout.width, height: layout.height, channels: 3, background: "#b8b8b8" }
    }).composite(composites).png().toBuffer()
  };
}

function layoutCropAtlas(crops, maximumDimension = 4096) {
  const count = Math.max(1, crops.length);
  const columns = count === 1 ? 1 : 2;
  const rows = Math.ceil(count / columns);
  const gutter = 32;
  const sourceWidths = crops.map((crop) => crop.box.right - crop.box.left);
  const sourceHeights = crops.map((crop) => crop.box.bottom - crop.box.top);
  const maximumWidth = Math.max(1, ...sourceWidths);
  const maximumHeight = Math.max(1, ...sourceHeights);
  const rawWidth = maximumWidth * columns + gutter * (columns + 1);
  const rawHeight = maximumHeight * rows + gutter * (rows + 1);
  const scale = Math.min(1, maximumDimension / rawWidth, maximumDimension / rawHeight);
  const cellWidth = Math.max(1, Math.round(maximumWidth * scale));
  const cellHeight = Math.max(1, Math.round(maximumHeight * scale));
  const scaledGutter = Math.max(12, Math.round(gutter * scale));
  const width = cellWidth * columns + scaledGutter * (columns + 1);
  const height = cellHeight * rows + scaledGutter * (rows + 1);
  const tiles = crops.map((crop, index) => {
    const originalWidth = crop.box.right - crop.box.left;
    const originalHeight = crop.box.bottom - crop.box.top;
    const tileWidth = Math.max(1, Math.round(originalWidth * scale));
    const tileHeight = Math.max(1, Math.round(originalHeight * scale));
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      crop,
      originalWidth,
      originalHeight,
      width: tileWidth,
      height: tileHeight,
      left: scaledGutter + column * (cellWidth + scaledGutter) + Math.floor((cellWidth - tileWidth) / 2),
      top: scaledGutter + row * (cellHeight + scaledGutter) + Math.floor((cellHeight - tileHeight) / 2)
    };
  });
  const atlas = { width, height, tiles };
  return {
    ...atlas,
    scale,
    regions: tiles.flatMap((tile) => tile.crop.regions.map((region) => mapRegionToAtlas(region, tile, atlas)))
  };
}

function mapRegionToAtlas(region, tile, atlas) {
  const mapBox = (value) => {
    if (!Array.isArray(value) || value.length !== 4) return value;
    return [
      (tile.left + Number(value[0]) / 1000 * tile.width) / atlas.width * 1000,
      (tile.top + Number(value[1]) / 1000 * tile.height) / atlas.height * 1000,
      (tile.left + Number(value[2]) / 1000 * tile.width) / atlas.width * 1000,
      (tile.top + Number(value[3]) / 1000 * tile.height) / atlas.height * 1000
    ].map((item) => Math.round(clamp(item, 0, 1000) * 10) / 10);
  };
  const fontScale = tile.height / atlas.height;
  return {
    ...region,
    box: mapBox(region.box),
    layoutBox: mapBox(region.layoutBox),
    fontSize: Math.round(clamp((Number(region.fontSize) || 0) * fontScale, 0, 1000) * 10) / 10,
    strokeWidth: Math.round(clamp((Number(region.strokeWidth) || 0) * fontScale, 0, 1000) * 10) / 10
  };
}

async function rebuildRenderedTile(originalTile, renderedTile, crop) {
  const width = crop.box.right - crop.box.left;
  const height = crop.box.bottom - crop.box.top;
  const cleanedTile = await renderTranslatedImage(originalTile, crop.regions, {
    drawText: false,
    outputFormat: "png"
  });
  const textLayer = await extractGeneratedTextLayer(cleanedTile, renderedTile, crop.regions, width, height);
  if (!textLayer) {
    return renderTranslatedImage(originalTile, crop.regions, { outputFormat: "png" });
  }
  return sharp(cleanedTile).composite([{ input: textLayer, left: 0, top: 0 }]).png().toBuffer();
}

async function extractGeneratedTextLayer(cleanedTile, renderedTile, regions, width, height) {
  const [cleaned, generated] = await Promise.all([
    sharp(cleanedTile).ensureAlpha().raw().toBuffer(),
    sharp(renderedTile).ensureAlpha().raw().toBuffer()
  ]);
  const layer = Buffer.alloc(width * height * 4);
  const targets = regions.map((region) => {
    const layout = normalizedBoxToPixels(region.layoutBox || region.box, width, height);
    if (!layout) return null;
    const fontPixels = (Number(region.fontSize) || 0) / 1000 * height;
    const padding = Math.max(2, Math.round(fontPixels * 0.12));
    return {
      box: {
        left: Math.max(0, layout.left - padding),
        top: Math.max(0, layout.top - padding),
        right: Math.min(width, layout.right + padding),
        bottom: Math.min(height, layout.bottom + padding)
      },
      textRgb: parseHexColor(region.textColor, [17, 17, 17]),
      strokeRgb: parseHexColor(region.strokeColor, [255, 255, 255]),
      useStroke: (Number(region.strokeWidth) || 0) > 0,
      minimumPixels: Math.max(
        8,
        Math.round(
          [...String(region.translated || "").replace(/\s+/g, "")].length
          * Math.max(8, fontPixels * 0.35)
        )
      )
    };
  }).filter(Boolean);
  let selectedPixels = 0;
  for (const target of targets) {
    for (let y = target.box.top; y < target.box.bottom; y += 1) {
      for (let x = target.box.left; x < target.box.right; x += 1) {
        const index = (y * width + x) * 4;
        const generatedRgb = [generated[index], generated[index + 1], generated[index + 2]];
        const cleanedRgb = [cleaned[index], cleaned[index + 1], cleaned[index + 2]];
        const changed = colorDistance(generatedRgb, cleanedRgb) >= 24;
        const textLike = colorDistance(generatedRgb, target.textRgb) <= 155;
        const strokeLike = target.useStroke
          && colorDistance(target.textRgb, target.strokeRgb) >= 50
          && colorDistance(generatedRgb, target.strokeRgb) <= 105;
        if (!changed || (!textLike && !strokeLike)) continue;
        layer[index] = generated[index];
        layer[index + 1] = generated[index + 1];
        layer[index + 2] = generated[index + 2];
        layer[index + 3] = generated[index + 3];
        selectedPixels += 1;
      }
    }
  }
  const minimumPixels = Math.max(12, targets.reduce((sum, target) => sum + target.minimumPixels, 0));
  return selectedPixels >= minimumPixels ? sharp(layer, { raw: { width, height, channels: 4 } }).png().toBuffer() : null;
}

function parseHexColor(value, fallback) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ];
}

function colorDistance(left, right) {
  return Math.sqrt(
    (left[0] - right[0]) ** 2
    + (left[1] - right[1]) ** 2
    + (left[2] - right[2]) ** 2
  );
}

function remapRegionToCrop(region, crop, imageWidth, imageHeight) {
  const cropHeight = Math.max(1, crop.bottom - crop.top);
  const scaleToCrop = imageHeight / cropHeight;
  return {
    ...region,
    box: remapBox(region.box, crop, imageWidth, imageHeight),
    layoutBox: remapBox(region.layoutBox, crop, imageWidth, imageHeight),
    fontSize: Math.round(clamp((Number(region.fontSize) || 0) * scaleToCrop, 0, 1000) * 10) / 10,
    strokeWidth: Math.round(clamp((Number(region.strokeWidth) || 0) * scaleToCrop, 0, 1000) * 10) / 10
  };
}

function remapBox(value, crop, imageWidth, imageHeight) {
  if (!Array.isArray(value) || value.length !== 4) return value;
  const cropWidth = Math.max(1, crop.right - crop.left);
  const cropHeight = Math.max(1, crop.bottom - crop.top);
  const x1 = Number(value[0]) / 1000 * imageWidth;
  const y1 = Number(value[1]) / 1000 * imageHeight;
  const x2 = Number(value[2]) / 1000 * imageWidth;
  const y2 = Number(value[3]) / 1000 * imageHeight;
  return [
    clamp((x1 - crop.left) / cropWidth * 1000, 0, 1000),
    clamp((y1 - crop.top) / cropHeight * 1000, 0, 1000),
    clamp((x2 - crop.left) / cropWidth * 1000, 0, 1000),
    clamp((y2 - crop.top) / cropHeight * 1000, 0, 1000)
  ].map((item) => Math.round(item * 10) / 10);
}

function normalizedBoxToPixels(value, width, height) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const coordinates = value.map((item) => clamp(Number(item) || 0, 0, 1000));
  const left = Math.floor(Math.min(coordinates[0], coordinates[2]) / 1000 * width);
  const top = Math.floor(Math.min(coordinates[1], coordinates[3]) / 1000 * height);
  const right = Math.ceil(Math.max(coordinates[0], coordinates[2]) / 1000 * width);
  const bottom = Math.ceil(Math.max(coordinates[1], coordinates[3]) / 1000 * height);
  return right - left >= 2 && bottom - top >= 2 ? { left, top, right, bottom } : null;
}

function boxesOverlap(left, right) {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function unionBoxes(boxes) {
  if (!boxes.length) return null;
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom))
  };
}

function integerBox(box, width, height) {
  return {
    left: clamp(Math.floor(box.left), 0, width - 1),
    top: clamp(Math.floor(box.top), 0, height - 1),
    right: clamp(Math.ceil(box.right), 1, width),
    bottom: clamp(Math.ceil(box.bottom), 1, height)
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

module.exports = {
  planRegionCrops,
  renderRegionCrops,
  renderRegionAtlases,
  createRegionRenderSignature,
  createAtlasRenderCacheKey,
  planAtlasBatches,
  rebuildRenderedTile,
  layoutCropAtlas,
  remapRegionToCrop
};
