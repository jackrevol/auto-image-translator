"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

function buildCodexImageRenderPrompt(regions, options = {}) {
  const attempt = Math.max(1, Number(options.attempt) || 1);
  const issues = Array.isArray(options.issues) ? options.issues.filter(Boolean) : [];
  const regionLines = regions.map((region, index) => [
    `${index + 1}. 원문 "${singleLine(region.original)}" → 정확한 한국어 "${singleLine(region.translated)}"`,
    `   종류=${region.regionKind || "dialogue"}, 원문영역=[${formatBox(region.box)}], 조판영역=[${formatBox(region.layoutBox)}],`,
    `   방향=${region.orientation || "horizontal"}, 글자크기=${Number(region.fontSize) || 0}, 색=${region.textColor || "#111111"}, 외곽선=${region.strokeColor || "#ffffff"}/${Number(region.strokeWidth) || 0}`
  ].join("\n")).join("\n");
  const issueBlock = issues.length
    ? `\n이전 검수에서 발견된 문제를 반드시 바로잡아라:\n${issues.map((issue) => `- ${singleLine(issue)}`).join("\n")}`
    : "";

  return [
    "내장 image_gen 도구를 사용해 첫 번째 첨부 이미지를 직접 편집하라.",
    "Use case: text-localization.",
    `Codex 이미지 렌더 ${attempt}회차다.`,
    "목표는 일본어 원문만 섬세하게 제거하고 아래의 정확한 한국어로 교체한 완성 이미지를 만드는 것이다.",
    "원본의 인물, 얼굴, 신체, 의상, 배경, 패널선, 말풍선 테두리, 효과선, 망점, 색상, 명암, 구도와 그림체는 픽셀 수준으로 최대한 보존하라.",
    "장면을 새로 그리거나 인물의 형태·표정·자세를 바꾸지 마라. 일본어가 없는 영역은 수정하지 마라.",
    "원문 글자는 잔상이나 겹침 없이 제거하되 뒤의 말풍선·선화·망점을 자연스럽게 복원하라.",
    "한국어는 아래 번역을 글자 하나까지 그대로 사용하고 임의로 번역·요약·추가하지 마라.",
    "한국어 글자의 위치, 크기, 굵기, 색상, 외곽선, 회전과 효과는 각 원문의 시각적 스타일에 맞춰라.",
    "좌표는 이미지 전체 기준 0~1000의 [xmin,ymin,xmax,ymax]이며 원문영역은 제거 범위, 조판영역은 한국어 배치 범위다.",
    "이미지 안에 설명, 워터마크, 추가 문구를 만들지 마라.",
    regionLines,
    issueBlock,
    "편집이 끝나면 생성된 이미지의 로컬 절대 경로만 최종 답변 한 줄로 반환하라. Markdown이나 다른 설명을 쓰지 마라."
  ].filter(Boolean).join("\n");
}

function buildCodexEndToEndPrompt(options = {}) {
  const attempt = Math.max(1, Number(options.attempt) || 1);
  const issues = Array.isArray(options.issues) ? options.issues.filter(Boolean) : [];
  const issueBlock = issues.length
    ? `\n이전 독립 검수에서 발견된 문제를 반드시 바로잡아라:\n${issues.map((issue) => `- ${singleLine(issue)}`).join("\n")}`
    : "";

  return [
    "내장 image_gen 도구를 사용해 첫 번째 첨부 이미지를 직접 편집하라.",
    "Use case: text-localization.",
    `Codex 통합 번역·렌더 ${attempt}회차다.`,
    "이 작업에서는 별도의 OCR 좌표나 번역문이 제공되지 않는다. 네가 원본 전체를 직접 정밀 판독하고, 번역하고, 원문을 제거하고, 한국어를 식자하고, 결과를 자체 검수하라.",
    "이미지 전체를 확대해 일본어 대사, 독백, 설명, 간판·라벨, 작은 글자, 세로 글자, 검은 배경의 흰 글자와 효과음을 빠짐없이 찾으라.",
    "각 문구의 탁점·반탁점·작은 가나·장음·말줄임표를 확인하고 장면 문맥, 화자의 말투와 감정을 보존해 자연스럽고 간결한 한국어로 번역하라.",
    "효과음은 설명문으로 풀지 말고 원문의 소리와 강도를 살린 짧은 한국어 의성어·의태어로 옮겨라.",
    "일본어 원문은 잔상이나 한국어와의 겹침 없이 섬세하게 제거하고 뒤의 말풍선, 선화, 망점과 배경을 자연스럽게 복원하라.",
    "한국어는 원문의 위치, 크기, 굵기, 색상, 외곽선, 회전, 정렬과 시각적 효과를 최대한 유지해 원래 영역 안에 배치하라.",
    "원본의 인물, 얼굴, 신체, 의상, 배경, 패널선, 말풍선 테두리, 효과선, 망점, 색상, 명암, 구도와 그림체는 픽셀 수준으로 최대한 보존하라.",
    "일본어가 없는 영역은 수정하지 말고 장면을 새로 그리거나 인물의 형태·표정·자세를 바꾸지 마라.",
    "이미지에 일본어 문구가 전혀 없다면 원본을 변경하지 않은 결과를 만들어라.",
    "완성 전에 원본과 결과를 다시 비교해 누락된 일본어, 원문 잔상, 오역, 잘린 한국어, 그림 손상을 스스로 수정하라.",
    "이미지 안에 설명, 워터마크 또는 원본에 없던 추가 문구를 만들지 마라.",
    issueBlock,
    "편집이 끝나면 생성된 이미지의 로컬 절대 경로만 최종 답변 한 줄로 반환하라. Markdown이나 다른 설명을 쓰지 마라."
  ].filter(Boolean).join("\n");
}

function resolveGeneratedImagePath(message, generatedRoot = defaultGeneratedRoot()) {
  const paths = extractGeneratedImagePaths(message);
  if (paths.length === 0) throw new Error("Codex 이미지 생성 응답과 실행 이벤트에서 결과 경로를 찾지 못했습니다.");
  const root = fs.realpathSync.native(generatedRoot);
  const rootPrefix = `${root}${path.sep}`.toLowerCase();
  for (const candidate of paths.reverse()) {
    if (!fs.existsSync(candidate)) continue;
    const resolved = fs.realpathSync.native(candidate);
    if (!resolved.toLowerCase().startsWith(rootPrefix)) continue;
    if (!fs.statSync(resolved).isFile()) continue;
    return resolved;
  }
  throw new Error("Codex 이미지 결과가 안전한 생성 폴더에 없습니다.");
}

function extractGeneratedImagePaths(message) {
  const source = String(message || "");
  const textCandidates = [source];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      collectJsonStrings(JSON.parse(trimmed), textCandidates);
    } catch {
      // JSONL이 아닌 일반 로그 줄은 원문 정규식 검색으로 처리한다.
    }
  }

  const found = [];
  const seen = new Set();
  for (const text of textCandidates) {
    const normalized = String(text).replace(/\\\\/g, "\\");
    const matches = normalized.match(/[A-Za-z]:[\\/][^\r\n`"<>|]+?\.(?:png|jpe?g|webp)/gi) || [];
    for (const candidate of matches) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(candidate);
    }
  }
  return found;
}

function collectJsonStrings(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonStrings(item, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.values(value).forEach((item) => collectJsonStrings(item, output));
}

async function normalizeGeneratedImage(generatedPath, sourcePath) {
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error("원본 이미지 크기를 읽지 못했습니다.");
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation);
  const width = swapsAxes ? metadata.height : metadata.width;
  const height = swapsAxes ? metadata.width : metadata.height;
  return sharp(generatedPath)
    .autoOrient()
    .resize(width, height, { fit: "fill" })
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
}

async function cleanupGeneratedImage(generatedPath, generatedRoot = defaultGeneratedRoot()) {
  const resolved = resolveGeneratedImagePath(generatedPath, generatedRoot);
  const parent = path.dirname(resolved);
  const root = fs.realpathSync.native(generatedRoot);
  if (path.dirname(parent).toLowerCase() !== root.toLowerCase()) {
    throw new Error("Codex 생성 세션 폴더 범위가 올바르지 않습니다.");
  }
  await fs.promises.rm(parent, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

function defaultGeneratedRoot() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "generated_images");
}

function singleLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function formatBox(value) {
  return Array.isArray(value) ? value.map((item) => Math.round(Number(item) * 10) / 10).join(",") : "";
}

module.exports = {
  buildCodexImageRenderPrompt,
  buildCodexEndToEndPrompt,
  extractGeneratedImagePaths,
  resolveGeneratedImagePath,
  normalizeGeneratedImage,
  cleanupGeneratedImage,
  defaultGeneratedRoot
};
