// Resolve only the repository's canonical, digest-pinned service declaration.
// Fail closed rather than fall back to a stale or mutable image.
export function nodeRedImageFromCompose(compose) {
  const blocks = [...String(compose).matchAll(/^  nodered:\s*\r?\n((?:^(?: {4}[^\n]*|\s*)\n)*)/gm)];
  if (blocks.length !== 1) throw new Error("Expected one canonical nodered service");
  const images = [...blocks[0][1].matchAll(/^    image:\s*(\S+)\s*$/gm)];
  if (images.length !== 1 || !/^nodered\/node-red@sha256:[a-f0-9]{64}$/.test(images[0][1])) {
    throw new Error("Node-RED image must use the canonical repository and SHA-256 digest");
  }
  return images[0][1];
}
