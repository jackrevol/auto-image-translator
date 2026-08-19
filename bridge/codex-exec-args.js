"use strict";

function buildCodexExecArgs({ tempDir, images, schemaPath, outputPath }) {
  return [
    "exec",
    "--ephemeral",
    // 로그인 정보는 유지하되 사용자 플러그인·MCP·후크 설정은 OCR 자동화에서 격리한다.
    "--ignore-user-config",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--color", "never",
    "-C", tempDir,
    "--image", ...images,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "-"
  ];
}

function buildCodexImageRenderArgs({ tempDir, imagePath, outputPath }) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--enable", "image_generation",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--color", "never",
    "--json",
    "-C", tempDir,
    "--image", imagePath,
    "--output-last-message", outputPath,
    "-"
  ];
}

module.exports = { buildCodexExecArgs, buildCodexImageRenderArgs };
