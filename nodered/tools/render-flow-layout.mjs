#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { nodeDimensions as dimensions } from "./flow-layout-validator.mjs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const selected = new Set(process.argv.slice(2));
const outputDir = process.env.FLOW_LAYOUT_DIR || "/tmp/nodered-flow-layouts";
fs.mkdirSync(outputDir, { recursive: true });

function escape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function renderPng(target, width, height, groups, nodes, wires) {
  const pixels = Buffer.alloc(width * height * 4);
  function colorAt(hex, alpha = 255) {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
  }
  function pixel(x, y, color) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = color[3];
  }
  function fillRect(x, y, w, h, color) {
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(height, Math.round(y + h)); yy += 1) {
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(width, Math.round(x + w)); xx += 1) pixel(xx, yy, color);
    }
  }
  function line(x1, y1, x2, y2, color, thickness = 1) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps;
      const x = x1 + (x2 - x1) * ratio;
      const y = y1 + (y2 - y1) * ratio;
      for (let dx = -thickness; dx <= thickness; dx += 1) for (let dy = -thickness; dy <= thickness; dy += 1) pixel(x + dx, y + dy, color);
    }
  }
  fillRect(0, 0, width, height, colorAt("#1f1f1f"));
  for (const group of groups) {
    const color = colorAt(group.style?.stroke ?? "#777777");
    line(group.x, group.y, group.x + group.w, group.y, color);
    line(group.x + group.w, group.y, group.x + group.w, group.y + group.h, color);
    line(group.x + group.w, group.y + group.h, group.x, group.y + group.h, color);
    line(group.x, group.y + group.h, group.x, group.y, color);
  }
  const wireColor = colorAt("#8fb9d8");
  for (const wire of wires) {
    let previous = [wire.x1, wire.y1];
    for (let step = 1; step <= 48; step += 1) {
      const t = step / 48;
      const mt = 1 - t;
      const x = mt ** 3 * wire.x1 + 3 * mt ** 2 * t * wire.bend + 3 * mt * t ** 2 * wire.bend + t ** 3 * wire.x2;
      const y = mt ** 3 * wire.y1 + 3 * mt ** 2 * t * wire.y1 + 3 * mt * t ** 2 * wire.y2 + t ** 3 * wire.y2;
      line(previous[0], previous[1], x, y, wireColor);
      previous = [x, y];
    }
  }
  for (const node of nodes) {
    const { width: nodeWidth, height: nodeHeight } = dimensions(node);
    fillRect(node.x - nodeWidth / 2, node.y - nodeHeight / 2, nodeWidth, nodeHeight, colorAt(palette[node.type] ?? "#b8c4cc"));
  }
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  fs.writeFileSync(target, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

const palette = {
  function: "#d9b7e8", "server-state-changed": "#efb6b6", "api-current-state": "#efb6b6",
  "api-call-service": "#efb6b6", inject: "#c9d7a7", switch: "#f3df9b", delay: "#d7c39d",
  change: "#9ec9e8", "link in": "#c7c7c7", "link out": "#c7c7c7", comment: "#f4f1c9",
};

for (const canvas of flows.filter((node) => ["tab", "subflow"].includes(node.type) && (!selected.size || selected.has(node.label || node.name) || selected.has(node.id)))) {
  const canvasName = canvas.label || canvas.name || canvas.id;
  const nodes = flows.filter((node) => node.z === canvas.id && node.type !== "group");
  const groups = flows.filter((node) => node.z === canvas.id && node.type === "group");
  if (!nodes.length) continue;
  const maxX = Math.max(...groups.map((g) => g.x + g.w), ...nodes.map((n) => n.x + dimensions(n).width / 2)) + 50;
  const maxY = Math.max(...groups.map((g) => g.y + g.h), ...nodes.map((n) => n.y + 30)) + 50;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}">`,
    `<rect width="100%" height="100%" fill="#1f1f1f"/>`,
    `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#8fb9d8"/></marker></defs>`,
    `<text x="20" y="30" fill="#fff" font-family="sans-serif" font-size="20">${escape(canvasName)}</text>`];
  for (const group of groups) {
    parts.push(`<rect x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" rx="8" fill="none" stroke="${group.style?.stroke ?? "#777"}" stroke-width="2"/>`);
    parts.push(`<text x="${group.x + 10}" y="${group.y + 20}" fill="#ddd" font-family="sans-serif" font-size="14">${escape(group.name)}</text>`);
  }
  let longWires = 0;
  let reverseWires = 0;
  const rasterWires = [];
  for (const node of nodes) {
    const from = dimensions(node);
    for (const targetId of (node.wires ?? []).flat()) {
      const target = byId.get(targetId);
      if (!target || target.z !== canvas.id) continue;
      const to = dimensions(target);
      const x1 = node.x + from.width / 2;
      const y1 = node.y;
      const x2 = target.x - to.width / 2;
      const y2 = target.y;
      const dx = x2 - x1;
      if (Math.hypot(target.x - node.x, y2 - y1) > 500) longWires += 1;
      if (target.x < node.x - 30) reverseWires += 1;
      const bend = dx >= 0 ? x1 + dx / 2 : Math.max(x1, x2) + 70;
      rasterWires.push({ x1, y1, x2, y2, bend });
      parts.push(`<path d="M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}" fill="none" stroke="#8fb9d8" stroke-width="2" opacity="0.85" marker-end="url(#arrow)"/>`);
    }
  }
  for (const node of nodes) {
    const { width, height } = dimensions(node);
    const x = node.x - width / 2;
    const y = node.y - height / 2;
    const fill = palette[node.type] ?? "#b8c4cc";
    parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="5" fill="${fill}" stroke="#555"/>`);
    parts.push(`<text x="${node.x}" y="${node.y + 5}" fill="#222" text-anchor="middle" font-family="sans-serif" font-size="12">${escape(node.name || node.type)}</text>`);
  }
  parts.push(`</svg>`);
  const target = path.join(outputDir, `${canvasName}.svg`);
  fs.writeFileSync(target, parts.join("\n"));
  const pngTarget = path.join(outputDir, `${canvasName}.png`);
  renderPng(pngTarget, Math.ceil(maxX), Math.ceil(maxY), groups, nodes, rasterWires);
  console.log(`${canvasName}: ${nodes.length} nodes, ${groups.length} groups, ${longWires} wires >500px, ${reverseWires} wires de retorno -> ${target}, ${pngTarget}`);
}
