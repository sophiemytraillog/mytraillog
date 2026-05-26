import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(__dirname, "../public/icon.svg"), "utf8");

for (const size of [256, 32]) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const rendered = resvg.render();
  const outPath = resolve(__dirname, `../public/icon-${size}.png`);
  writeFileSync(outPath, rendered.asPng());
  console.log(`✓ public/icon-${size}.png`);
}
