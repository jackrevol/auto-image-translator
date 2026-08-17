(function initializeImageTranslator() {
  if (window.__imageTranslatorVersion === "2.8.0") return;
  window.__imageTranslatorVersion = "2.8.0";
  window.__imageTranslatorLoaded = true;

  const state = {
    replacements: [],
    running: false,
    translatedElements: new WeakSet(),
    manualReviewElements: new WeakSet(),
    captureTail: Promise.resolve(),
    contextElement: null
  };
  const SMALL_IMAGE = Symbol("small-image");

  document.addEventListener("contextmenu", (event) => {
    state.contextElement = findContextImageElement(event.composedPath());
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TRANSLATE_PAGE") {
      translatePage(message.settings)
        .then((count) => sendResponse({ ok: true, count }))
        .catch((error) => {
          showToast(error.message, "error", 6000);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (message?.type === "CLEAR_TRANSLATIONS") {
      clearTranslations()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "TRANSLATE_SINGLE_IMAGE") {
      translateSingleImage(message.srcUrl, message.settings)
        .then((count) => sendResponse({ ok: true, count }))
        .catch((error) => {
          showToast(error.message, "error", 6000);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (message?.type === "SHOW_TRANSLATION_ERROR") {
      showToast(message.error || "이미지 번역에 실패했습니다.", "error", 6000);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  async function translateSingleImage(srcUrl, settings = {}) {
    if (state.running) throw new Error("이미 번역 중입니다. 잠시만 기다려 주세요.");
    let element = resolveContextImageElement(srcUrl);
    if (!element) throw new Error("우클릭한 이미지 요소를 페이지에서 찾지 못했습니다.");
    const manualReview = state.manualReviewElements.has(element);
    if (state.translatedElements.has(element) || element.dataset?.jitTranslated === "true") {
      if (!manualReview) throw new Error("이미 번역된 이미지입니다.");
      element = await restoreTranslatedElement(element);
    }

    state.running = true;
    showToast("선택한 이미지의 원본을 읽고 있습니다…", "progress");
    let metadata = null;
    let bridgeRequestId = null;
    try {
      let fullImage = await getDirectElementImage(element, { ...settings, force: true }).catch((error) => {
        console.warn("[이미지 한글 번역기] 선택 이미지 원본 다운로드 실패, 캡처 대기", element, error);
        return null;
      });
      if (!fullImage || fullImage === SMALL_IMAGE) {
        if (document.visibilityState !== "visible") throw new Error("선택한 이미지의 원본을 읽지 못했습니다.");
        fullImage = await withCaptureLock(async () => {
          await prepareElement(element);
          return captureFullElementImage(element, getCaptureTargets(element));
        });
      }
      if (!fullImage) throw new Error("선택한 이미지 전체를 캡처하지 못했습니다.");

      const parsedImage = parseDataUrl(fullImage);
      metadata = {
        ...describeElementSource(element, 1),
        mode: "context-menu",
        qualityReviewMode: manualReview ? "manual" : "automatic"
      };
      showToast("선택한 이미지에서 일본어를 분석하고 있습니다…", "progress");
      const response = await chrome.runtime.sendMessage({
        type: "ANALYZE_IMAGE",
        metadata,
        image: { mimeType: parsedImage.mimeType, data: parsedImage.data }
      });
      if (!response?.ok) throw new Error(response?.error || "이미지 분석에 실패했습니다.");
      bridgeRequestId = response.bridgeRequestId;
      const translatedRegions = response.regions?.length || 0;
      if (!translatedRegions) {
        showToast("선택한 이미지에서 일본어를 찾지 못했습니다.", "info", 3500);
        return 0;
      }
      if (!response.editedImage?.data) throw new Error("재생성된 이미지 데이터가 없습니다.");

      const replacementUrl = `data:${response.editedImage.mimeType || "image/webp"};base64,${response.editedImage.data}`;
      const replacedElement = await replaceElementImage(element, replacementUrl);
      state.translatedElements.add(replacedElement);
      if (response.qualityReview?.requiresUserReview) {
        state.manualReviewElements.add(replacedElement);
      }
      await reportReplacement(bridgeRequestId, metadata, true);
      const reviewMessage = response.qualityReview?.requiresUserReview
        ? " · 자동 검수 미통과(우클릭으로 추가 검수 가능)"
        : " · 품질검수 통과";
      showToast(`선택한 이미지 교체 완료 · ${translatedRegions}개 문구 번역${reviewMessage}`, response.qualityReview?.requiresUserReview ? "info" : "success", 5000);
      return 1;
    } catch (error) {
      if (bridgeRequestId) await reportReplacement(bridgeRequestId, metadata, false, error.message);
      throw error;
    } finally {
      state.running = false;
    }
  }

  function findContextImageElement(path) {
    for (const node of path || []) {
      if (node instanceof HTMLImageElement || node instanceof HTMLCanvasElement) return node;
      if (node instanceof SVGElement) return node.ownerSVGElement || node;
      if (node instanceof Element && getBackgroundImageSource(node)) return node;
    }
    return null;
  }

  function resolveContextImageElement(srcUrl) {
    if (state.contextElement?.isConnected) return state.contextElement;
    let targetUrl = "";
    try { targetUrl = new URL(String(srcUrl || ""), document.baseURI).href; } catch { targetUrl = String(srcUrl || ""); }
    for (const element of collectImageElements(document)) {
      const source = element instanceof HTMLImageElement
        ? getImageElementSource(element)
        : element instanceof HTMLElement ? getBackgroundImageSource(element) : null;
      if (source === targetUrl) return element;
    }
    return null;
  }

  async function translatePage(settings) {
    if (state.running) throw new Error("이미 번역 중입니다. 잠시만 기다려 주세요.");
    state.running = true;
    showToast("페이지 전체에서 이미지를 찾고 있습니다…", "progress");

    const originalScroll = { x: window.scrollX, y: window.scrollY };
    const rootStyle = document.documentElement.style;
    const originalScrollBehavior = rootStyle.scrollBehavior;
    rootStyle.scrollBehavior = "auto";

    try {
      const scannedThisRun = new WeakSet();
      let candidates = findPageImageElements(settings, scannedThisRun);
      if (candidates.length === 0) {
        throw new Error("현재 페이지에서 번역할 크기의 이미지를 찾지 못했습니다.");
      }

      let translatedCount = 0;
      let regionCount = 0;
      let processedCount = 0;
      let failedCount = 0;
      let skippedSmallCount = 0;
      let lastError = null;
      const parallelism = Math.min(6, Math.max(1, Number(settings.parallelism) || 3));

      for (let round = 0; round < 3 && candidates.length > 0; round += 1) {
        const results = await mapWithConcurrency(candidates, parallelism, async (element) => {
          const jobIndex = ++processedCount;
          let metadata = null;
          let bridgeRequestId = null;
          showToast(`이미지 ${processedCount}개 처리 중 · 최대 ${parallelism}개 병렬`, "progress");
          let translatedRegions = 0;

          try {
            let fullImage = await getDirectElementImage(element, settings).catch((error) => {
              console.warn("[이미지 한글 번역기] 원본 URL 다운로드 실패, 캡처 대기", element, error);
              return null;
            });

            if (fullImage === SMALL_IMAGE) {
              return { element, translatedRegions: 0, error: null, skippedSmall: true };
            }

            if (!fullImage && document.visibilityState === "visible") {
              fullImage = await withCaptureLock(async () => {
                await prepareElement(element);
                const targets = getCaptureTargets(element);
                return captureFullElementImage(element, targets);
              });
            }
            if (!fullImage) throw new Error("이미지 전체를 캡처하지 못했습니다.");

            const parsedImage = parseDataUrl(fullImage);
            metadata = describeElementSource(element, jobIndex);
            const response = await chrome.runtime.sendMessage({
              type: "ANALYZE_IMAGE",
              metadata,
              image: {
                mimeType: parsedImage.mimeType,
                data: parsedImage.data
              }
            });
            if (!response?.ok) throw new Error(response?.error || "이미지 분석에 실패했습니다.");
            bridgeRequestId = response.bridgeRequestId;

            translatedRegions = response.regions?.length || 0;
            if (translatedRegions > 0) {
              if (!response.editedImage?.data) throw new Error("재생성된 이미지 데이터가 없습니다.");
              const replacementUrl = `data:${response.editedImage.mimeType || "image/webp"};base64,${response.editedImage.data}`;
              const replacedElement = await replaceElementImage(element, replacementUrl);
              state.translatedElements.add(replacedElement);
              if (response.qualityReview?.requiresUserReview) {
                state.manualReviewElements.add(replacedElement);
              }
              await reportReplacement(bridgeRequestId, metadata, true);
              translatedCount += 1;
              regionCount += translatedRegions;
              showToast(`${jobIndex}번 이미지 교체 완료 · 현재 ${translatedCount}개 반영`, "success", 2400);
            }
            return { element, translatedRegions, committed: translatedRegions > 0, error: null };
          } catch (error) {
            console.warn("[이미지 한글 번역기] 이미지 처리 실패", element, error);
            if (bridgeRequestId) await reportReplacement(bridgeRequestId, metadata, false, error.message);
            return { element, translatedRegions: 0, error };
          } finally {
            scannedThisRun.add(element);
          }
        });

        for (const result of results) {
          if (result.skippedSmall) {
            skippedSmallCount += 1;
            continue;
          }
          if (result.error) {
            failedCount += 1;
            lastError = result.error;
            continue;
          }
        }

        const fatalError = results.find((result) =>
          result.error && /로컬 브리지|Codex 실행|Failed to fetch|연결 토큰/.test(result.error.message)
        )?.error;
        if (fatalError) throw fatalError;

        await waitForPaint(300);
        candidates = findPageImageElements(settings, scannedThisRun);
      }

      if (processedCount > 0 && failedCount === processedCount) {
        throw lastError || new Error("이미지를 처리하지 못했습니다.");
      }

      if (!regionCount) {
        showToast(`일본어를 찾지 못했습니다. · 소형 이미지 ${skippedSmallCount}개 제외`, "info", 3500);
      } else {
        showToast(`${translatedCount}개 이미지, ${regionCount}개 문구 번역 · 소형 ${skippedSmallCount}개 제외`, "success", 4000);
      }
      return translatedCount;
    } finally {
      window.scrollTo(originalScroll.x, originalScroll.y);
      rootStyle.scrollBehavior = originalScrollBehavior;
      state.running = false;
    }
  }

  async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function withCaptureLock(task) {
    const previous = state.captureTail;
    let release;
    state.captureTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  function findPageImageElements(settings = {}, scannedThisRun = new WeakSet()) {
    const minWidth = Math.max(40, Number(settings.minWidth) || 120);
    const minHeight = Math.max(30, Number(settings.minHeight) || 80);
    const elements = collectImageElements(document);

    return elements
      .filter((element) => {
        if (
          scannedThisRun.has(element) ||
          state.translatedElements.has(element) ||
          element.dataset?.jitTranslated === "true"
        ) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width >= minWidth &&
          rect.height >= minHeight &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity) > 0.05
        );
      })
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return (rectA.top + window.scrollY) - (rectB.top + window.scrollY) || rectA.left - rectB.left;
      });
  }

  function collectImageElements(root) {
    const found = new Set(root.querySelectorAll("img, canvas, svg"));
    const allElements = root.querySelectorAll("*");
    for (const element of allElements) {
      if (element !== document.body && element !== document.documentElement) {
        const style = getComputedStyle(element);
        const before = getComputedStyle(element, "::before");
        const after = getComputedStyle(element, "::after");
        if (
          style.backgroundImage?.includes("url(") ||
          before.backgroundImage?.includes("url(") ||
          after.backgroundImage?.includes("url(")
        ) {
          found.add(element);
        }
      }
      if (element.shadowRoot) {
        for (const nested of collectImageElements(element.shadowRoot)) found.add(nested);
      }
    }
    return [...found];
  }

  async function getDirectElementImage(element, settings = {}) {
    let dataUrl = null;

    if (element instanceof HTMLImageElement) {
      const source = getImageElementSource(element);
      if (source) dataUrl = await downloadSourceUrl(source);
    } else if (element instanceof HTMLCanvasElement) {
      try { dataUrl = element.toDataURL("image/png"); } catch { dataUrl = null; }
    } else if (element instanceof SVGElement) {
      const serialized = new XMLSerializer().serializeToString(element);
      dataUrl = await blobToDataUrl(new Blob([serialized], { type: "image/svg+xml" }));
    } else {
      const source = getBackgroundImageSource(element);
      if (source) dataUrl = await downloadSourceUrl(source);
    }

    return dataUrl ? normalizeSourceImage(dataUrl, settings) : null;
  }

  function getImageElementSource(element) {
    const direct =
      element.currentSrc ||
      element.getAttribute("src") ||
      element.getAttribute("data-src") ||
      element.getAttribute("data-original") ||
      element.getAttribute("data-lazy-src");
    if (direct) return new URL(direct, document.baseURI).href;

    const srcset = element.getAttribute("srcset") || element.getAttribute("data-srcset");
    const firstCandidate = srcset?.split(",", 1)[0]?.trim().split(/\s+/, 1)[0];
    return firstCandidate ? new URL(firstCandidate, document.baseURI).href : null;
  }

  function getBackgroundImageSource(element) {
    const styles = [
      getComputedStyle(element).backgroundImage,
      getComputedStyle(element, "::before").backgroundImage,
      getComputedStyle(element, "::after").backgroundImage
    ];
    for (const value of styles) {
      const match = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s][^)]*))\s*\)/i.exec(value || "");
      const source = match?.[1] || match?.[2] || match?.[3]?.trim();
      if (source) return new URL(source, document.baseURI).href;
    }
    return null;
  }

  async function downloadSourceUrl(url) {
    if (/^(data|blob):/i.test(url)) {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error(`페이지 이미지 읽기 실패 (${response.status})`);
      return blobToDataUrl(await response.blob());
    }

    const response = await chrome.runtime.sendMessage({ type: "DOWNLOAD_IMAGE", url });
    if (response?.ok && response.image?.data) {
      return `data:${response.image.mimeType};base64,${response.image.data}`;
    }

    const localResponse = await fetch(url, { credentials: "include" });
    if (!localResponse.ok) throw new Error(response?.error || `원본 이미지 다운로드 실패 (${localResponse.status})`);
    return blobToDataUrl(await localResponse.blob());
  }

  async function normalizeSourceImage(dataUrl, settings = {}) {
    const image = await loadImage(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error("원본 이미지 크기를 읽지 못했습니다.");
    const minWidth = Math.max(40, Number(settings.minWidth) || 120);
    const minHeight = Math.max(30, Number(settings.minHeight) || 80);
    if (!settings.force && (width < minWidth || height < minHeight)) return SMALL_IMAGE;
    const parsed = parseDataUrl(dataUrl);
    const preservesOriginal = ["image/jpeg", "image/png", "image/webp"].includes(parsed.mimeType.toLowerCase());
    const pixelCount = width * height;
    if (
      preservesOriginal &&
      Math.max(width, height) <= 8192 &&
      pixelCount <= 32_000_000 &&
      parsed.data.length <= 18_500_000
    ) {
      return dataUrl;
    }
    const scale = Math.min(
      1,
      8192 / Math.max(width, height),
      Math.sqrt(32_000_000 / pixelCount)
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { alpha: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.96);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("이미지 파일을 읽지 못했습니다."));
      reader.readAsDataURL(blob);
    });
  }

  function parseDataUrl(dataUrl) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl || "");
    if (!match) throw new Error("이미지 데이터 형식이 올바르지 않습니다.");
    return { mimeType: match[1], data: match[2] };
  }

  function describeElementSource(element, index) {
    let sourceUrl = null;
    if (element instanceof HTMLImageElement) sourceUrl = getImageElementSource(element);
    else if (element instanceof HTMLCanvasElement) sourceUrl = "canvas:";
    else if (element instanceof SVGElement) sourceUrl = "inline-svg:";
    else sourceUrl = getBackgroundImageSource(element);
    return {
      index,
      elementType: element.tagName?.toLowerCase() || "unknown",
      sourceUrl: sourceUrl || "screen-capture:",
      pageUrl: location.href
    };
  }

  async function prepareElement(element) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    await waitForPaint(120);
    const rect = element.getBoundingClientRect();
    const absoluteCenter = rect.top + window.scrollY + rect.height / 2;
    window.scrollTo(window.scrollX, Math.max(0, absoluteCenter - window.innerHeight / 2));

    if (element instanceof HTMLImageElement && !element.complete) {
      await Promise.race([
        new Promise((resolve) => element.addEventListener("load", resolve, { once: true })),
        waitForPaint(1500)
      ]);
    }
    if (element instanceof HTMLImageElement && element.decode) {
      await element.decode().catch(() => {});
    }
    await waitForPaint(180);
  }

  function getCaptureTargets(element) {
    const rect = element.getBoundingClientRect();
    const absolute = {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      right: rect.right + window.scrollX,
      bottom: rect.bottom + window.scrollY
    };
    const usableWidth = Math.max(200, window.innerWidth * 0.88);
    const usableHeight = Math.max(160, window.innerHeight * 0.82);
    const xCenters = makeTileCenters(absolute.left, absolute.right, usableWidth);
    const yCenters = makeTileCenters(absolute.top, absolute.bottom, usableHeight);
    const targets = [];

    for (const y of yCenters) {
      for (const x of xCenters) {
        targets.push({
          x: Math.max(0, x - window.innerWidth / 2),
          y: Math.max(0, y - window.innerHeight / 2)
        });
        if (targets.length >= 12) return targets;
      }
    }
    return targets;
  }

  function makeTileCenters(start, end, tileSize) {
    const length = Math.max(1, end - start);
    if (length <= tileSize) return [(start + end) / 2];
    const count = Math.ceil(length / tileSize);
    return Array.from({ length: count }, (_, index) => start + ((index + 0.5) / count) * length);
  }

  async function captureFullElementImage(element, targets) {
    const initialRect = element.getBoundingClientRect();
    if (initialRect.width < 1 || initialRect.height < 1) return null;
    const pixelScale = Math.min(
      Math.max(1, window.devicePixelRatio || 1),
      3200 / Math.max(initialRect.width, initialRect.height)
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(initialRect.width * pixelScale));
    canvas.height = Math.max(1, Math.round(initialRect.height * pixelScale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    let capturedTiles = 0;
    const backgroundOnly = !(
      element instanceof HTMLImageElement ||
      element instanceof HTMLCanvasElement ||
      element instanceof SVGElement
    );
    if (backgroundOnly) element.classList.add("jit-capture-background-only");

    try {
      for (const target of targets) {
        window.scrollTo(target.x, target.y);
        await waitForPaint(220);
        const screenshot = await captureViewport();
        const screenshotImage = await loadImage(screenshot);
        const cropped = cropVisibleElement(screenshotImage, element);
        if (!cropped) continue;
        const tile = await loadImage(cropped.dataUrl);
        context.drawImage(
          tile,
          cropped.left * canvas.width,
          cropped.top * canvas.height,
          cropped.width * canvas.width,
          cropped.height * canvas.height
        );
        capturedTiles += 1;
      }
      return capturedTiles ? canvas.toDataURL("image/jpeg", 0.94) : null;
    } finally {
      if (backgroundOnly) element.classList.remove("jit-capture-background-only");
    }
  }

  async function replaceElementImage(element, replacementUrl) {
    if (element instanceof HTMLImageElement) {
      if (!element.isConnected) throw new Error("교체할 이미지 요소가 페이지에서 사라졌습니다.");
      const pictureSources = element.parentElement?.tagName === "PICTURE"
        ? [...element.parentElement.querySelectorAll("source")]
        : [];
      const lazyAttributes = ["data-src", "data-original", "data-lazy-src", "data-srcset"];
      state.replacements.push({
        type: "img",
        element,
        src: element.getAttribute("src"),
        srcset: element.getAttribute("srcset"),
        sizes: element.getAttribute("sizes"),
        lazyAttributes: Object.fromEntries(lazyAttributes.map((name) => [name, element.getAttribute(name)])),
        pictureSources: pictureSources.map((source) => ({
          element: source,
          srcset: source.getAttribute("srcset"),
          sizes: source.getAttribute("sizes")
        }))
      });
      for (const source of pictureSources) {
        source.removeAttribute("srcset");
        source.removeAttribute("sizes");
      }
      element.removeAttribute("srcset");
      element.removeAttribute("sizes");
      for (const name of lazyAttributes) element.removeAttribute(name);
      element.dataset.jitTranslated = "true";
      element.src = replacementUrl;
      if (element.decode) await element.decode();
      else await waitForImageLoad(element);
      await waitForPaint(80);
      if (!element.isConnected || !element.currentSrc.startsWith("data:image/")) {
        throw new Error("페이지가 교체 이미지 주소를 다시 덮어썼습니다.");
      }
      return element;
    }

    if (element instanceof HTMLCanvasElement) {
      let original = null;
      try { original = element.toDataURL("image/png"); } catch { original = null; }
      const image = await loadImage(replacementUrl);
      const context = element.getContext("2d");
      state.replacements.push({ type: "canvas", element, original });
      element.dataset.jitTranslated = "true";
      context.clearRect(0, 0, element.width, element.height);
      context.drawImage(image, 0, 0, element.width, element.height);
      return element;
    }

    if (element instanceof SVGElement) {
      const replacement = document.createElement("img");
      const rect = element.getBoundingClientRect();
      replacement.src = replacementUrl;
      replacement.alt = element.getAttribute("aria-label") || "번역된 이미지";
      replacement.style.cssText = element.getAttribute("style") || "";
      replacement.style.width = `${rect.width}px`;
      replacement.style.height = `${rect.height}px`;
      replacement.dataset.jitTranslated = "true";
      state.replacements.push({ type: "svg", element, replacement });
      element.replaceWith(replacement);
      return replacement;
    }

    const style = element.style;
    state.replacements.push({
      type: "background",
      element,
      backgroundImage: style.backgroundImage,
      backgroundSize: style.backgroundSize,
      backgroundPosition: style.backgroundPosition,
      backgroundRepeat: style.backgroundRepeat
    });
    style.backgroundImage = `url("${replacementUrl}")`;
    element.classList.add("jit-replaced-background");
    element.dataset.jitTranslated = "true";
    return element;
  }

  async function captureViewport() {
    const toast = document.getElementById("jit-toast");
    if (toast) toast.hidden = true;
    await waitForPaint(40);
    try {
      const response = await chrome.runtime.sendMessage({ type: "CAPTURE_VIEWPORT" });
      if (!response?.ok || !response.screenshot) {
        throw new Error(response?.error || "현재 화면을 캡처하지 못했습니다.");
      }
      return response.screenshot;
    } finally {
      if (toast) toast.hidden = false;
    }
  }

  function waitForPaint(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function cropVisibleElement(screenshot, element) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left < 20 || bottom - top < 20 || rect.width <= 0 || rect.height <= 0) return null;

    const scaleX = screenshot.naturalWidth / window.innerWidth;
    const scaleY = screenshot.naturalHeight / window.innerHeight;
    const sourceX = Math.round(left * scaleX);
    const sourceY = Math.round(top * scaleY);
    const sourceWidth = Math.max(1, Math.round((right - left) * scaleX));
    const sourceHeight = Math.max(1, Math.round((bottom - top) * scaleY));
    const maxDimension = 1800;
    const resizeScale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * resizeScale));
    canvas.height = Math.max(1, Math.round(sourceHeight * resizeScale));
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(
      screenshot,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.92),
      left: (left - rect.left) / rect.width,
      top: (top - rect.top) / rect.height,
      width: (right - left) / rect.width,
      height: (bottom - top) / rect.height,
      pixelHeight: canvas.height,
      viewportHeight: bottom - top
    };
  }

  async function clearTranslations() {
    for (const replacement of [...state.replacements].reverse()) {
      await restoreReplacement(replacement);
    }
    state.replacements = [];
    state.translatedElements = new WeakSet();
    state.manualReviewElements = new WeakSet();
    showToast("번역 이미지를 지우고 원본을 복원했습니다.", "info", 2500);
  }

  async function restoreTranslatedElement(element) {
    const index = state.replacements.findIndex((replacement) =>
      replacement.element === element || replacement.replacement === element
    );
    if (index < 0) throw new Error("추가 검수할 이미지의 원본을 찾지 못했습니다.");
    const [replacement] = state.replacements.splice(index, 1);
    const originalElement = await restoreReplacement(replacement);
    state.translatedElements.delete(element);
    state.manualReviewElements.delete(element);
    return originalElement;
  }

  async function restoreReplacement(replacement) {
    if (replacement.type === "img") {
      restoreAttribute(replacement.element, "src", replacement.src);
      restoreAttribute(replacement.element, "srcset", replacement.srcset);
      restoreAttribute(replacement.element, "sizes", replacement.sizes);
      for (const [name, value] of Object.entries(replacement.lazyAttributes || {})) {
        restoreAttribute(replacement.element, name, value);
      }
      for (const source of replacement.pictureSources || []) {
        restoreAttribute(source.element, "srcset", source.srcset);
        restoreAttribute(source.element, "sizes", source.sizes);
      }
      delete replacement.element.dataset.jitTranslated;
      return replacement.element;
    }
    if (replacement.type === "canvas") {
      if (replacement.original && replacement.element.isConnected) {
        const image = await loadImage(replacement.original);
        const context = replacement.element.getContext("2d");
        context.clearRect(0, 0, replacement.element.width, replacement.element.height);
        context.drawImage(image, 0, 0, replacement.element.width, replacement.element.height);
      }
      delete replacement.element.dataset.jitTranslated;
      return replacement.element;
    }
    if (replacement.type === "svg") {
      if (replacement.replacement.isConnected) replacement.replacement.replaceWith(replacement.element);
      delete replacement.replacement.dataset.jitTranslated;
      return replacement.element;
    }
    const style = replacement.element.style;
    style.backgroundImage = replacement.backgroundImage;
    style.backgroundSize = replacement.backgroundSize;
    style.backgroundPosition = replacement.backgroundPosition;
    style.backgroundRepeat = replacement.backgroundRepeat;
    replacement.element.classList.remove("jit-replaced-background");
    delete replacement.element.dataset.jitTranslated;
    return replacement.element;
  }

  function restoreAttribute(element, name, value) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  function showToast(message, type = "info", duration = 0) {
    let toast = document.getElementById("jit-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "jit-toast";
      document.documentElement.appendChild(toast);
    }
    toast.className = `jit-toast-${type}`;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    if (duration) showToast.timer = setTimeout(() => { toast.hidden = true; }, duration);
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("현재 화면 캡처를 읽지 못했습니다."));
      image.src = source;
    });
  }

  function waitForImageLoad(element) {
    if (element.complete && element.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error("교체 이미지 로딩 시간이 초과되었습니다.")), 10_000);
      element.addEventListener("load", () => {
        clearTimeout(timeoutId);
        resolve();
      }, { once: true });
      element.addEventListener("error", () => {
        clearTimeout(timeoutId);
        reject(new Error("교체 이미지를 페이지에서 불러오지 못했습니다."));
      }, { once: true });
    });
  }

  async function reportReplacement(bridgeRequestId, metadata, success, error = "") {
    if (!bridgeRequestId) return;
    const response = await chrome.runtime.sendMessage({
      type: "REPORT_REPLACEMENT",
      bridgeRequestId,
      metadata,
      success,
      error
    }).catch((reportError) => ({ ok: false, error: reportError.message }));
    if (!response?.ok) {
      console.warn("[이미지 한글 번역기] 브릿지에 교체 결과를 알리지 못했습니다.", response?.error);
    }
  }
})();
