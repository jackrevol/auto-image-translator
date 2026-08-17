"use strict";

const MIN_OCR_CONFIDENCE = 0.45;

function selectReliableRegions(regions, minimumConfidence = MIN_OCR_CONFIDENCE) {
  const accepted = [];
  const rejected = [];

  for (const region of Array.isArray(regions) ? regions : []) {
    const confidence = Number(region?.confidence);
    if (Number.isFinite(confidence) && confidence >= minimumConfidence) accepted.push(region);
    else rejected.push(region);
  }

  return { accepted, rejected };
}

function averageConfidence(regions) {
  const values = (Array.isArray(regions) ? regions : [])
    .map((region) => Number(region?.confidence))
    .filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

module.exports = {
  MIN_OCR_CONFIDENCE,
  selectReliableRegions,
  averageConfidence
};
