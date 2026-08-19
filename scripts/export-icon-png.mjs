import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "../public");
const appDir = resolve(__dirname, "../src/app");

function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  return resvg.render().asPng();
}

// ICO container holding PNG-compressed images (supported since Windows Vista).
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let offset = 6 + count * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // color palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit depth
    entry.writeUInt32LE(png.length, 8); // image size
    entry.writeUInt32LE(offset, 12); // image offset
    dirEntries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...images.map((i) => i.png)]);
}

// --- App icon (mountain mark) ---
const iconSvg = readFileSync(resolve(publicDir, "icon.svg"), "utf8");

const iconSizes = [512, 256, 180, 32];
for (const size of iconSizes) {
  const png = renderPng(iconSvg, size);
  writeFileSync(resolve(publicDir, `icon-${size}.png`), png);
  console.log(`✓ public/icon-${size}.png`);
}

// Favicon: 16px and 32px PNGs packed into a single .ico
const faviconPngs = [16, 32].map((size) => ({ size, png: renderPng(iconSvg, size) }));
writeFileSync(resolve(appDir, "favicon.ico"), buildIco(faviconPngs));
console.log("✓ src/app/favicon.ico");

// --- Header/banner lockup (icon + wordmark) ---
const bannerSvg = readFileSync(resolve(publicDir, "logo-banner.svg"), "utf8");
const bannerPng = renderPng(bannerSvg, 1400); // 2x for retina display
writeFileSync(resolve(publicDir, "logo-banner.png"), bannerPng);
console.log("✓ public/logo-banner.png");

// --- Square lockup (icon + wordmark stacked, for social/profile use) ---
const squareSvg = readFileSync(resolve(publicDir, "logo-square.svg"), "utf8");
const squarePng = renderPng(squareSvg, 1024);
writeFileSync(resolve(publicDir, "logo-square.png"), squarePng);
console.log("✓ public/logo-square.png");
