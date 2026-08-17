"use strict";

const sharp = require("sharp");

async function renderTranslatedImage(imagePath, regions) {
  const decoded = await sharp(imagePath)
    .autoOrient()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  const pixels = Buffer.from(decoded.data);
  const normalizedRegions = deduplicateRegions(
    regions.map((region) => normalizeRegion(region, width, height)).filter(Boolean)
  );

  for (const region of normalizedRegions) {
    removeOriginalText(pixels, width, height, channels, region);
  }

  const cleaned = sharp(pixels, { raw: { width, height, channels } });
  const svg = createTextSvg(width, height, normalizedRegions);
  return cleaned
    .composite([{ input: Buffer.from(svg, "utf8"), top: 0, left: 0 }])
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
}

function normalizeRegion(region, width, height) {
  if (!Array.isArray(region?.box) || region.box.length !== 4 || !String(region.translated || "").trim()) {
    return null;
  }
  const removalBox = normalizedBoxToPixels(region.box, width, height);
  if (!removalBox) return null;
  const detectedLayoutBox = normalizedBoxToPixels(region.layoutBox, width, height);
  const normalizedKind = ["dialogue", "narration", "sfx", "label"].includes(region.regionKind)
    ? region.regionKind
    : region.backgroundComplex ? "label" : "dialogue";
  const removalArea = (removalBox.right - removalBox.left) * (removalBox.bottom - removalBox.top);
  const layoutArea = detectedLayoutBox
    ? (detectedLayoutBox.right - detectedLayoutBox.left) * (detectedLayoutBox.bottom - detectedLayoutBox.top)
    : 0;
  const layoutTooSmall =
    detectedLayoutBox &&
    ["dialogue", "narration"].includes(normalizedKind) &&
    layoutArea < removalArea * 0.68;
  const layoutBox = !detectedLayoutBox || layoutTooSmall ? removalBox : detectedLayoutBox;
  const { top, left, bottom, right } = removalBox;

  const fontSize = clamp((Number(region.fontSize) || (bottom - top) / height * 820) / 1000 * height, 7, 240);
  return {
    ...region,
    translated: String(region.translated).trim(),
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    hasLayoutBox: Boolean(detectedLayoutBox && !layoutTooSmall),
    layoutLeft: layoutBox.left,
    layoutTop: layoutBox.top,
    layoutRight: layoutBox.right,
    layoutBottom: layoutBox.bottom,
    layoutWidth: layoutBox.right - layoutBox.left,
    layoutHeight: layoutBox.bottom - layoutBox.top,
    fontSize,
    textRgb: parseHex(region.textColor, [17, 17, 17]),
    backgroundRgb: parseHex(region.backgroundColor, [255, 255, 255]),
    strokeRgb: parseHex(region.strokeColor, parseHex(region.backgroundColor, [255, 255, 255])),
    strokePx: clamp(Number(region.strokeWidth) || 0, 0, 1000) / 1000 * height,
    rotation: clamp(Number(region.rotation) || 0, -180, 180),
    regionKind: normalizedKind
  };
}

function normalizedBoxToPixels(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const values = box.map((value) => clamp(Number(value) || 0, 0, 1000));
  const left = Math.floor(Math.min(values[0], values[2]) / 1000 * width);
  const top = Math.floor(Math.min(values[1], values[3]) / 1000 * height);
  const right = Math.ceil(Math.max(values[0], values[2]) / 1000 * width);
  const bottom = Math.ceil(Math.max(values[1], values[3]) / 1000 * height);
  return right - left >= 2 && bottom - top >= 2 ? { top, left, bottom, right } : null;
}

function removeOriginalText(pixels, imageWidth, imageHeight, channels, region) {
  const padding = Math.max(3, Math.round(region.fontSize * 0.42 + region.strokePx));
  const searchBox = getRemovalSearchBox(region);
  const left = clamp(searchBox.left - padding, 0, imageWidth - 1);
  const top = clamp(searchBox.top - padding, 0, imageHeight - 1);
  const right = clamp(searchBox.right + padding, 1, imageWidth);
  const bottom = clamp(searchBox.bottom + padding, 1, imageHeight);
  const localWidth = right - left;
  const localHeight = bottom - top;
  const mask = new Uint8Array(localWidth * localHeight);
  const lineCandidateMask = new Uint8Array(localWidth * localHeight);
  // 흰 말풍선은 글자가 테두리와 닿았다는 이유만으로 모델이 complex로 분류할 수 있습니다.
  // 이런 경우 단색 말풍선용 선 보호를 사용해야 연결된 일본어 잔상만 제거할 수 있습니다.
  const simpleDialogueSurface =
    region.regionKind === "dialogue" &&
    colorDistance(region.backgroundRgb, [255, 255, 255]) <= 35;
  const complexBackground = Boolean(region.backgroundComplex) && !simpleDialogueSurface;
  // 저해상도 웹 이미지의 작은 글자는 리사이즈 과정에서 중간 회색 획만 남기도 한다.
  // 단색 배경의 안전한 layoutBox 안에서는 이 안티앨리어싱 획까지 원문으로 취급한다.
  // 복잡 배경에서도 작은 세로 글자의 안티앨리어싱 가장자리까지 제거하되,
  // 회색 밑그림은 글자색과 충분히 멀면 마스크에 포함하지 않습니다.
  const threshold = complexBackground
    ? clamp(54 + region.fontSize * 0.75, 60, 92)
    : 300;

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const pixelIndex = (y * imageWidth + x) * channels;
      const rgb = [pixels[pixelIndex], pixels[pixelIndex + 1], pixels[pixelIndex + 2]];
      const textDistance = colorDistance(rgb, region.textRgb);
      const strokeDistance = colorDistance(rgb, region.strokeRgb);
      const backgroundDistance = colorDistance(rgb, region.backgroundRgb);
      if (!complexBackground && backgroundDistance > 10) {
        lineCandidateMask[(y - top) * localWidth + (x - left)] = 1;
      }
      const looksLikeInk =
        textDistance < threshold ||
        (region.strokePx > 0 && strokeDistance < threshold) ||
        Math.min(textDistance, strokeDistance) < backgroundDistance * 0.72;
      if (looksLikeInk) mask[(y - top) * localWidth + (x - left)] = 1;
    }
  }

  const protectedLines = findLongLineMask(
    complexBackground ? mask : lineCandidateMask,
    localWidth,
    localHeight,
    region.fontSize
  );
  for (let index = 0; index < mask.length; index += 1) {
    if (protectedLines[index]) mask[index] = 0;
  }

  const focus = {
    left: searchBox.left - left,
    top: searchBox.top - top,
    right: searchBox.right - left,
    bottom: searchBox.bottom - top
  };
  const glyphMask = keepGlyphLikeComponents(mask, localWidth, localHeight, region.fontSize, focus, region.regionKind);
  const glyphPixels = countMaskPixels(glyphMask);
  const maximumSafePixels = Math.max(1, Math.round(localWidth * localHeight * (complexBackground ? 0.22 : 0.38)));
  if (!glyphPixels || glyphPixels > maximumSafePixels) return { removedPixels: 0 };

  const localBounds = getMaskBounds(glyphMask, localWidth, localHeight);
  const cleanPadding = Math.max(2, Math.round(region.fontSize * 0.09 + region.strokePx));
  const cleanBounds = {
    left: clamp(left + localBounds.left - cleanPadding, 0, imageWidth),
    top: clamp(top + localBounds.top - cleanPadding, 0, imageHeight),
    right: clamp(left + localBounds.right + cleanPadding, 0, imageWidth),
    bottom: clamp(top + localBounds.bottom + cleanPadding, 0, imageHeight)
  };
  recenterRegionOnBounds(region, cleanBounds, imageWidth, imageHeight);

  const dilation = complexBackground
    ? Math.max(2, Math.min(4, Math.round(region.fontSize * 0.045 + region.strokePx * 0.65)))
    : Math.max(4, Math.min(7, Math.round(region.fontSize * 0.16)));
  const expandedMask = dilateMask(glyphMask, localWidth, localHeight, dilation);
  for (let index = 0; index < expandedMask.length; index += 1) {
    if (protectedLines[index]) expandedMask[index] = 0;
  }
  const removedPixels = countMaskPixels(expandedMask);
  if (complexBackground || region.regionKind === "dialogue") {
    inpaintNearest(pixels, imageWidth, channels, expandedMask, left, top, localWidth, localHeight);
  } else {
    fillMaskWithColor(pixels, imageWidth, channels, expandedMask, left, top, localWidth, localHeight, region.backgroundRgb);
  }
  return { removedPixels };
}

function getRemovalSearchBox(region) {
  if (region.regionKind === "dialogue") {
    return { left: region.left, top: region.top, right: region.right, bottom: region.bottom };
  }
  const hasSimpleLayout =
    !region.backgroundComplex &&
    Number.isFinite(region.layoutLeft) &&
    Number.isFinite(region.layoutTop) &&
    Number.isFinite(region.layoutRight) &&
    Number.isFinite(region.layoutBottom);
  if (!hasSimpleLayout) {
    return { left: region.left, top: region.top, right: region.right, bottom: region.bottom };
  }
  if (region.orientation === "vertical") {
    return {
      left: region.left,
      top: Math.min(region.top, region.layoutTop),
      right: region.right,
      bottom: Math.max(region.bottom, region.layoutBottom)
    };
  }
  return {
    left: Math.min(region.left, region.layoutLeft),
    top: region.top,
    right: Math.max(region.right, region.layoutRight),
    bottom: region.bottom
  };
}

function findLongLineMask(mask, width, height, fontSize) {
  const protectedMask = new Uint8Array(mask.length);
  const minimumHorizontalRun = Math.max(12, Math.round(fontSize * 4), Math.round(width * 0.72));
  const minimumVerticalRun = Math.max(12, Math.round(fontSize * 4), Math.round(height * 0.72));

  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const ink = x < width && mask[y * width + x];
      if (ink && start < 0) start = x;
      if ((!ink || x === width) && start >= 0) {
        if (x - start >= minimumHorizontalRun) {
          for (let lineX = start; lineX < x; lineX += 1) protectedMask[y * width + lineX] = 1;
        }
        start = -1;
      }
    }
  }

  for (let x = 0; x < width; x += 1) {
    let start = -1;
    for (let y = 0; y <= height; y += 1) {
      const ink = y < height && mask[y * width + x];
      if (ink && start < 0) start = y;
      if ((!ink || y === height) && start >= 0) {
        if (y - start >= minimumVerticalRun) {
          for (let lineY = start; lineY < y; lineY += 1) protectedMask[lineY * width + x] = 1;
        }
        start = -1;
      }
    }
  }

  return protectedMask;
}

function keepGlyphLikeComponents(mask, width, height, fontSize, focus = null, regionKind = null) {
  const output = new Uint8Array(mask.length);
  const visited = new Uint8Array(mask.length);

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start];
    const component = [];
    visited[start] = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            queue.push(neighbor);
          }
        }
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const longHorizontalLine = componentWidth > fontSize * 2.2 && componentHeight < fontSize * 0.42;
    const longVerticalLine = componentHeight > fontSize * 2.2 && componentWidth < fontSize * 0.42;
    const surroundsText = componentWidth > width * 0.68 && componentHeight > height * 0.68;
    const touchesTwoHorizontalEdges = minX === 0 && maxX === width - 1;
    const touchesTwoVerticalEdges = minY === 0 && maxY === height - 1;
    const edgeMargin = Math.max(2, fontSize * 0.35);
    const crossesHorizontalWindow =
      minX <= edgeMargin &&
      maxX >= width - 1 - edgeMargin &&
      componentWidth > fontSize * 1.7;
    const crossesVerticalWindow =
      minY <= edgeMargin &&
      maxY >= height - 1 - edgeMargin &&
      componentHeight > fontSize * 1.7;
    const tooDense = component.length > width * height * 0.42;
    const oversizedArtwork =
      componentWidth > fontSize * 2.8 &&
      componentHeight > fontSize * 2.8 &&
      component.length > fontSize * fontSize * 1.5;
    const componentDensity = component.length / Math.max(1, componentWidth * componentHeight);
    const curvedBorderStroke =
      regionKind === "dialogue" &&
      Math.max(componentWidth, componentHeight) > fontSize * 1.5 &&
      Math.min(componentWidth, componentHeight) < fontSize * 1.2 &&
      componentDensity < 0.48;
    const focusMargin = Math.max(3, fontSize * 0.55);
    const overlapsFocus = !focus || (
      maxX >= focus.left - focusMargin && minX <= focus.right + focusMargin &&
      maxY >= focus.top - focusMargin && minY <= focus.bottom + focusMargin
    );
    if (!overlapsFocus || longHorizontalLine || longVerticalLine || curvedBorderStroke || surroundsText || touchesTwoHorizontalEdges || touchesTwoVerticalEdges || crossesHorizontalWindow || crossesVerticalWindow || tooDense || oversizedArtwork) {
      continue;
    }
    for (const index of component) output[index] = 1;
  }

  return output;
}

function getMaskBounds(mask, width, height) {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return { left, top, right, bottom };
}

function recenterRegionOnBounds(region, bounds, imageWidth, imageHeight) {
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const width = Math.min(imageWidth, Math.max(region.width, bounds.right - bounds.left));
  const height = Math.min(imageHeight, Math.max(region.height, bounds.bottom - bounds.top));
  region.left = clamp(centerX - width / 2, 0, Math.max(0, imageWidth - width));
  region.top = clamp(centerY - height / 2, 0, Math.max(0, imageHeight - height));
  region.right = region.left + width;
  region.bottom = region.top + height;
  region.width = width;
  region.height = height;
  if (!region.hasLayoutBox) {
    region.layoutLeft = region.left;
    region.layoutTop = region.top;
    region.layoutRight = region.right;
    region.layoutBottom = region.bottom;
    region.layoutWidth = region.width;
    region.layoutHeight = region.height;
  }
}

function countMaskPixels(mask) {
  let count = 0;
  for (const value of mask) count += value ? 1 : 0;
  return count;
}

function deduplicateRegions(regions) {
  const kept = [];
  for (const region of regions) {
    const duplicateIndex = kept.findIndex((candidate) => regionIntersectionOverUnion(region, candidate) >= 0.72);
    if (duplicateIndex < 0) {
      kept.push(region);
      continue;
    }
    if ((Number(region.confidence) || 0) > (Number(kept[duplicateIndex].confidence) || 0)) {
      kept[duplicateIndex] = region;
    }
  }
  return kept;
}

function regionIntersectionOverUnion(a, b) {
  const intersectionWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const intersectionHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const intersection = intersectionWidth * intersectionHeight;
  if (!intersection) return 0;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function dilateMask(mask, width, height, radius) {
  const output = new Uint8Array(mask);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) output[ny * width + nx] = 1;
        }
      }
    }
  }
  return output;
}

function inpaintNearest(pixels, imageWidth, channels, mask, offsetX, offsetY, width, height) {
  const queue = [];
  const queued = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index] && hasResolvedNeighbor(mask, x, y, width, height)) {
        queue.push(index);
        queued[index] = 1;
      }
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const average = averageResolvedNeighbors(pixels, imageWidth, channels, mask, x, y, offsetX, offsetY, width, height);
    if (!average) continue;

    const pixelIndex = ((offsetY + y) * imageWidth + offsetX + x) * channels;
    for (let channel = 0; channel < Math.min(3, channels); channel += 1) pixels[pixelIndex + channel] = average[channel];
    mask[index] = 0;

    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighborIndex = ny * width + nx;
        if (mask[neighborIndex] && !queued[neighborIndex]) {
          queued[neighborIndex] = 1;
          queue.push(neighborIndex);
        }
      }
    }
  }
}

function fillMaskWithColor(pixels, imageWidth, channels, mask, offsetX, offsetY, width, height, color) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      const pixelIndex = ((offsetY + y) * imageWidth + offsetX + x) * channels;
      for (let channel = 0; channel < Math.min(3, channels); channel += 1) {
        pixels[pixelIndex + channel] = color[channel];
      }
    }
  }
}

function hasResolvedNeighbor(mask, x, y, width, height) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && !mask[ny * width + nx]) return true;
    }
  }
  return false;
}

function averageResolvedNeighbors(pixels, imageWidth, channels, mask, x, y, offsetX, offsetY, width, height) {
  const total = [0, 0, 0];
  let count = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || mask[ny * width + nx]) continue;
      const pixelIndex = ((offsetY + ny) * imageWidth + offsetX + nx) * channels;
      total[0] += pixels[pixelIndex];
      total[1] += pixels[pixelIndex + 1];
      total[2] += pixels[pixelIndex + 2];
      count += 1;
    }
  }
  return count ? total.map((value) => Math.round(value / count)) : null;
}

function createTextSvg(width, height, regions) {
  const elements = regions.map((region) => createRegionSvg(region, width, height)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements}</svg>`;
}

function createRegionSvg(region, imageWidth, imageHeight) {
  const color = rgbToHex(region.textRgb);
  const stroke = rgbToHex(region.strokeRgb);
  const strokeWidth = Math.max(0, region.strokePx).toFixed(2);
  const family = fontFamily(region.fontStyle);
  const weight = region.bold ? 700 : 400;
  const style = region.italic ? "italic" : "normal";
  const centerX = region.layoutLeft + region.layoutWidth / 2;
  const centerY = region.layoutTop + region.layoutHeight / 2;
  const transform = region.rotation ? ` transform="rotate(${region.rotation.toFixed(2)} ${centerX.toFixed(2)} ${centerY.toFixed(2)})"` : "";
  if (chooseRenderOrientation(region) === "vertical") {
    return createVerticalText(region, { family, weight, style, color, stroke, strokeWidth }, transform, imageWidth, imageHeight);
  }
  return createHorizontalText(region, { family, weight, style, color, stroke, strokeWidth }, transform, imageWidth, imageHeight);
}

function createHorizontalText(region, style, transform, imageWidth, imageHeight) {
  const fontSize = fitHorizontalFontSize(region);
  const common = textStyleAttributes(style, fontSize);
  const lineHeight = fontSize * 1.12;
  const horizontalPadding = region.layoutWidth * 0.08;
  const verticalPadding = region.layoutHeight * 0.08;
  const usableLeft = region.layoutLeft + horizontalPadding;
  const usableTop = region.layoutTop + verticalPadding;
  const usableWidth = Math.max(fontSize, region.layoutWidth - horizontalPadding * 2);
  const usableHeight = Math.max(fontSize, region.layoutHeight - verticalPadding * 2);
  const maxChars = Math.max(1, Math.floor(usableWidth / (fontSize * 1.02)));
  const lines = wrapKorean(region.translated, maxChars);
  const align = region.regionKind === "dialogue"
    ? "center"
    : ["left", "center", "right"].includes(region.align) ? region.align : "center";
  const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
  const x = align === "left" ? usableLeft : align === "right" ? usableLeft + usableWidth : usableLeft + usableWidth / 2;
  const requiredHeight = lines.length * lineHeight;
  const top = clamp(usableTop + (usableHeight - requiredHeight) / 2, 0, Math.max(0, imageHeight - requiredHeight));
  const tspans = lines.map((line, index) =>
    `<tspan x="${x.toFixed(2)}" y="${(top + fontSize + index * lineHeight).toFixed(2)}">${escapeXml(line)}</tspan>`
  ).join("");
  return `<text ${common} text-anchor="${anchor}"${transform}>${tspans}</text>`;
}

function createVerticalText(region, style, transform, imageWidth, imageHeight) {
  const chars = [...region.translated.replace(/\s+/g, "")];
  const fontSize = fitVerticalFontSize(region, chars.length);
  const common = textStyleAttributes(style, fontSize);
  const step = fontSize * 1.08;
  const horizontalPadding = region.layoutWidth * 0.08;
  const verticalPadding = region.layoutHeight * 0.08;
  const usableLeft = region.layoutLeft + horizontalPadding;
  const usableTop = region.layoutTop + verticalPadding;
  const usableWidth = Math.max(fontSize, region.layoutWidth - horizontalPadding * 2);
  const usableHeight = Math.max(fontSize, region.layoutHeight - verticalPadding * 2);
  const maxPerColumn = Math.max(1, Math.floor(usableHeight / step));
  const columns = [];
  for (let index = 0; index < chars.length; index += maxPerColumn) columns.push(chars.slice(index, index + maxPerColumn));
  const requiredWidth = columns.length * step;
  const right = clamp(usableLeft + (usableWidth + requiredWidth) / 2, requiredWidth, imageWidth);
  return columns.map((column, columnIndex) => {
    const x = right - columnIndex * step - fontSize / 2;
    const top = clamp(usableTop + (usableHeight - column.length * step) / 2, 0, Math.max(0, imageHeight - column.length * step));
    const tspans = column.map((character, index) =>
      `<tspan x="${x.toFixed(2)}" y="${(top + fontSize + index * step).toFixed(2)}">${escapeXml(character)}</tspan>`
    ).join("");
    return `<text ${common} text-anchor="middle"${transform}>${tspans}</text>`;
  }).join("");
}

function fitHorizontalFontSize(region) {
  const convertedFromVertical = region.orientation === "vertical" && chooseRenderOrientation(region) === "horizontal";
  // 세로 일본어를 가로 한국어로 바꿀 때도 충분한 공간이 있으면 원문 크기를 최대한 유지합니다.
  // 긴 번역만 아래 적합성 반복문에서 실제 layoutBox 크기에 맞춰 단계적으로 축소됩니다.
  const maximum = convertedFromVertical ? region.fontSize * 0.9 : region.fontSize;
  const usableWidth = region.layoutWidth * 0.84;
  const usableHeight = region.layoutHeight * 0.84;
  for (let fontSize = maximum; fontSize >= 7; fontSize -= 1) {
    const maxChars = Math.max(1, Math.floor(usableWidth / (fontSize * 1.02)));
    const lineCount = wrapKorean(region.translated, maxChars).length;
    if (lineCount * fontSize * 1.12 <= usableHeight) return fontSize;
  }
  return 7;
}

function fitVerticalFontSize(region, characterCount) {
  const usableWidth = region.layoutWidth * 0.84;
  const usableHeight = region.layoutHeight * 0.84;
  for (let fontSize = region.fontSize; fontSize >= 7; fontSize -= 1) {
    const perColumn = Math.max(1, Math.floor(usableHeight / (fontSize * 1.08)));
    const columns = Math.ceil(characterCount / perColumn);
    if (columns * fontSize * 1.08 <= usableWidth) return fontSize;
  }
  return 7;
}

function chooseRenderOrientation(region) {
  const containsKorean = /[가-힣]/.test(region.translated);
  const narrowVerticalDialogue =
    region.regionKind === "dialogue" &&
    Number(region.layoutWidth) < 120 &&
    Number(region.layoutHeight) >= Number(region.layoutWidth) * 1.65;
  if (containsKorean && region.orientation === "vertical" && region.regionKind !== "sfx") {
    return narrowVerticalDialogue ? "vertical" : "horizontal";
  }
  return region.orientation === "vertical" ? "vertical" : "horizontal";
}

function textStyleAttributes(style, fontSize) {
  const tinyBoldStroke = style.weight >= 700 && fontSize < 12 && style.stroke === style.color ? 0.35 : 0;
  const effectiveStrokeWidth = Math.max(Number(style.strokeWidth) || 0, tinyBoldStroke);
  return `font-family="${style.family}" font-size="${fontSize.toFixed(2)}" font-weight="${style.weight}" font-style="${style.style}" fill="${style.color}" stroke="${style.stroke}" stroke-width="${effectiveStrokeWidth.toFixed(2)}" stroke-linejoin="round" paint-order="stroke fill"`;
}

function wrapKorean(text, maxChars) {
  const paragraphs = String(text).split(/\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      const chunks = splitLongWord(word, maxChars);
      current = chunks.pop() || "";
      lines.push(...chunks);
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [""];
}

function splitLongWord(word, maxChars) {
  const characters = [...word];
  const chunks = [];
  const closingPunctuation = /^[,.!?…。，、！？：；）】』」]$/;
  while (characters.length > maxChars) {
    const chunk = characters.splice(0, maxChars);
    if (characters.length > 0 && closingPunctuation.test(characters[0])) {
      chunk.push(characters.shift());
    }
    chunks.push(chunk.join(""));
  }
  if (characters.length) chunks.push(characters.join(""));
  return chunks;
}

function fontFamily(style) {
  const families = {
    serif: "Batang, 'HCR Batang', 'Noto Serif CJK KR', serif",
    rounded: "'Malgun Gothic', Gulim, 'Noto Sans CJK KR', sans-serif",
    handwritten: "'HY엽서M', 'HY얕은샘물M', Gungsuh, Batang, cursive",
    display: "'HY헤드라인M', 'HY견고딕', 'Malgun Gothic', sans-serif",
    sans: "'Malgun Gothic', Dotum, 'Noto Sans CJK KR', sans-serif"
  };
  return families[style] || families.sans;
}

function parseHex(value, fallback) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ];
}

function rgbToHex(rgb) {
  return `#${rgb.map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  renderTranslatedImage,
  normalizeRegion,
  wrapKorean,
  deduplicateRegions,
  keepGlyphLikeComponents,
  removeOriginalText,
  recenterRegionOnBounds,
  chooseRenderOrientation,
  fitHorizontalFontSize
};
