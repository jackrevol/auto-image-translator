const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { removeTranslatorTempDir, verifyTranslatorTempDir } = require("../bridge/temp-cleanup.js");

test("번역기가 생성한 임시 폴더와 파일을 제거한다", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-test-"));
  fs.writeFileSync(path.join(tempDir, "result.json"), "{}", "utf8");
  await removeTranslatorTempDir(tempDir, { maxRetries: 2, retryDelay: 20 });
  assert.equal(fs.existsSync(tempDir), false);
});

test("번역기 범위 밖의 폴더는 삭제 대상으로 허용하지 않는다", () => {
  const unrelatedPath = path.join(os.tmpdir(), "unrelated-folder");
  assert.throws(() => verifyTranslatorTempDir(unrelatedPath), /경로 검증/);
});
