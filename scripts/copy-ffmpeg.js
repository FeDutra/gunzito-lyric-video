#!/usr/bin/env node
/**
 * copy-ffmpeg.js
 * Copies FFmpeg WASM core files from node_modules to public/ffmpeg/
 * Runs automatically via postinstall and before build (Vercel)
 */
const fs   = require("fs");
const path = require("path");

const src  = path.join(__dirname, "..", "node_modules", "@ffmpeg", "core", "dist", "esm");
const dest = path.join(__dirname, "..", "public", "ffmpeg");

const files = ["ffmpeg-core.js", "ffmpeg-core.wasm"];

if (!fs.existsSync(dest)) {
  fs.mkdirSync(dest, { recursive: true });
}

let copied = 0;
for (const file of files) {
  const srcFile  = path.join(src, file);
  const destFile = path.join(dest, file);
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, destFile);
    const size = (fs.statSync(destFile).size / 1024 / 1024).toFixed(1);
    console.log(`✅ Copied ${file} (${size} MB)`);
    copied++;
  } else {
    console.warn(`⚠️  Not found: ${srcFile}`);
  }
}

if (copied === files.length) {
  console.log("✅ FFmpeg WASM ready in public/ffmpeg/");
} else {
  console.error("❌ Some FFmpeg files missing — run: npm install @ffmpeg/core");
  process.exit(1);
}
