"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCodexExecArgs } = require("../bridge/codex-exec-args.js");

test("OCR Codex 실행은 로그인만 공유하고 사용자 플러그인 설정을 격리한다", () => {
  const args = buildCodexExecArgs({
    tempDir: "C:\\Temp\\ocr-job",
    images: ["original.png", "enhanced.png"],
    schemaPath: "response-schema.json",
    outputPath: "result.json"
  });

  assert.equal(args[0], "exec");
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.deepEqual(args.slice(args.indexOf("--image") + 1, args.indexOf("--output-schema")), [
    "original.png",
    "enhanced.png"
  ]);
});
