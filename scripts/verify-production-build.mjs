import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const indexPath = path.join(distDir, "index.html");
const electronDistDir = path.join(root, "dist-electron");

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

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolutePath) : [absolutePath];
  });
}

if (!existsSync(electronDistDir)) {
  throw new Error("Production Electron build is missing dist-electron.");
}
const productionElectronFiles = listFiles(electronDistDir);
const compiledTests = productionElectronFiles.filter((filePath) =>
  filePath.endsWith(".test.js")
);
if (compiledTests.length > 0) {
  throw new Error(
    `Production Electron build must not contain compiled tests: ${compiledTests
      .map((filePath) => path.relative(root, filePath))
      .join(", ")}`
  );
}

console.log(
  `Production renderer build passed: ${assetReferences.length} relative assets verified; Electron tests excluded`
);
