"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const {
  buildCodexImageRenderPrompt,
  buildCodexEndToEndPrompt,
  extractGeneratedImagePaths,
  resolveGeneratedImagePath,
  normalizeGeneratedImage,
  cleanupGeneratedImage
} = require("../bridge/codex-image-renderer.js");

test("최종 답변에 경로가 없어도 해당 Codex 실행 JSON 이벤트에서 생성 경로를 복구한다", () => {
  const events = [
    JSON.stringify({ type: "thread.started", thread_id: "abc" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "tool_call",
        output: "생성 완료: C:\\Users\\tester\\.codex\\generated_images\\session-1\\result.png"
      }
    })
  ].join("\n");

  assert.deepEqual(extractGeneratedImagePaths(events), [
    "C:\\Users\\tester\\.codex\\generated_images\\session-1\\result.png"
  ]);
});

test("Codex 통합 위임 프롬프트는 판독부터 자체 검수까지 한 번에 수행한다", () => {
  const prompt = buildCodexEndToEndPrompt({
    attempt: 2,
    issues: ["오른쪽 말풍선의 일본어가 남아 있음"]
  });

  assert.match(prompt, /별도의 OCR 좌표나 번역문이 제공되지 않는다/);
  assert.match(prompt, /직접 정밀 판독하고, 번역하고, 원문을 제거하고, 한국어를 식자/);
  assert.match(prompt, /결과를 자체 검수/);
  assert.match(prompt, /오른쪽 말풍선의 일본어가 남아 있음/);
});

test("Codex 이미지 렌더 프롬프트는 정확한 번역과 원본 보존을 강제한다", () => {
  const prompt = buildCodexImageRenderPrompt([{
    original: "おはよう",
    translated: "좋은 아침",
    box: [100, 200, 300, 400],
    layoutBox: [80, 180, 330, 430],
    regionKind: "dialogue",
    orientation: "vertical",
    fontSize: 42,
    textColor: "#111111",
    strokeColor: "#ffffff",
    strokeWidth: 2
  }]);

  assert.match(prompt, /내장 image_gen 도구/);
  assert.match(prompt, /원문 "おはよう" → 정확한 한국어 "좋은 아침"/);
  assert.match(prompt, /일본어가 없는 영역은 수정하지 마라/);
  assert.match(prompt, /로컬 절대 경로만/);
});

test("Codex 렌더가 만든 현재 세션 폴더 전체를 정리한다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jit-generated-cleanup-"));
  const session = path.join(root, "session-2");
  fs.mkdirSync(session);
  const selected = path.join(session, "selected.png");
  const discarded = path.join(session, "discarded.png");
  fs.writeFileSync(selected, Buffer.from("png"));
  fs.writeFileSync(discarded, Buffer.from("png"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await cleanupGeneratedImage(selected, root);

  assert.equal(fs.existsSync(session), false);
});

test("Codex 생성 경로는 generated_images 내부 파일만 허용한다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jit-generated-root-"));
  const session = path.join(root, "session-1");
  fs.mkdirSync(session);
  const imagePath = path.join(session, "result.png");
  fs.writeFileSync(imagePath, Buffer.from("png"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(resolveGeneratedImagePath(`결과: ${imagePath}`, root), fs.realpathSync.native(imagePath));
  assert.throws(
    () => resolveGeneratedImagePath(`결과: ${path.join(os.tmpdir(), "outside.png")}`, root),
    /결과 경로|안전한 생성 폴더/
  );
});

test("Codex 생성 이미지를 원본 크기의 무손실 WebP로 정규화한다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jit-codex-normalize-"));
  const source = path.join(root, "source.png");
  const generated = path.join(root, "generated.png");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await sharp({ create: { width: 80, height: 60, channels: 3, background: "white" } }).png().toFile(source);
  await sharp({ create: { width: 256, height: 256, channels: 3, background: "black" } }).png().toFile(generated);

  const buffer = await normalizeGeneratedImage(generated, source);
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.format, "webp");
  assert.deepEqual([metadata.width, metadata.height], [80, 60]);
});
