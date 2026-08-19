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
    "내장 image_gen 도구를 사용해 첫 번째 첨부 이미지를 직접 편집하라. 첨부 이미지는 전체 페이지가 아니라 하나 이상의 대사·문구 크롭을 평평한 회색 여백으로 분리한 기술용 작업 시트다.",
    "Use case: text-localization.",
    `Codex 이미지 렌더 ${attempt}회차다.`,
    "목표는 앞선 Codex 판독·번역 단계에서 확정한 아래 일본어 원문과 한국어 번역을 다시 확인한 뒤, 일본어만 섬세하게 제거하고 정확한 한국어로 교체한 크롭 이미지를 만드는 것이다.",
    "출력 크기와 가로세로 비율은 첨부 크롭과 정확히 같아야 하며 크롭 밖 장면을 새로 만들거나 캔버스를 확장하지 마라.",
    "각 타일과 회색 여백은 입력 픽셀 좌표에 고정되어 있다. 타일을 이동·회전·기울이기·확대·축소·원근 보정하지 마라.",
    "타일 가장자리나 글자 주변에 그림자, 광택, 테두리, 발광, 흐림, 입체 효과를 새로 추가하지 마라. 회색 여백도 단색 그대로 유지하라.",
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

function resolveGeneratedImagePath(message, generatedRoot = defaultGeneratedRoot()) {
  const paths = extractGeneratedImagePaths(message);
  const root = fs.realpathSync.native(generatedRoot);
  const rootPrefix = `${root}${path.sep}`.toLowerCase();
  for (const candidate of paths.reverse()) {
    if (!fs.existsSync(candidate)) continue;
    const resolved = fs.realpathSync.native(candidate);
    if (!resolved.toLowerCase().startsWith(rootPrefix)) continue;
    if (!fs.statSync(resolved).isFile()) continue;
    return resolved;
  }
  for (const threadId of extractCodexThreadIds(message).reverse()) {
    const sessionDir = path.join(root, threadId);
    if (!fs.existsSync(sessionDir)) continue;
    const resolvedSessionDir = fs.realpathSync.native(sessionDir);
    if (!resolvedSessionDir.toLowerCase().startsWith(rootPrefix)) continue;
    if (!fs.statSync(resolvedSessionDir).isDirectory()) continue;
    const sessionPrefix = `${resolvedSessionDir}${path.sep}`.toLowerCase();
    const generatedFiles = listGeneratedImages(resolvedSessionDir)
      .map((filePath) => ({ filePath, modifiedAt: fs.statSync(filePath).mtimeMs }))
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const entry of generatedFiles) {
      const resolved = fs.realpathSync.native(entry.filePath);
      if (!resolved.toLowerCase().startsWith(sessionPrefix)) continue;
      if (fs.statSync(resolved).isFile()) return resolved;
    }
  }
  if (paths.length === 0) {
    throw new Error("Codex 이미지 생성 응답과 실행 ID 폴더에서 결과 이미지를 찾지 못했습니다.");
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

function extractCodexThreadIds(message) {
  const found = [];
  const seen = new Set();
  for (const line of String(message || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      collectJsonThreadIds(JSON.parse(trimmed), found, seen);
    } catch {
      // JSONL이 아닌 일반 로그에는 실행 ID 회수를 적용하지 않는다.
    }
  }
  return found;
}

function collectJsonThreadIds(value, output, seen) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonThreadIds(item, output, seen));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "thread_id" || key === "threadId") && isSafeThreadId(item)) {
      const normalized = String(item).toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        output.push(String(item));
      }
      continue;
    }
    collectJsonThreadIds(item, output, seen);
  }
}

function isSafeThreadId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function listGeneratedImages(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listGeneratedImages(entryPath));
      continue;
    }
    if (entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name)) files.push(entryPath);
  }
  return files;
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
  extractGeneratedImagePaths,
  extractCodexThreadIds,
  resolveGeneratedImagePath,
  normalizeGeneratedImage,
  cleanupGeneratedImage,
  defaultGeneratedRoot
};
