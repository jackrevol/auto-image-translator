const DEFAULT_SETTINGS = {
  bridgeUrl: "http://127.0.0.1:38473",
  bridgeToken: "",
  minWidth: 120,
  minHeight: 80,
  parallelism: 3,
  maxAutoQaAttempts: 3,
  skipVisualQa: false,
  renderMode: "local"
};
const CONTEXT_MENU_ID = "translate-single-image";
const IMAGE_ANALYSIS_TIMEOUT_MS = 60 * 60 * 1000;
const CODEX_IMAGE_ANALYSIS_TIMEOUT_MS = 3 * 60 * 60 * 1000;

chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  const saved = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (reason === "update" && ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.3.1", "1.4.0"].includes(previousVersion)) {
    saved.minWidth = DEFAULT_SETTINGS.minWidth;
    saved.minHeight = DEFAULT_SETTINGS.minHeight;
  }
  await chrome.storage.local.set(saved);
  createContextMenu();
});

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "이 이미지만 한국어로 번역",
      contexts: ["image"]
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  startSingleImageTranslation(info, tab).catch(async (error) => {
    console.error("[이미지 한글 번역기] 우클릭 이미지 번역 실패", error);
    if (tab?.id) {
      await chrome.tabs.sendMessage(
        tab.id,
        { type: "SHOW_TRANSLATION_ERROR", error: error.message },
        Number.isInteger(info.frameId) ? { frameId: info.frameId } : undefined
      ).catch(() => {});
    }
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "translate-visible-images") {
    startTranslation().catch((error) => console.error(error));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_TRANSLATION") {
    startTranslation()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLEAR_TRANSLATIONS") {
    clearTranslations()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "ANALYZE_IMAGE") {
    if (!sender.tab) {
      sendResponse({ ok: false, error: "웹페이지에서 보낸 요청이 아닙니다." });
      return false;
    }

    analyzeImage(message.image, message.metadata)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REPORT_REPLACEMENT") {
    if (!sender.tab) {
      sendResponse({ ok: false, error: "웹페이지에서 보낸 교체 결과가 아닙니다." });
      return false;
    }

    reportReplacement(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CAPTURE_VIEWPORT") {
    if (!sender.tab?.windowId) {
      sendResponse({ ok: false, error: "캡처할 탭을 찾지 못했습니다." });
      return false;
    }
    chrome.tabs.query({ active: true, windowId: sender.tab.windowId })
      .then(([activeTab]) => {
        if (activeTab?.id !== sender.tab.id) {
          throw new Error("번역이 끝날 때까지 대상 탭을 활성 상태로 유지해 주세요.");
        }
        return chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 94 });
      })
      .then((screenshot) => sendResponse({ ok: true, screenshot }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DOWNLOAD_IMAGE") {
    if (!sender.tab) {
      sendResponse({ ok: false, error: "웹페이지에서 보낸 요청이 아닙니다." });
      return false;
    }
    downloadImage(message.url, sender.tab.url)
      .then((image) => sendResponse({ ok: true, image }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) {
    throw new Error("활성 탭을 찾지 못했습니다.");
  }
  if (!/^https?:/i.test(tab.url || "")) {
    throw new Error("일반 웹페이지(http/https)에서만 사용할 수 있습니다.");
  }
  return tab;
}

async function ensureContentScript(tabId, frameId = null) {
  const target = Number.isInteger(frameId) ? { tabId, frameIds: [frameId] } : { tabId };
  await chrome.scripting.insertCSS({
    target,
    files: ["content.css"]
  });
  await chrome.scripting.executeScript({
    target,
    files: ["content.js"]
  });
}

async function startSingleImageTranslation(info, tab) {
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
    throw new Error("일반 웹페이지의 이미지에서만 사용할 수 있습니다.");
  }
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!settings.bridgeToken?.trim()) {
    await chrome.runtime.openOptionsPage();
    throw new Error("먼저 로컬 브리지를 실행하고 연결 토큰을 저장해 주세요.");
  }

  const frameId = Number.isInteger(info.frameId) ? info.frameId : 0;
  await ensureContentScript(tab.id, frameId);
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "TRANSLATE_SINGLE_IMAGE",
    srcUrl: info.srcUrl || "",
    settings: {
      force: true,
      minWidth: 1,
      minHeight: 1
    }
  }, { frameId });
  if (!response?.ok) throw new Error(response?.error || "선택한 이미지를 번역하지 못했습니다.");
  return { count: response.count || 0 };
}

async function startTranslation() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!settings.bridgeToken?.trim()) {
    await chrome.runtime.openOptionsPage();
    throw new Error("먼저 로컬 브리지를 실행하고 연결 토큰을 저장해 주세요.");
  }

  const tab = await getActiveTab();
  await ensureContentScript(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "TRANSLATE_PAGE",
    settings: {
      minWidth: Number(settings.minWidth) || DEFAULT_SETTINGS.minWidth,
      minHeight: Number(settings.minHeight) || DEFAULT_SETTINGS.minHeight,
      parallelism: Math.min(6, Math.max(1, Number(settings.parallelism) || DEFAULT_SETTINGS.parallelism))
    }
  });

  if (!response?.ok) {
    throw new Error(response?.error || "페이지 번역을 시작하지 못했습니다.");
  }
  return { count: response.count };
}

async function clearTranslations() {
  const tab = await getActiveTab();
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_TRANSLATIONS" });
    if (!response?.ok) throw new Error("초기화에 실패했습니다.");
  } catch (error) {
    if (/Receiving end does not exist/i.test(error.message)) return;
    throw error;
  }
}

async function analyzeImage(image, metadata = {}) {
  if (!image?.data || !image?.mimeType?.startsWith("image/")) {
    throw new Error("분석할 이미지 데이터가 올바르지 않습니다.");
  }
  if (image.data.length > 19_000_000) {
    throw new Error("이미지 데이터가 너무 큽니다.");
  }

  const { bridgeUrl, bridgeToken, maxAutoQaAttempts, skipVisualQa, renderMode } = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!bridgeToken?.trim()) throw new Error("로컬 브리지 연결 토큰이 설정되지 않았습니다.");
  const safeBridgeUrl = normalizeBridgeUrl(bridgeUrl);

  const controller = new AbortController();
  const analysisTimeout = renderMode === "codex-image"
    ? CODEX_IMAGE_ANALYSIS_TIMEOUT_MS
    : IMAGE_ANALYSIS_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), analysisTimeout);
  try {
    const response = await fetch(
      `${safeBridgeUrl}/translate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Token": bridgeToken.trim()
        },
        signal: controller.signal,
        body: JSON.stringify({
          image,
          metadata: {
            ...metadata,
            maxAutoQaAttempts: Math.min(5, Math.max(1, Number(maxAutoQaAttempts) || 3)),
            skipVisualQa: skipVisualQa === true,
            renderMode: renderMode === "codex-image" ? "codex-image" : "local"
          }
        })
      }
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const summary = payload?.error || `로컬 브리지 오류 (${response.status})`;
      const details = Array.isArray(payload?.details)
        ? payload.details.filter(Boolean).slice(0, 12)
        : [];
      throw new Error([summary, ...details.map((detail) => `• ${detail}`)].join("\n"));
    }

    return {
      regions: Array.isArray(payload?.regions) ? payload.regions : [],
      editedImage: payload?.editedImage || null,
      qualityReview: payload?.qualityReview || null,
      bridgeRequestId: Number(payload?.bridgeRequestId) || null
    };
  } catch (error) {
    if (error.name === "AbortError") {
      const hours = analysisTimeout / 60 / 60 / 1000;
      throw new Error(`이미지 분석 시간이 ${hours}시간을 초과했습니다.`);
    }
    if (error instanceof SyntaxError) throw new Error("로컬 브리지 응답을 해석하지 못했습니다.");
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function reportReplacement(message) {
  const requestId = Number(message?.bridgeRequestId);
  if (!Number.isInteger(requestId) || requestId <= 0) return;

  const { bridgeUrl, bridgeToken } = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!bridgeToken?.trim()) return;
  const safeBridgeUrl = normalizeBridgeUrl(bridgeUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${safeBridgeUrl}/commit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Token": bridgeToken.trim()
      },
      signal: controller.signal,
      body: JSON.stringify({
        bridgeRequestId: requestId,
        imageIndex: message?.metadata?.index,
        elementType: message?.metadata?.elementType,
        success: message?.success !== false,
        error: String(message?.error || "").slice(0, 500)
      })
    });
    if (!response.ok) throw new Error(`교체 확인 전송 실패 (${response.status})`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeBridgeUrl(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_SETTINGS.bridgeUrl));
  } catch {
    throw new Error("로컬 브리지 주소가 올바르지 않습니다.");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("보안을 위해 로컬 브리지 주소만 사용할 수 있습니다.");
  }
  return url.origin;
}

async function downloadImage(rawUrl, pageUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""), pageUrl);
  } catch {
    throw new Error("이미지 원본 주소가 올바르지 않습니다.");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("HTTP 또는 HTTPS 이미지 주소만 다운로드할 수 있습니다.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url.href, {
      method: "GET",
      credentials: "include",
      cache: "force-cache",
      redirect: "follow",
      referrer: /^https?:/i.test(pageUrl || "") ? pageUrl : undefined,
      referrerPolicy: "strict-origin-when-cross-origin",
      headers: { "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`원본 이미지 다운로드 실패 (${response.status})`);

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > 30 * 1024 * 1024) throw new Error("원본 이미지가 30MB보다 큽니다.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error("원본 이미지 크기가 올바르지 않습니다.");
    const mimeType = detectImageMime(bytes, response.headers.get("content-type"));
    if (!mimeType) throw new Error("다운로드한 파일이 지원되는 이미지가 아닙니다.");
    return { mimeType, data: bytesToBase64(bytes), sourceUrl: response.url || url.href };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("원본 이미지 다운로드 시간이 초과되었습니다.");
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function detectImageMime(bytes, contentType) {
  const type = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/svg+xml"].includes(type)) return type;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  const header = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512)).trimStart();
  if (header.startsWith("<svg") || header.startsWith("<?xml") && header.includes("<svg")) return "image/svg+xml";
  return null;
}

function bytesToBase64(bytes) {
  const chunks = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}
