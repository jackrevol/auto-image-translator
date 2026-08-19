"use strict";

const sharp = require("sharp");

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

async function renderRegionAtlases({ imagePath, regions, renderAtlas, onProgress = null, maximumTiles = 4 }) {
  if (typeof renderAtlas !== "function") throw new TypeError("renderAtlas 콜백이 필요합니다.");
  let working = await sharp(imagePath).autoOrient().png().toBuffer();
  const metadata = await sharp(working).metadata();
  if (!metadata.width || !metadata.height) throw new Error("영역 재조립용 이미지 크기를 읽지 못했습니다.");
  const crops = planRegionCrops(regions, metadata.width, metadata.height);
  const batches = [];
  for (let index = 0; index < crops.length; index += Math.max(1, maximumTiles)) {
    batches.push(crops.slice(index, index + Math.max(1, maximumTiles)));
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const atlas = await createCropAtlas(working, batch);
    if (onProgress) onProgress({
      phase: "atlas",
      index: batchIndex + 1,
      total: batches.length,
      cropCount: batch.length,
      atlas
    });
    const rendered = await renderAtlas({
      input: atlas.buffer,
      regions: atlas.regions,
      tiles: atlas.tiles,
      index: batchIndex + 1,
      total: batches.length
    });
    const normalizedAtlas = await sharp(rendered)
      .autoOrient()
      .resize(atlas.width, atlas.height, { fit: "fill" })
      .png()
      .toBuffer();

    for (const tile of atlas.tiles) {
      const renderedTile = await sharp(normalizedAtlas)
        .extract({ left: tile.left, top: tile.top, width: tile.width, height: tile.height })
        .resize(tile.originalWidth, tile.originalHeight, { fit: "fill" })
        .png()
        .toBuffer();
      const maskedTile = await maskRenderedTile(renderedTile, tile.crop);
      working = await sharp(working)
        .composite([{ input: maskedTile, left: tile.crop.box.left, top: tile.crop.box.top }])
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
  const borderSvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}">`,
    ...layout.tiles.map((tile) =>
      `<rect x="${tile.left - 2}" y="${tile.top - 2}" width="${tile.width + 4}" height="${tile.height + 4}" fill="none" stroke="#555" stroke-width="4"/>`
    ),
    "</svg>"
  ].join("");
  composites.push({ input: Buffer.from(borderSvg, "utf8"), left: 0, top: 0 });
  return {
    ...layout,
    buffer: await sharp({
      create: { width: layout.width, height: layout.height, channels: 3, background: "#d8d8d8" }
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

async function maskRenderedTile(renderedTile, crop) {
  const width = crop.box.right - crop.box.left;
  const height = crop.box.bottom - crop.box.top;
  const rectangles = crop.regions.map((region) => {
    const boxes = [region.box, region.layoutBox]
      .filter((value) => Array.isArray(value) && value.length === 4)
      .map((value) => normalizedBoxToPixels(value, width, height))
      .filter(Boolean);
    const target = unionBoxes(boxes);
    if (!target) return "";
    const fontPixels = (Number(region.fontSize) || 0) / 1000 * height;
    const padding = Math.max(8, Math.round(fontPixels * 0.6));
    const left = Math.max(0, target.left - padding);
    const top = Math.max(0, target.top - padding);
    const right = Math.min(width, target.right + padding);
    const bottom = Math.min(height, target.bottom + padding);
    return `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="${Math.min(12, padding)}" fill="white"/>`;
  }).join("");
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/>${rectangles}</svg>`,
    "utf8"
  );
  return sharp(renderedTile).removeAlpha().joinChannel(mask).png().toBuffer();
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
  layoutCropAtlas,
  remapRegionToCrop
};
