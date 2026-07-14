import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const indexPath = path.join(distDir, "index.html");

if (!existsSync(indexPath)) {
  throw new Error("Production renderer build is missing dist/index.html.");
}

const html = readFileSync(indexPath, "utf8");
const assetReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((reference) => reference.includes("assets/"));

if (assetReferences.length === 0) {
  throw new Error("Production renderer build does not reference any bundled assets.");
}

for (const reference of assetReferences) {
  if (!reference.startsWith("./assets/")) {
    throw new Error(`Electron loadFile requires a relative asset path, received: ${reference}`);
  }

  const assetPath = path.join(distDir, reference.slice(2));
  if (!existsSync(assetPath)) {
    throw new Error(`Production renderer asset is missing: ${reference}`);
  }
}

console.log(`Production renderer build passed: ${assetReferences.length} relative assets verified`);
