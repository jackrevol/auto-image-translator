const DEFAULTS = {
  bridgeUrl: "http://127.0.0.1:38473",
  bridgeToken: "",
  minWidth: 120,
  minHeight: 80,
  parallelism: 3,
  maxAutoQaAttempts: 3
};

const form = document.getElementById("settings-form");
const bridgeUrlInput = document.getElementById("bridge-url");
const bridgeTokenInput = document.getElementById("bridge-token");
const minWidthInput = document.getElementById("min-width");
const minHeightInput = document.getElementById("min-height");
const parallelismInput = document.getElementById("parallelism");
const maxAutoQaAttemptsInput = document.getElementById("max-auto-qa-attempts");
const toggleTokenButton = document.getElementById("toggle-token");
const testConnectionButton = document.getElementById("test-connection");
const saveStatus = document.getElementById("save-status");

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const settings = {
      bridgeUrl: normalizeBridgeUrl(bridgeUrlInput.value),
      bridgeToken: bridgeTokenInput.value.trim(),
      minWidth: clampNumber(minWidthInput.value, 40, 1000, DEFAULTS.minWidth),
      minHeight: clampNumber(minHeightInput.value, 30, 1000, DEFAULTS.minHeight),
      parallelism: clampNumber(parallelismInput.value, 1, 6, DEFAULTS.parallelism),
      maxAutoQaAttempts: clampNumber(
        maxAutoQaAttemptsInput.value,
        1,
        5,
        DEFAULTS.maxAutoQaAttempts
      )
    };

    await chrome.storage.local.set(settings);
    showStatus("설정을 저장했습니다.", "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
});

toggleTokenButton.addEventListener("click", () => {
  const show = bridgeTokenInput.type === "password";
  bridgeTokenInput.type = show ? "text" : "password";
  toggleTokenButton.textContent = show ? "숨기기" : "보기";
  toggleTokenButton.setAttribute("aria-label", show ? "연결 토큰 숨기기" : "연결 토큰 표시");
});

testConnectionButton.addEventListener("click", async () => {
  testConnectionButton.disabled = true;
  showStatus("로컬 브리지에 연결 중입니다…", "working");
  try {
    const url = normalizeBridgeUrl(bridgeUrlInput.value);
    const response = await fetch(`${url}/status`, {
      headers: { "X-Bridge-Token": bridgeTokenInput.value.trim() }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "연결하지 못했습니다.");
    showStatus(`연결됨: ${result.codex}`, "success");
  } catch (error) {
    showStatus(error.message === "Failed to fetch" ? "브리지가 실행 중인지 확인해 주세요." : error.message, "error");
  } finally {
    testConnectionButton.disabled = false;
  }
});

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  bridgeUrlInput.value = settings.bridgeUrl;
  bridgeTokenInput.value = settings.bridgeToken;
  minWidthInput.value = settings.minWidth;
  minHeightInput.value = settings.minHeight;
  parallelismInput.value = settings.parallelism;
  maxAutoQaAttemptsInput.value = settings.maxAutoQaAttempts;
}

function normalizeBridgeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("127.0.0.1 또는 localhost 주소만 사용할 수 있습니다.");
  }
  return url.origin;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
}

function showStatus(message, type) {
  saveStatus.textContent = message;
  saveStatus.dataset.type = type;
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => { saveStatus.textContent = ""; }, 3500);
}
