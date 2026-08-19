"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { renderTranslatedImage } = require("./image-renderer.js");
const {
  createOcrReference,
  createTextIsolationReference,
  createLightTextIsolationReference,
  createLightTextDetailReferences,
  createLocalizationReference
} = require("./ocr-preprocessor.js");
const { selectReliableRegions, averageConfidence } = require("./ocr-results.js");
const {
  buildRegionAuditPrompt,
  buildTranslationEditPrompt,
  buildVisualQaPrompt
} = require("./quality-prompts.js");
const { TaskSemaphore } = require("./task-semaphore.js");
const { removeTranslatorTempDir } = require("./temp-cleanup.js");
const { buildCodexExecArgs, buildCodexImageRenderArgs } = require("./codex-exec-args.js");
const {
  createCodexExecutionError,
  attachCodexDiagnostics
} = require("./codex-diagnostics.js");
const {
  buildCodexImageRenderPrompt,
  buildCodexEndToEndPrompt,
  resolveGeneratedImagePath,
  normalizeGeneratedImage,
  cleanupGeneratedImage
} = require("./codex-image-renderer.js");

const HOST = "127.0.0.1";
const PORT = normalizePort(process.env.IMAGE_TRANSLATOR_PORT || "38473");
const MAX_CONCURRENT_TRANSLATIONS = normalizeConcurrency(process.env.IMAGE_TRANSLATOR_CONCURRENCY || "6");
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const BRIDGE_DIR = __dirname;
const TOKEN_PATH = path.join(BRIDGE_DIR, ".bridge-token");
const SCHEMA_PATH = path.join(BRIDGE_DIR, "response-schema.json");
const VISUAL_QA_SCHEMA_PATH = path.join(BRIDGE_DIR, "visual-qa-schema.json");
const DEFAULT_AUTO_VISUAL_QA_ATTEMPTS = 3;
const MAX_AUTO_VISUAL_QA_ATTEMPTS = 5;
const PROMPT = [
  "첨부 이미지만 분석하고 다른 파일이나 도구는 사용하지 마라.",
  "첫 번째 이미지는 원본이며 위치, 색상, 글꼴, 배경 스타일 판단의 유일한 기준이다.",
  "두 번째 이미지가 있으면 첫 번째 이미지와 가로세로 비율이 같은 OCR 강화본이다. 확대, 흑백 대비, 선명화가 적용되었으므로 글자 판독에 적극 사용하라.",
  "첨부 이미지 중 순수 흑백으로 진한 잉크만 남긴 이미지가 있으면 글자 분리본이다. 저해상도 세로 글자와 문장부호 후보를 찾는 데 사용하되 검은 머리카락과 선화는 원본과 대조해 글자로 오인하지 마라.",
  "첨부 이미지 중 검은 배경의 흰색 요소가 검은색으로 반전된 이미지가 있으면 밝은 글자 분리본이다. 검은 배경 위 흰색·회색 일본어 효과음과 반전 대사를 찾는 데 사용하되 광선·속도선·눈동자·하이라이트는 원본과 대조해 제외하라.",
  "밝은 글자 상세 크롭은 어두운 고대비 패널만 확대하고 얇은 망점·비산물·속도선을 약화한 자료다. 전체 반전본에서 작게 보이는 굵은 가나·한자 효과음의 형태를 판독하는 데 우선 사용하라.",
  "첨부 이미지 중 청록·분홍 X/Y 격자가 있는 이미지는 위치 기준본이다. 격자와 라벨은 OCR 대상이 아니며 오직 box 좌표 측정에만 사용하라.",
  "이미지에서 일본어 텍스트만 모두 찾고 자연스러운 한국어로 번역하라.",
  "각 문구를 원본과 OCR 강화본에서 각각 확인하고 글자의 획, 탁점, 반탁점, 장음, 작은 가나, 구두점을 한 글자씩 교차 검증하라.",
  "문맥만으로 보이지 않는 글자를 추측하지 마라. 판독 신뢰도가 0.45 미만이면 그 영역을 반환하지 마라.",
  "만화의 같은 말풍선이나 같은 설명 상자에 속한 여러 줄은 반드시 하나의 영역으로 묶고, 서로 다른 말풍선은 절대 합치지 마라.",
  "말풍선 없이 선화 위에 놓인 세로 문구는 공간적으로 이어진 열만 하나로 묶어라. 서로 떨어진 설명, 대사, 화자 문구를 큰 영역 하나로 합치지 마라.",
  "검은 배경 위 매우 큰 흰색 효과음은 획 일부가 화면 밖으로 잘렸거나 여러 덩어리로 떨어져 보여도 원본의 가나 형태와 읽기 순서를 확인해 같은 효과음 단위로 묶어라. 단순 폭발 얼룩과 속도선은 글자로 반환하지 마라.",
  "세로 문구는 오른쪽 열부터 왼쪽 열 순서로 읽고, 작은 っ·ゃ·ゅ·ょ, 장음, 탁점, 말줄임표와 행 끝 문장부호를 확대본과 글자 분리본에서 재검수하라.",
  "box는 실제 글자 획과 아주 작은 여백만 포함하도록 타이트하게 잡아라. 말풍선 테두리, 인물, 배경 선화는 box에 포함하지 마라.",
  "layoutBox는 한국어를 배치할 안전 영역이다. dialogue는 같은 말풍선 내부에서 테두리를 5% 이상 피한 가장 큰 사각형, narration은 같은 설명/여백 영역, sfx와 label은 원문 주변의 안전 영역으로 잡아라.",
  "box는 원문 제거에만 쓰고 layoutBox는 번역문 조판에만 쓰므로 두 좌표를 구분하라. layoutBox가 말풍선 밖이나 인물 위로 넘어가면 안 된다.",
  "각 box의 네 변을 청록·분홍 격자 이미지의 50단위 보조선과 100단위 라벨 사이에서 세밀하게 보간하고, 50이나 100 단위로 단순 반올림하지 마라.",
  "최종 box를 반환하기 전에 원본에서 실제 글자의 위·왼쪽·아래·오른쪽 끝과 각각 다시 대조하라.",
  "regionKind는 대사 말풍선 dialogue, 설명 상자 narration, 효과음 sfx, 기타 짧은 표기 label 중 하나다.",
  "confidence는 일본어 원문 판독의 신뢰도를 0~1 사이 값으로 반환하라.",
  "box와 layoutBox는 이미지 전체를 0~1000으로 정규화한 [xmin, ymin, xmax, ymax] 좌표다. 반드시 X 좌표를 먼저 반환하라.",
  "orientation은 horizontal 또는 vertical이다.",
  "fontSize는 글자 한 자의 높이(세로쓰기면 너비)를 이미지 높이 기준 0~1000 값으로 추정하라.",
  "textColor와 backgroundColor는 #RRGGBB 형식으로 추정하라.",
  "fontStyle은 sans, serif, rounded, handwritten, display 중 원본과 가장 가까운 계열이다.",
  "strokeColor는 글자 외곽선 색, strokeWidth는 외곽선 두께를 이미지 높이 기준 0~1000 값으로 추정하라.",
  "italic, rotation(-180~180도), align(left/center/right), backgroundComplex도 원본 스타일대로 추정하라.",
  "흰색이나 단색 말풍선과 설명 상자는 backgroundComplex=false, 그림이나 무늬 위에 직접 놓인 글자는 true로 반환하라.",
  "배경이 대부분 흰색이어도 글자 box 안이나 바로 주변에 얼굴, 머리카락, 옷 주름, 옅은 밑그림이 지나가면 backgroundComplex=true다.",
  "말풍선 없는 문구의 layoutBox는 얼굴이나 인물 전체로 넓히지 말고 원문 근처에서 한국어를 놓을 수 있는 가장 가까운 빈 공간으로 제한하라.",
  "translated는 의미와 말투를 보존하면서 말풍선에 자연스럽게 들어갈 간결한 한국어로 작성하라.",
  "번역할 일본어가 없으면 regions를 빈 배열로 반환하라. 최종 답변은 지정된 스키마만 따른다."
].join("\n");

const token = loadOrCreateToken();
const codexRuntime = findCodexRuntime();
let nextRequestId = 0;
const translationSlots = new TaskSemaphore(MAX_CONCURRENT_TRANSLATIONS);
const activeTranslationRequests = new Map();

const server = http.createServer(async (request, response) => {
  let requestId = null;
  let imageIndex = null;
  setCorsHeaders(request, response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (!isAuthorized(request)) throw httpError(401, "연결 토큰이 올바르지 않습니다.");

    if (request.method === "GET" && request.url === "/status") {
      const status = getCodexStatus();
      sendJson(response, 200, { ok: true, codex: status });
      return;
    }

    if (request.method === "POST" && request.url === "/cancel") {
      const body = await readJsonBody(request);
      requestId = normalizePositiveInteger(body?.bridgeRequestId);
      if (!requestId) throw httpError(400, "스킵할 작업 번호가 올바르지 않습니다.");
      const control = activeTranslationRequests.get(requestId);
      imageIndex = control?.imageIndex ?? normalizeImageIndex(body?.imageIndex);
      if (!control) {
        sendJson(response, 200, { ok: true, alreadyFinished: true });
        return;
      }
      control.cancelled = true;
      if (control.child && !control.child.killed) control.child.kill();
      logProgress(requestId, imageIndex, "사용자 스킵 요청 · 현재 Codex 단계 중단");
      sendJson(response, 200, { ok: true, cancelled: true });
      return;
    }

    if (request.method === "POST" && request.url === "/cancel-all") {
      let cancelledCount = 0;
      for (const [activeRequestId, control] of activeTranslationRequests.entries()) {
        if (control.cancelled) continue;
        control.cancelled = true;
        cancelledCount += 1;
        if (control.child && !control.child.killed) control.child.kill();
        logProgress(activeRequestId, control.imageIndex, "전체 취소 요청 · 현재 Codex 단계 중단");
      }
      sendJson(response, 200, { ok: true, cancelledCount });
      return;
    }

    if (request.method === "POST" && request.url === "/translate") {
      requestId = ++nextRequestId;
      const body = await readJsonBody(request);
      imageIndex = normalizeImageIndex(body?.metadata?.index);
      logProgress(requestId, imageIndex, `요청 수신 · ${formatBytes(estimateBase64Bytes(body?.image?.data))} · ${formatSource(body?.metadata)}`);
      const control = { imageIndex, cancelled: false, child: null };
      activeTranslationRequests.set(requestId, control);
      let result;
      try {
        result = await withTranslationSlot(
          requestId,
          imageIndex,
          () => translateImage(body?.image, body?.metadata, requestId, control)
        );
      } finally {
        activeTranslationRequests.delete(requestId);
      }
      if (request.aborted || response.destroyed) {
        logProgress(requestId, imageIndex, "교체용 이미지 생성 완료 후 클라이언트 연결 종료 감지 · 결과 전달 실패");
        return;
      }
      sendJson(response, 200, { ...result, bridgeRequestId: requestId });
      logProgress(requestId, imageIndex, "교체용 이미지 응답 전송 완료 · 페이지 확인 대기");
      return;
    }

    if (request.method === "POST" && request.url === "/commit") {
      const body = await readJsonBody(request);
      requestId = normalizePositiveInteger(body?.bridgeRequestId);
      imageIndex = normalizeImageIndex(body?.imageIndex);
      if (!requestId) throw httpError(400, "교체 확인 작업 번호가 올바르지 않습니다.");
      if (body?.success === false) {
        const target = body?.elementType === "zip" ? "ZIP 이미지 저장" : "페이지 이미지 교체";
        logProgress(requestId, imageIndex, `${target} 실패 · ${String(body?.error || "원인 미상").slice(0, 500)}`);
      } else {
        const element = body?.elementType ? `<${String(body.elementType).slice(0, 20)}>` : "이미지";
        const action = body?.elementType === "zip" ? "ZIP 이미지 저장 확인" : "페이지 이미지 교체 확인";
        logProgress(requestId, imageIndex, `${action} · ${element}`);
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    throw httpError(404, "지원하지 않는 경로입니다.");
  } catch (error) {
    if (requestId) {
      if (error.code === "TRANSLATION_CANCELLED") {
        logProgress(requestId, imageIndex, "사용자 스킵 완료 · 원본 유지");
      } else {
        logProgress(requestId, imageIndex, `오류 · ${error.message}`);
        const details = normalizeErrorDetails(error);
        details.forEach((detail, index) => {
          logProgress(requestId, imageIndex, `Codex 오류 상세 ${index + 1}/${details.length} · ${detail}`);
        });
      }
    }
    if (!response.destroyed && !response.writableEnded) {
      sendJson(response, error.statusCode || 500, {
        error: error.message || "브리지 오류가 발생했습니다.",
        errorCode: error.code || "BRIDGE_ERROR",
        details: normalizeErrorDetails(error)
      });
    }
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`포트 ${PORT}이 이미 사용 중입니다. 기존 브리지 창이 열려 있는지 확인하세요.`);
  } else {
    console.error(`브리지 시작 실패: ${error.message}`);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("이미지 한글 번역기 로컬 브리지");
  console.log(`주소: http://${HOST}:${PORT}`);
  console.log(`연결 토큰: ${token}`);
  console.log(`Codex: ${getCodexStatus()}`);
  console.log(`병렬 처리 슬롯: 최대 ${MAX_CONCURRENT_TRANSLATIONS}개`);
  console.log("");
  console.log("이 창을 닫지 말고 확장 프로그램 설정에 연결 토큰을 입력하세요.");
  console.log("번역을 시작하면 이 창에 작업별 진행 상황이 표시됩니다.");
});

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 38473;
  return port;
}

function normalizeConcurrency(value) {
  const count = Number(value);
  if (!Number.isInteger(count)) return 6;
  return Math.min(12, Math.max(1, count));
}

function normalizeQaAttempts(value) {
  const attempts = Number(value);
  if (!Number.isInteger(attempts)) return DEFAULT_AUTO_VISUAL_QA_ATTEMPTS;
  return Math.min(MAX_AUTO_VISUAL_QA_ATTEMPTS, Math.max(1, attempts));
}

async function withTranslationSlot(requestId, imageIndex, task) {
  const willQueue = translationSlots.active >= translationSlots.maximum;
  if (willQueue) logProgress(requestId, imageIndex, `대기열 진입 · 앞선 대기 작업 ${translationSlots.queued}개`);
  await translationSlots.acquire();
  logProgress(requestId, imageIndex, `병렬 처리 시작 · 실행 중 ${translationSlots.active}/${translationSlots.maximum}`);
  try {
    return await task();
  } finally {
    const released = translationSlots.release();
    if (released.transferred) {
      logProgress(requestId, imageIndex, `처리 슬롯을 대기 작업에 전달 · 실행 중 ${translationSlots.active}/${translationSlots.maximum}`);
    } else {
      logProgress(requestId, imageIndex, `처리 슬롯 반환 · 실행 중 ${translationSlots.active}/${translationSlots.maximum}`);
    }
  }
}

function loadOrCreateToken() {
  const supplied = String(process.env.IMAGE_TRANSLATOR_TOKEN || "").trim();
  if (supplied) return supplied;
  if (fs.existsSync(TOKEN_PATH)) return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  const created = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_PATH, `${created}\n`, "utf8");
  return created;
}

function findCodexRuntime() {
  if (process.platform !== "win32") return { command: "codex", prefix: [] };
  const appData = process.env.APPDATA;
  const codexJs = appData
    ? path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
    : "";
  if (!codexJs || !fs.existsSync(codexJs)) {
    throw new Error("Codex CLI 본체를 찾지 못했습니다. npm으로 Codex CLI를 다시 설치해 주세요.");
  }
  return { command: process.execPath, prefix: [codexJs] };
}

function getCodexStatus() {
  const result = runCodexSync(["login", "status"]);
  const output = `${result.stdout || ""} ${result.stderr || ""}`.trim();
  return output || (result.status === 0 ? "로그인됨" : "상태 확인 실패");
}

function runCodexSync(args) {
  return spawnSync(codexRuntime.command, [...codexRuntime.prefix, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true
  });
}

async function translateImage(image, metadata, requestId, control) {
  const imageIndex = normalizeImageIndex(metadata?.index);
  const renderMode = normalizeRenderMode(metadata?.renderMode);
  assertTranslationActive(control);
  if (!image?.mimeType || !image?.data) throw httpError(400, "이미지 데이터가 없습니다.");
  const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
  const extension = extensions[image.mimeType];
  if (!extension) throw httpError(400, "지원하지 않는 이미지 형식입니다.");
  if (!/^[a-zA-Z0-9+/=\r\n]+$/.test(image.data)) throw httpError(400, "Base64 이미지가 올바르지 않습니다.");

  const bytes = Buffer.from(image.data, "base64");
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw httpError(413, "이미지가 너무 큽니다.");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-"));
  const imagePath = path.join(tempDir, `capture${extension}`);
  const ocrImagePath = path.join(tempDir, "ocr-enhanced.png");
  const isolatedTextPath = path.join(tempDir, "text-isolated.png");
  const lightTextPath = path.join(tempDir, "light-text-isolated.png");
  const locatorImagePath = path.join(tempDir, "coordinate-locator.png");
  const recognitionPath = path.join(tempDir, "recognition.json");
  const auditPath = path.join(tempDir, "region-audit.json");
  const translationPath = path.join(tempDir, "translation-edit.json");
  fs.writeFileSync(imagePath, bytes);
  logProgress(requestId, imageIndex, `원본 준비 완료 · ${path.basename(imagePath)} · ${formatBytes(bytes.length)}`);
  logProgress(requestId, imageIndex, `렌더 모드 · ${renderMode === "codex-image" ? "Codex 전체 위임" : "로컬 정밀 렌더"}`);

  try {
    if (renderMode === "codex-image") {
      return await translateImageFullyWithCodex({
        imagePath,
        tempDir,
        requestId,
        imageIndex,
        metadata,
        control
      });
    }

    let ocrReference = null;
    let isolatedTextReference = null;
    let lightTextReference = null;
    let lightTextDetails = [];
    let locatorReference = null;
    try {
      ocrReference = await createOcrReference(imagePath, ocrImagePath);
      logProgress(
        requestId,
        imageIndex,
        `OCR 강화본 준비 완료 · ${ocrReference.originalWidth}×${ocrReference.originalHeight} → ${ocrReference.width}×${ocrReference.height} · ${ocrReference.scale.toFixed(2)}배`
      );
    } catch (error) {
      logProgress(requestId, imageIndex, `OCR 강화본 생성 실패 · 원본으로 계속 분석 · ${error.message}`);
    }

    if (ocrReference) {
      try {
        isolatedTextReference = await createTextIsolationReference(
          imagePath,
          isolatedTextPath,
          ocrReference
        );
        logProgress(
          requestId,
          imageIndex,
          `글자 분리본 준비 완료 · ${isolatedTextReference.width}×${isolatedTextReference.height} · 임계값 ${isolatedTextReference.threshold}`
        );
      } catch (error) {
        logProgress(requestId, imageIndex, `글자 분리본 생성 실패 · OCR 강화본으로 계속 분석 · ${error.message}`);
      }
      try {
        lightTextReference = await createLightTextIsolationReference(
          imagePath,
          lightTextPath,
          ocrReference
        );
        logProgress(
          requestId,
          imageIndex,
          `밝은 글자 반전본 준비 완료 · ${lightTextReference.width}×${lightTextReference.height} · 임계값 ${lightTextReference.threshold}`
        );
      } catch (error) {
        logProgress(requestId, imageIndex, `밝은 글자 반전본 생성 실패 · 원본으로 계속 분석 · ${error.message}`);
      }
      try {
        locatorReference = await createLocalizationReference(imagePath, locatorImagePath, ocrReference);
        logProgress(requestId, imageIndex, `좌표 기준본 준비 완료 · ${locatorReference.width}×${locatorReference.height} · 50단위 정밀 격자`);
      } catch (error) {
        logProgress(requestId, imageIndex, `좌표 기준본 생성 실패 · 원본 좌표로 계속 분석 · ${error.message}`);
      }
    }

    try {
      lightTextDetails = await createLightTextDetailReferences(imagePath, tempDir, { maxReferences: 4 });
      if (lightTextDetails.length > 0) {
        logProgress(requestId, imageIndex, `밝은 글자 상세 크롭 ${lightTextDetails.length}개 준비 완료 · 어두운 고대비 패널 확대`);
        lightTextDetails.forEach((detail, index) => {
          logProgress(
            requestId,
            imageIndex,
            `밝은 글자 상세 #${index + 1} · 원본 좌표 [${detail.box.join(", ")}] · ${detail.width}×${detail.height}`
          );
        });
      }
    } catch (error) {
      logProgress(requestId, imageIndex, `밝은 글자 상세 크롭 생성 실패 · 전체 반전본으로 계속 분석 · ${error.message}`);
    }

    const referenceImages = [imagePath];
    if (ocrReference) referenceImages.push(ocrImagePath);
    if (isolatedTextReference) referenceImages.push(isolatedTextPath);
    if (lightTextReference) referenceImages.push(lightTextPath);
    for (const detail of lightTextDetails) referenceImages.push(detail.path);
    if (locatorReference) referenceImages.push(locatorImagePath);
    const detailGuide = buildLightTextDetailGuide(lightTextDetails, referenceImages);

    let result = await runQualityPass({
      requestId,
      imageIndex,
      tempDir,
      label: "정밀 판독 1/4",
      prompt: appendPromptGuide(PROMPT, detailGuide),
      images: referenceImages,
      outputPath: recognitionPath,
      control
    });
    result = await runOptionalQualityPass({
      requestId,
      imageIndex,
      tempDir,
      label: "누락·좌표 검수 2/4",
      prompt: appendPromptGuide(buildRegionAuditPrompt(result), detailGuide),
      images: referenceImages,
      outputPath: auditPath,
      fallback: result,
      control
    });
    result = await runOptionalQualityPass({
      requestId,
      imageIndex,
      tempDir,
      label: "번역·문맥 교정 3/4",
      prompt: appendPromptGuide(buildTranslationEditPrompt(result), detailGuide),
      images: referenceImages,
      outputPath: translationPath,
      fallback: result,
      control
    });

    const preliminarySelection = selectReliableRegions(result.regions);
    result = { ...result, regions: preliminarySelection.accepted };
    if (result.regions.length === 0) {
      logProgress(requestId, imageIndex, "번역할 문구 없음 · 이미지 교체 생략");
      return { ...result, editedImage: null };
    }

    const manualReview = metadata?.qualityReviewMode === "manual";
    const maximumQaAttempts = manualReview
      ? 1
      : normalizeQaAttempts(metadata?.maxAutoQaAttempts);
    let visualReview = null;
    let completedQaAttempts = 0;
    for (let attempt = 1; attempt <= maximumQaAttempts; attempt += 1) {
      assertTranslationActive(control);
      const previewPath = path.join(tempDir, `quality-preview-${attempt}.webp`);
      const visualQaPath = path.join(tempDir, `visual-qa-${attempt}.json`);
      const modeLabel = manualReview ? "사용자 추가 검수" : `자동 검수 ${attempt}/${maximumQaAttempts}`;
      logProgress(requestId, imageIndex, `${modeLabel} · 교정본 합성 시작`);
      const previewBuffer = await renderTranslatedImage(imagePath, result.regions);
      fs.writeFileSync(previewPath, previewBuffer);
      logProgress(requestId, imageIndex, `${modeLabel} · 검수용 WebP 준비 완료 · ${formatBytes(previewBuffer.length)}`);

      const visualImages = [imagePath, previewPath, ...referenceImages.slice(1)];
      const visualDetailGuide = buildLightTextDetailGuide(lightTextDetails, visualImages);
      const fallbackReview = {
        passed: false,
        summary: "시각 검수 호출 실패",
        issues: ["시각 검수 결과를 받지 못해 사용자 확인이 필요함"],
        regions: result.regions
      };
      visualReview = await runOptionalQualityPass({
        requestId,
        imageIndex,
        tempDir,
        label: `${modeLabel} · 합성 결과 시각 검수 4/4`,
        prompt: appendPromptGuide(
          buildVisualQaPrompt(result, {
            attempt,
            maximum: maximumQaAttempts,
            manualReview
          }),
          visualDetailGuide
        ),
        images: visualImages,
        outputPath: visualQaPath,
        schemaPath: VISUAL_QA_SCHEMA_PATH,
        fallback: fallbackReview,
        control
      });
      completedQaAttempts = attempt;
      result = { ...result, regions: selectReliableRegions(visualReview.regions).accepted };
      if (visualReview.passed) {
        logProgress(requestId, imageIndex, `${modeLabel} 통과 · ${singleLine(visualReview.summary)}`);
        break;
      }
      const issueSummary = visualReview.issues.length
        ? visualReview.issues.slice(0, 3).map(singleLine).join(" / ")
        : singleLine(visualReview.summary);
      if (attempt < maximumQaAttempts) {
        logProgress(requestId, imageIndex, `${modeLabel} 미통과 · 교정 후 자동 재합성 · ${issueSummary}`);
      } else {
        logProgress(requestId, imageIndex, `${modeLabel} 미통과 · 자동 반복 종료 · ${issueSummary}`);
      }
    }

    const qualityReview = {
      passed: visualReview?.passed === true,
      attempts: completedQaAttempts,
      mode: manualReview ? "manual" : "automatic",
      requiresUserReview: visualReview?.passed !== true,
      summary: String(visualReview?.summary || "검수 결과 없음"),
      issues: Array.isArray(visualReview?.issues) ? visualReview.issues : []
    };
    if (qualityReview.requiresUserReview) {
      const message = manualReview
        ? "사용자 추가 검수 미통과 · 결과 적용 후 필요하면 다시 검수하세요"
        : `자동 검수 ${completedQaAttempts}회 미통과 · 사용자 검수 필요`;
      logProgress(requestId, imageIndex, message);
    }

    const confidence = averageConfidence(result.regions);
    const selected = selectReliableRegions(result.regions);
    result = { ...result, regions: selected.accepted };
    const confidenceLabel = confidence === null ? "측정 불가" : `${Math.round(confidence * 100)}%`;
    logProgress(requestId, imageIndex, `최종 일본어 문구 ${result.regions.length}개 확정 · 평균 OCR 신뢰도 ${confidenceLabel}`);
    result.regions.slice(0, 30).forEach((region, index) => {
      const box = formatBox(region.box);
      const layoutBox = formatBox(region.layoutBox);
      logProgress(requestId, imageIndex, `글자 영역 #${index + 1} · ${region.regionKind || "unknown"} · 제거 [${box}] · 조판 [${layoutBox}] · 신뢰도 ${Math.round((Number(region.confidence) || 0) * 100)}%`);
    });
    if (selected.rejected.length > 0) {
      logProgress(requestId, imageIndex, `저신뢰 문구 ${selected.rejected.length}개 제외 · 잘못된 이미지 교체 방지`);
    }
    if (result.regions.length === 0) {
      logProgress(requestId, imageIndex, "번역할 문구 없음 · 이미지 교체 생략");
      return { ...result, qualityReview, editedImage: null };
    }
    assertTranslationActive(control);
    logProgress(requestId, imageIndex, "최종 원문 제거 및 한국어 이미지 재합성 시작");
    const editedBuffer = await renderTranslatedImage(imagePath, result.regions);
    logProgress(requestId, imageIndex, `교체용 WebP 생성 완료 · ${formatBytes(editedBuffer.length)}`);
    return {
      ...result,
      qualityReview,
      editedImage: {
        mimeType: "image/webp",
        data: editedBuffer.toString("base64")
      }
    };
  } finally {
    await cleanupTempDirSafely(tempDir, requestId, imageIndex);
  }
}

async function translateImageFullyWithCodex({ imagePath, tempDir, requestId, imageIndex, metadata, control }) {
  const manualReview = metadata?.qualityReviewMode === "manual";
  const maximumQaAttempts = manualReview
    ? 1
    : normalizeQaAttempts(metadata?.maxAutoQaAttempts);
  let result = { regions: [] };
  let visualReview = null;
  let latestPreviewBuffer = null;
  let completedQaAttempts = 0;

  logProgress(
    requestId,
    imageIndex,
    "Codex 통합 처리 · 별도 OCR·좌표 검수·번역 교정을 생략하고 원본에서 완성 이미지까지 한 번에 처리"
  );

  for (let attempt = 1; attempt <= maximumQaAttempts; attempt += 1) {
    assertTranslationActive(control);
    const modeLabel = manualReview ? "사용자 추가 검수" : `자동 검수 ${attempt}/${maximumQaAttempts}`;
    const previewPath = path.join(tempDir, `codex-integrated-preview-${attempt}.webp`);
    const visualQaPath = path.join(tempDir, `codex-integrated-qa-${attempt}.json`);
    const hasCorrectionRegions = result.regions.length > 0;

    latestPreviewBuffer = await renderTranslatedImageWithCodex({
      requestId,
      imageIndex,
      tempDir,
      imagePath,
      regions: result.regions,
      attempt,
      issues: visualReview?.issues,
      fullDelegation: attempt === 1 || !hasCorrectionRegions,
      control
    });
    fs.writeFileSync(previewPath, latestPreviewBuffer);
    logProgress(requestId, imageIndex, `${modeLabel} · 통합 결과 독립 검수 시작 · ${formatBytes(latestPreviewBuffer.length)}`);

    const fallbackReview = {
      passed: false,
      summary: "Codex 통합 결과 독립 검수 호출 실패",
      issues: ["검수 결과를 받지 못해 사용자 확인이 필요함"],
      regions: result.regions
    };
    visualReview = await runOptionalQualityPass({
      requestId,
      imageIndex,
      tempDir,
      label: `${modeLabel} · Codex 통합 결과 독립 검수`,
      prompt: buildVisualQaPrompt(result, {
        attempt,
        maximum: maximumQaAttempts,
        manualReview
      }),
      images: [imagePath, previewPath],
      outputPath: visualQaPath,
      schemaPath: VISUAL_QA_SCHEMA_PATH,
      fallback: fallbackReview,
      control
    });
    completedQaAttempts = attempt;
    result = { ...result, regions: selectReliableRegions(visualReview.regions).accepted };

    if (visualReview.passed) {
      logProgress(requestId, imageIndex, `${modeLabel} 통과 · ${singleLine(visualReview.summary)}`);
      break;
    }

    const issueSummary = visualReview.issues.length
      ? visualReview.issues.slice(0, 3).map(singleLine).join(" / ")
      : singleLine(visualReview.summary);
    if (attempt < maximumQaAttempts) {
      logProgress(requestId, imageIndex, `${modeLabel} 미통과 · 검수 교정안으로 Codex 재처리 · ${issueSummary}`);
    } else {
      logProgress(requestId, imageIndex, `${modeLabel} 미통과 · 자동 반복 종료 · ${issueSummary}`);
    }
  }

  const qualityReview = {
    passed: visualReview?.passed === true,
    attempts: completedQaAttempts,
    mode: manualReview ? "manual" : "automatic",
    requiresUserReview: visualReview?.passed !== true,
    summary: String(visualReview?.summary || "검수 결과 없음"),
    issues: Array.isArray(visualReview?.issues) ? visualReview.issues : []
  };
  if (qualityReview.requiresUserReview) {
    const message = manualReview
      ? "사용자 추가 검수 미통과 · 현재 결과를 확인한 뒤 필요하면 다시 검수하세요"
      : `자동 검수 ${completedQaAttempts}회 미통과 · 사용자 검수 필요`;
    logProgress(requestId, imageIndex, message);
  }
  if (!latestPreviewBuffer) throw new Error("Codex 통합 렌더 결과가 없습니다.");

  logProgress(
    requestId,
    imageIndex,
    `Codex 통합 교체용 WebP 확정 · 독립 검수 ${completedQaAttempts}회 · ${formatBytes(latestPreviewBuffer.length)}`
  );
  return {
    ...result,
    qualityReview,
    editedImage: {
      mimeType: "image/webp",
      data: latestPreviewBuffer.toString("base64")
    }
  };
}

async function renderTranslatedImageWithCodex({
  requestId,
  imageIndex,
  tempDir,
  imagePath,
  regions,
  attempt,
  issues,
  fullDelegation = false,
  control
}) {
  assertTranslationActive(control);
  const outputPath = path.join(tempDir, `codex-image-render-${attempt}.txt`);
  if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
  const startedAt = Date.now();
  const taskLabel = fullDelegation ? "Codex 통합 번역·렌더" : "Codex 이미지 렌더";
  logProgress(requestId, imageIndex, `${taskLabel} ${attempt}회차 시작 · ${fullDelegation ? "판독·번역·원문 제거·한국어 식질 전체 위임" : "원문 제거·한국어 식질 위임"}`);
  const heartbeat = setInterval(() => {
    logProgress(requestId, imageIndex, `${taskLabel} ${attempt}회차 진행 중 · ${formatDuration(Date.now() - startedAt)} 경과`);
  }, 10_000);
  let generatedPath = null;
  let executionEvents = "";
  let finalMessage = "";
  try {
    executionEvents = await runCodex(
      buildCodexImageRenderArgs({ tempDir, imagePath, outputPath }),
      fullDelegation
        ? buildCodexEndToEndPrompt({ attempt, issues })
        : buildCodexImageRenderPrompt(regions, { attempt, issues }),
      15 * 60 * 1000,
      control,
      taskLabel
    );
    assertTranslationActive(control);
    finalMessage = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
    generatedPath = resolveGeneratedImagePath(`${finalMessage}\n${executionEvents}`);
    const buffer = await normalizeGeneratedImage(generatedPath, imagePath);
    logProgress(
      requestId,
      imageIndex,
      `${taskLabel} ${attempt}회차 완료 · 원본 크기로 정규화 · ${formatBytes(buffer.length)} · ${formatDuration(Date.now() - startedAt)}`
    );
    return buffer;
  } catch (error) {
    throw attachCodexDiagnostics(error, {
      stdout: `${finalMessage}\n${executionEvents}`,
      stage: taskLabel
    });
  } finally {
    clearInterval(heartbeat);
    if (generatedPath) {
      cleanupGeneratedImage(generatedPath).catch((error) => {
        logProgress(requestId, imageIndex, `Codex 생성 이미지 지연 정리 · ${error.code || error.message}`);
      });
    }
  }
}

async function runQualityPass({ requestId, imageIndex, tempDir, label, prompt, images, outputPath, schemaPath = SCHEMA_PATH, control }) {
  assertTranslationActive(control);
  if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
  const startedAt = Date.now();
  logProgress(requestId, imageIndex, `${label} 시작 · 첨부 자료 ${images.length}개`);
  const heartbeat = setInterval(() => {
    logProgress(requestId, imageIndex, `${label} 진행 중 · ${formatDuration(Date.now() - startedAt)} 경과`);
  }, 10_000);
  try {
    await runCodex(buildCodexExecArgs({
      tempDir,
      images,
      schemaPath,
      outputPath
    }), prompt, 300_000, control, label);
  } finally {
    clearInterval(heartbeat);
  }
  assertTranslationActive(control);
  const result = readStructuredResult(outputPath);
  logProgress(
    requestId,
    imageIndex,
    `${label} 완료 · 후보 ${result.regions.length}개 · ${formatDuration(Date.now() - startedAt)}`
  );
  return result;
}

async function runOptionalQualityPass(options) {
  try {
    return await runQualityPass(options);
  } catch (error) {
    if (error.code === "TRANSLATION_CANCELLED") throw error;
    logProgress(
      options.requestId,
      options.imageIndex,
      `${options.label} 실패 · 이전 단계 결과로 계속 · ${error.message}`
    );
    return options.fallback;
  }
}

function assertTranslationActive(control) {
  if (!control?.cancelled) return;
  const error = httpError(499, "사용자가 이미지 번역을 스킵했습니다.");
  error.code = "TRANSLATION_CANCELLED";
  throw error;
}

function readStructuredResult(outputPath) {
  if (!fs.existsSync(outputPath)) throw new Error("Codex가 결과 파일을 만들지 않았습니다.");
  let result;
  try {
    result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch (error) {
    throw new Error(`Codex 결과 JSON을 읽지 못했습니다: ${error.message}`);
  }
  if (!Array.isArray(result?.regions)) throw new Error("Codex 결과 형식이 올바르지 않습니다.");
  if (Object.hasOwn(result, "passed")) {
    if (typeof result.passed !== "boolean" || !Array.isArray(result.issues) || typeof result.summary !== "string") {
      throw new Error("Codex 시각 검수 결과 형식이 올바르지 않습니다.");
    }
  }
  return result;
}

function singleLine(value) {
  return String(value || "사유 없음").replace(/\s+/g, " ").trim().slice(0, 500);
}

function runCodex(args, stdinText, timeoutMs, control = null, stage = "Codex 실행") {
  return new Promise((resolve, reject) => {
    try {
      assertTranslationActive(control);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(codexRuntime.command, [...codexRuntime.prefix, ...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (control) control.child = child;

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      const error = createCodexExecutionError({ stdout, stderr, stage });
      error.code = "CODEX_TIMEOUT";
      error.message = `Codex 처리 시간 초과 · ${Math.round(timeoutMs / 1000)}초 제한`;
      error.details = [...(error.details || []), `제한 시간: ${Math.round(timeoutMs / 1000)}초`];
      reject(error);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { if (stdout.length < 1_000_000) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 1_000_000) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (control?.child === child) control.child = null;
      if (control?.cancelled) {
        try {
          assertTranslationActive(control);
        } catch (cancelledError) {
          reject(cancelledError);
          return;
        }
      }
      reject(createCodexExecutionError({ stdout, stderr, spawnError: error, stage }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (control?.child === child) control.child = null;
      if (control?.cancelled) {
        try {
          assertTranslationActive(control);
        } catch (cancelledError) {
          reject(cancelledError);
          return;
        }
      }
      if (code === 0) resolve(stdout);
      else reject(createCodexExecutionError({ exitCode: code, stdout, stderr, stage }));
    });
    child.stdin.end(stdinText, "utf8");
  });
}

function normalizeErrorDetails(error) {
  if (!Array.isArray(error?.details)) return [];
  return error.details
    .map((detail) => singleLine(detail))
    .filter(Boolean)
    .slice(0, 12);
}

async function cleanupTempDirSafely(tempDir, requestId, imageIndex) {
  try {
    await removeTranslatorTempDir(tempDir);
    logProgress(requestId, imageIndex, "임시 파일 정리 완료");
  } catch (error) {
    logProgress(requestId, imageIndex, `임시 파일 사용 중 · 번역 결과에는 영향 없음 · 3초 뒤 정리 예약 · ${error.code || error.message}`);
    const timer = setTimeout(async () => {
      try {
        await removeTranslatorTempDir(tempDir, { maxRetries: 20, retryDelay: 250 });
        logProgress(requestId, imageIndex, "지연 임시 파일 정리 완료");
      } catch (retryError) {
        logProgress(requestId, imageIndex, `임시 파일 자동 정리 실패 · ${retryError.code || retryError.message}`);
      }
    }, 3000);
    timer.unref();
  }
}

function isAuthorized(request) {
  const supplied = String(request.headers["x-bridge-token"] || "");
  const expected = Buffer.from(token, "utf8");
  const actual = Buffer.from(supplied, "utf8");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function setCorsHeaders(request, response) {
  const origin = String(request.headers.origin || "");
  if (origin.startsWith("chrome-extension://")) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");
  response.setHeader("Cache-Control", "no-store");
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, "요청 데이터가 너무 큽니다."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "JSON 요청이 올바르지 않습니다."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function logProgress(requestId, imageIndex, message) {
  const now = new Date();
  const timestamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  const safeMessage = String(message).replace(/\r?\n/g, " | ").slice(0, 1400);
  const imageLabel = imageIndex === null ? "?" : imageIndex;
  console.log(`[${timestamp}] [작업 #${requestId} · 이미지 #${imageLabel}] ${safeMessage}`);
}

function normalizeImageIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeRenderMode(value) {
  return value === "codex-image" ? "codex-image" : "local";
}

function estimateBase64Bytes(value) {
  const text = typeof value === "string" ? value : "";
  return Math.max(0, Math.floor(text.length * 0.75) - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}초`;
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

function formatSource(metadata) {
  const element = metadata?.elementType ? `<${String(metadata.elementType).slice(0, 20)}>` : "이미지";
  const rawSource = String(metadata?.sourceUrl || "");
  if (/^(canvas|inline-svg|screen-capture):/.test(rawSource)) return `${element} · ${rawSource}`;
  try {
    const url = new URL(rawSource);
    const pathName = decodeURIComponent(url.pathname).slice(0, 120);
    return `${element} · ${url.hostname}${pathName}`;
  } catch {
    return `${element} · 출처 미상`;
  }
}

function buildLightTextDetailGuide(details, images) {
  if (!Array.isArray(details) || details.length === 0) return "";
  const lines = [
    "<bright_text_detail_guide>",
    "다음 첨부들은 원본의 어두운 고대비 패널을 확대해 굵은 흰색 글자 중심부를 검게 반전한 OCR 보조 자료다. 얇은 선과 망점은 약화되어 있다."
  ];
  for (const detail of details) {
    const attachmentIndex = images.indexOf(detail.path);
    if (attachmentIndex < 0) continue;
    lines.push(
      `${attachmentIndex + 1}번째 첨부 = 원본 정규화 좌표 [${detail.box.join(", ")}] 상세. 이 첨부 자체의 좌표가 아니라 이 원본 좌표 범위로 box를 환산하라.`
    );
  }
  lines.push(
    "상세 크롭의 검은 덩어리가 실제 가나·한자 형태인지 원본과 대조하고, 광선·비산물·눈 하이라이트·인체 윤곽은 텍스트로 반환하지 마라.",
    "</bright_text_detail_guide>"
  );
  return lines.join("\n");
}

function appendPromptGuide(prompt, guide) {
  return guide ? `${prompt}\n${guide}` : prompt;
}

function formatBox(box) {
  return Array.isArray(box)
    ? box.map((value) => Math.round(Number(value) * 10) / 10).join(", ")
    : "좌표 없음";
}
