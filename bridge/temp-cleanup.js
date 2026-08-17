"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function verifyTranslatorTempDir(tempDir) {
  const resolved = path.resolve(tempDir);
  const expectedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith("jit-")) {
    throw new Error("임시 폴더 경로 검증에 실패했습니다.");
  }
  return resolved;
}

async function removeTranslatorTempDir(tempDir, options = {}) {
  const resolved = verifyTranslatorTempDir(tempDir);
  await fs.promises.rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: Number.isInteger(options.maxRetries) ? options.maxRetries : 12,
    retryDelay: Number.isInteger(options.retryDelay) ? options.retryDelay : 150
  });
}

module.exports = {
  removeTranslatorTempDir,
  verifyTranslatorTempDir
};
