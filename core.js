(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  root.ImageTranslatorCore = core;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clamp(value, min, max) {
    const number = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
  }

  function normalizeBox(box) {
    if (!Array.isArray(box) || box.length !== 4) return null;
    const [rawLeft, rawTop, rawRight, rawBottom] = box.map((value) => clamp(value, 0, 1000));
    const left = Math.min(rawLeft, rawRight);
    const top = Math.min(rawTop, rawBottom);
    const right = Math.max(rawLeft, rawRight);
    const bottom = Math.max(rawTop, rawBottom);
    if (bottom - top < 2 || right - left < 2) return null;
    return { top, left, bottom, right };
  }

  function isHexColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
  }

  function normalizeColor(value, fallback) {
    return isHexColor(value) ? value.trim() : fallback;
  }

  function mapRegionToAnchor(regionBox, crop) {
    const box = normalizeBox(regionBox);
    if (!box || !crop) return null;
    return {
      left: crop.left + (box.left / 1000) * crop.width,
      top: crop.top + (box.top / 1000) * crop.height,
      width: ((box.right - box.left) / 1000) * crop.width,
      height: ((box.bottom - box.top) / 1000) * crop.height
    };
  }

  function regionFontRatio(region, crop) {
    const reported = clamp(region?.fontSize, 0, 1000);
    if (reported > 0) {
      return (reported / 1000) * crop.height;
    }
    const box = normalizeBox(region?.box);
    if (!box) return 0.03;
    const size = region?.orientation === "vertical" ? box.right - box.left : box.bottom - box.top;
    return Math.max(0.012, (size / 1000) * crop.height * 0.82);
  }

  return {
    clamp,
    normalizeBox,
    normalizeColor,
    mapRegionToAnchor,
    regionFontRatio
  };
});
