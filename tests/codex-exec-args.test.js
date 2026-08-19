"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCodexExecArgs, buildCodexImageRenderArgs } = require("../bridge/codex-exec-args.js");

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

test("Codex 이미지 렌더 실행은 내장 이미지 생성을 켜고 사용자 설정을 격리한다", () => {
  const args = buildCodexImageRenderArgs({
    tempDir: "C:\\Temp\\render-job",
    imagePath: "original.png",
    outputPath: "render-result.txt"
  });

  assert.equal(args[0], "exec");
  assert.ok(args.includes("--ignore-user-config"));
  assert.deepEqual(args.slice(args.indexOf("--enable"), args.indexOf("--sandbox")), [
    "--enable",
    "image_generation"
  ]);
  assert.equal(args[args.indexOf("--image") + 1], "original.png");
  assert.ok(!args.includes("--output-schema"));
});
