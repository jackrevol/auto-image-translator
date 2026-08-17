const translateButton = document.getElementById("translate");
const clearButton = document.getElementById("clear");
const optionsButton = document.getElementById("options");
const status = document.getElementById("status");

translateButton.addEventListener("click", async () => {
  setBusy(true, "화면을 읽는 중입니다…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "START_TRANSLATION" });
    if (!response?.ok) throw new Error(response?.error || "번역을 시작하지 못했습니다.");
    setStatus(`${response.count}개 이미지 처리를 마쳤습니다.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

clearButton.addEventListener("click", async () => {
  setBusy(true, "번역을 지우는 중입니다…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "CLEAR_TRANSLATIONS" });
    if (!response?.ok) throw new Error(response?.error || "번역을 지우지 못했습니다.");
    setStatus("원본 화면으로 돌아갔습니다.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

function setBusy(busy, message) {
  translateButton.disabled = busy;
  clearButton.disabled = busy;
  if (message) setStatus(message, "working");
}

function setStatus(message, type = "") {
  status.textContent = message;
  status.dataset.type = type;
}
