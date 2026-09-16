#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { nodeDimensions } from "./flow-layout-validator.mjs";
import { connectedComponents, semanticEdges } from "./flow-layout-graph.mjs";

const MAX_GROUP_NEAREST_GAP = 160;
const TARGET_GROUP_NEAREST_GAP = 80;
const MAX_PORT_BACKTRACK = 60;

function boundsForNode(node) {
  const { width, height } = nodeDimensions(node);
  return {
    left: node.x - width / 2,
    right: node.x + width / 2,
    top: node.y - height / 2,
    bottom: node.y + height / 2,
  };
}

function overlaps(left, right) {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function edgeGap(left, right) {
  const dx = Math.max(0, left.left - right.right, right.left - left.right);
  const dy = Math.max(0, left.top - right.bottom, right.top - left.bottom);
  return Math.hypot(dx, dy);
}

function rectangleDistance(left, right) {
  const horizontal = Math.max(left.left - right.right, right.left - left.right, 0);
  const vertical = Math.max(left.top - right.bottom, right.top - left.bottom, 0);
  return Math.hypot(horizontal, vertical);
}

function connectedGroupClusters(groups, boundsById) {
  const remaining = new Set(groups.map((group) => group.id));
  const clusters = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value;
    remaining.delete(seed);
    const cluster = [seed];
    const queue = [seed];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const candidate of [...remaining]) {
        if (rectangleDistance(boundsById.get(current), boundsById.get(candidate)) > MAX_GROUP_NEAREST_GAP) continue;
        remaining.delete(candidate);
        cluster.push(candidate);
        queue.push(candidate);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsCross(a, b, c, d) {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return first * second < 0 && third * fourth < 0;
}

function bezierPoint(wire, t) {
  const mt = 1 - t;
  return {
    x: mt ** 3 * wire.x1 + 3 * mt ** 2 * t * wire.bend + 3 * mt * t ** 2 * wire.bend + t ** 3 * wire.x2,
    y: mt ** 3 * wire.y1 + 3 * mt ** 2 * t * wire.y1 + 3 * mt * t ** 2 * wire.y2 + t ** 3 * wire.y2,
  };
}

function wireCrossesNode(wire, bounds) {
  const inset = 3;
  for (let step = 1; step < 80; step += 1) {
    const point = bezierPoint(wire, step / 80);
    if (
      point.x > bounds.left + inset && point.x < bounds.right - inset &&
      point.y > bounds.top + inset && point.y < bounds.bottom - inset
    ) return true;
  }
  return false;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function label(node) {
  return node.name || node.label || node.id;
}

function classification(metrics) {
  if (metrics.groupOverlaps > 0 || metrics.overlaps > 0 || metrics.wireNodeIntersections >= 8 || metrics.reverseWires >= 4 || metrics.branchOrderInversions >= 4 || metrics.isolatedGroups >= 3 || metrics.separatedGroupClusters >= 2 || metrics.crossings >= 20) return "SEVERELY DISORGANIZED";
  if (
    metrics.leftMargin < 64 || metrics.wireNodeIntersections > 0 || metrics.longWires > 0 || metrics.reverseWires > 0 ||
    metrics.isolatedGroups > 0 || metrics.separatedGroupClusters > 0 || metrics.branchOrderInversions > 0 || metrics.crossings >= 5 || metrics.closePairs >= 8 || metrics.zigZags >= 4
  ) return "NEEDS REORGANIZATION";
  if (metrics.excessiveGroupGaps > 0 || metrics.crossings > 0 || metrics.closePairs > 0 || metrics.branchMisalignment > 0 || metrics.concentration > 0) {
    return "MINOR CLEANUP";
  }
  return "GOOD";
}

export function auditFlows(flows) {
  const byId = new Map(flows.map((node) => [node.id, node]));
  const roots = flows.filter((node) => node.type === "tab" || node.type === "subflow");
  const audits = [];

  for (const root of roots) {
    const nodes = flows.filter((node) => node.z === root.id && node.type !== "group" && Number.isFinite(node.x) && Number.isFinite(node.y));
    const groups = flows.filter((node) => node.z === root.id && node.type === "group" && Number.isFinite(node.x) && Number.isFinite(node.y));
    if (nodes.length === 0 && groups.length === 0) continue;

    const nodeBounds = new Map(nodes.map((node) => [node.id, boundsForNode(node)]));
    const issueWeight = new Map(nodes.map((node) => [node.id, 0]));
    const testGroupIds = new Set(groups.filter((group) => /test/i.test(`${group.id} ${group.name ?? ""}`)).map((group) => group.id));
    const isTestNode = (node) => testGroupIds.has(node.g) || /test/i.test(`${node.id} ${node.name ?? ""}`);
    let overlapsCount = 0;
    const groupOverlapDetails = [];
    for (let index = 0; index < groups.length; index += 1) {
      for (let candidate = index + 1; candidate < groups.length; candidate += 1) {
        const left = groups[index];
        const right = groups[candidate];
        const leftBounds = { left: left.x, right: left.x + left.w, top: left.y, bottom: left.y + left.h };
        const rightBounds = { left: right.x, right: right.x + right.w, top: right.y, bottom: right.y + right.h };
        if (overlaps(leftBounds, rightBounds)) {
          groupOverlapDetails.push({ left: left.id, right: right.id });
        }
      }
    }
    const groupBoundsById = new Map(groups.map((group) => [group.id, {
      left: group.x,
      right: group.x + group.w,
      top: group.y,
      bottom: group.y + group.h,
    }]));
    const groupNearestGaps = groups.length < 2 ? [] : groups.map((group) => Math.min(...groups
      .filter((candidate) => candidate.id !== group.id)
      .map((candidate) => rectangleDistance(groupBoundsById.get(group.id), groupBoundsById.get(candidate.id)))));
    const isolatedGroupDetails = groups.length < 2 ? [] : groups.flatMap((group) => {
      const nearestGap = Math.min(...groups
        .filter((candidate) => candidate.id !== group.id)
        .map((candidate) => rectangleDistance(groupBoundsById.get(group.id), groupBoundsById.get(candidate.id))));
      return nearestGap > MAX_GROUP_NEAREST_GAP ? [{ group: group.id, nearestGap: Math.round(nearestGap) }] : [];
    });
    const groupClusters = connectedGroupClusters(groups, groupBoundsById);
    const groupHullWidth = groups.length === 0 ? 0 : Math.max(...groups.map((group) => group.x + group.w)) - Math.min(...groups.map((group) => group.x));
    const groupHullHeight = groups.length === 0 ? 0 : Math.max(...groups.map((group) => group.y + group.h)) - Math.min(...groups.map((group) => group.y));
    let closePairs = 0;
    let testClosePairs = 0;
    const nodeSpacings = [];

    for (let index = 0; index < nodes.length; index += 1) {
      for (let candidate = index + 1; candidate < nodes.length; candidate += 1) {
        const left = nodes[index];
        const right = nodes[candidate];
        if ((left.g ?? null) !== (right.g ?? null)) continue;
        const leftBounds = nodeBounds.get(left.id);
        const rightBounds = nodeBounds.get(right.id);
        if (overlaps(leftBounds, rightBounds)) {
          overlapsCount += 1;
          issueWeight.set(left.id, issueWeight.get(left.id) + 5);
          issueWeight.set(right.id, issueWeight.get(right.id) + 5);
          continue;
        }
        const spacing = edgeGap(leftBounds, rightBounds);
        nodeSpacings.push(spacing);
        if (spacing < 20) {
          closePairs += 1;
          if (isTestNode(left) && isTestNode(right)) testClosePairs += 1;
          issueWeight.set(left.id, issueWeight.get(left.id) + 1);
          issueWeight.set(right.id, issueWeight.get(right.id) + 1);
        }
      }
    }

    const wires = [];
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    let longWires = 0;
    let reverseWires = 0;
    let zigZags = 0;
    let branchMisalignment = 0;
    let branchOrderInversions = 0;
    const branchOrderDetails = [];
    for (const node of nodes) {
      const targets = (node.wires ?? []).flat()
        .map((targetId) => byId.get(targetId))
        .filter((target) => target && target.z === root.id && Number.isFinite(target.x) && Number.isFinite(target.y));
      if (targets.length >= 2) {
        const targetXs = targets.map((target) => target.x);
        if (Math.max(...targetXs) - Math.min(...targetXs) > 200 || targets.some((target) => target.x < node.x - 30)) {
          branchMisalignment += 1;
          issueWeight.set(node.id, issueWeight.get(node.id) + 2);
        }
      }
      const outputGroups = Array.isArray(node.wires) ? node.wires : [];
      const orderedOutputs = outputGroups.map((group, outputIndex) => {
        const outputTargets = (Array.isArray(group) ? group : [])
          .map((targetId) => byId.get(targetId))
          .filter((target) => target && target.z === root.id && Number.isFinite(target.y));
        if (outputTargets.length === 0) return null;
        return { outputIndex, y: outputTargets.reduce((sum, target) => sum + target.y, 0) / outputTargets.length };
      }).filter(Boolean);
      if (orderedOutputs.some((current, index) => orderedOutputs.slice(index + 1).some((later) => current.y > later.y + 20))) {
        branchOrderInversions += 1;
        branchOrderDetails.push({ source: node.id, outputs: orderedOutputs.map((output) => ({ index: output.outputIndex, y: Math.round(output.y) })) });
        issueWeight.set(node.id, issueWeight.get(node.id) + 2);
      }
      for (const target of targets) {
        const outputIndex = Math.max(0, outputGroups.findIndex((group) => Array.isArray(group) && group.includes(target.id)));
        const outputCount = Math.max(1, outputGroups.length);
        indegree.set(target.id, (indegree.get(target.id) ?? 0) + 1);
        const distance = Math.hypot(target.x - node.x, target.y - node.y);
        const sourceWidth = nodeDimensions(node).width;
        const targetWidth = nodeDimensions(target).width;
        const reverse = target.x - targetWidth / 2 < node.x + sourceWidth / 2 - MAX_PORT_BACKTRACK;
        const verticalTurn = Math.abs(target.y - node.y) > 220 && Math.abs(target.x - node.x) < 180;
        if (distance > 500) longWires += 1;
        if (reverse) reverseWires += 1;
        if (verticalTurn || reverse) zigZags += 1;
        if (distance > 500 || reverse || verticalTurn) {
          issueWeight.set(node.id, issueWeight.get(node.id) + 2);
          issueWeight.set(target.id, issueWeight.get(target.id) + 2);
        }
        wires.push({ source: node, target, outputIndex, outputCount, test: isTestNode(node) || isTestNode(target) });
      }
    }

    const wireNodeHits = [];
    for (const wire of wires) {
      const sourceDimensions = nodeDimensions(wire.source);
      const targetDimensions = nodeDimensions(wire.target);
      const x1 = wire.source.x + sourceDimensions.width / 2;
      const y1 = wire.source.y - sourceDimensions.height / 2 + sourceDimensions.height * (wire.outputIndex + 1) / (wire.outputCount + 1);
      const x2 = wire.target.x - targetDimensions.width / 2;
      const y2 = wire.target.y;
      const dx = x2 - x1;
      const curve = { x1, y1, x2, y2, bend: dx >= 0 ? x1 + dx / 2 : Math.max(x1, x2) + 70 };
      for (const obstacle of nodes) {
        if (obstacle.id === wire.source.id || obstacle.id === wire.target.id) continue;
        if (!wireCrossesNode(curve, nodeBounds.get(obstacle.id))) continue;
        wireNodeHits.push({ source: wire.source, target: wire.target, obstacle });
        issueWeight.set(wire.source.id, issueWeight.get(wire.source.id) + 2);
        issueWeight.set(wire.target.id, issueWeight.get(wire.target.id) + 2);
        issueWeight.set(obstacle.id, issueWeight.get(obstacle.id) + 4);
      }
    }

    let crossings = 0;
    let testCrossings = 0;
    for (let index = 0; index < wires.length; index += 1) {
      for (let candidate = index + 1; candidate < wires.length; candidate += 1) {
        const left = wires[index];
        const right = wires[candidate];
        if ([left.source.id, left.target.id].some((id) => id === right.source.id || id === right.target.id)) continue;
        if (segmentsCross(left.source, left.target, right.source, right.target)) {
          crossings += 1;
          if (left.test || right.test) testCrossings += 1;
          for (const node of [left.source, left.target, right.source, right.target]) {
            issueWeight.set(node.id, issueWeight.get(node.id) + 1);
          }
        }
      }
    }

    const concentrationNodes = nodes.filter((node) => {
      const outdegree = (node.wires ?? []).flat().filter((id) => byId.get(id)?.z === root.id).length;
      return outdegree + (indegree.get(node.id) ?? 0) >= 6;
    });
    for (const node of concentrationNodes) issueWeight.set(node.id, issueWeight.get(node.id) + 1);

    const allBounds = [
      ...groups.map((group) => ({ left: group.x, right: group.x + group.w, top: group.y, bottom: group.y + group.h })),
      ...nodes.map((node) => nodeBounds.get(node.id)),
    ];
    const minX = Math.min(...allBounds.map((item) => item.left));
    const minY = Math.min(...allBounds.map((item) => item.top));
    const maxX = Math.max(...allBounds.map((item) => item.right));
    const maxY = Math.max(...allBounds.map((item) => item.bottom));
    const leftMarginAnchors = groups.length > 0 ? groups.map((group) => group.x) : allBounds.map((item) => item.left);
    const hotSpots = [...issueWeight.entries()]
      .filter(([, weight]) => weight > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 4)
      .map(([id]) => label(byId.get(id)));
    const testNodes = nodes.filter(isTestNode);
    const semantic = semanticEdges(flows, root.id);
    const components = connectedComponents(nodes.map((node) => node.id), semantic);
    const componentHulls = components.map((component) => {
      const bounds = component.map((id) => nodeBounds.get(id)).filter(Boolean);
      return {
        left: Math.min(...bounds.map((item) => item.left)),
        right: Math.max(...bounds.map((item) => item.right)),
        top: Math.min(...bounds.map((item) => item.top)),
        bottom: Math.max(...bounds.map((item) => item.bottom)),
      };
    });
    let componentIntersections = 0;
    for (let index = 0; index < componentHulls.length; index += 1) {
      for (let candidate = index + 1; candidate < componentHulls.length; candidate += 1) {
        if (overlaps(componentHulls[index], componentHulls[candidate])) componentIntersections += 1;
      }
    }
    const metrics = {
      id: root.id,
      name: root.label || root.name || root.id,
      kind: root.type,
      nodes: nodes.length,
      groups: groups.length,
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY),
      leftMargin: Math.round(Math.min(...leftMarginAnchors)),
      overlaps: overlapsCount,
      groupOverlaps: groupOverlapDetails.length,
      groupOverlapDetails,
      isolatedGroups: isolatedGroupDetails.length,
      isolatedGroupDetails,
      separatedGroupClusters: Math.max(0, groupClusters.length - 1),
      groupClusterDetails: groupClusters,
      maxGroupNearestGap: Math.round(Math.max(0, ...groupNearestGaps)),
      excessiveGroupGaps: groupNearestGaps.filter((gap) => gap > TARGET_GROUP_NEAREST_GAP).length,
      groupHullWidth: Math.round(groupHullWidth),
      groupHullHeight: Math.round(groupHullHeight),
      groupHullArea: Math.round(groupHullWidth * groupHullHeight),
      closePairs,
      minimumNodeSpacing: nodeSpacings.length === 0 ? 0 : Math.round(Math.min(...nodeSpacings)),
      averageNodeSpacing: nodeSpacings.length === 0 ? 0 : Math.round(nodeSpacings.reduce((sum, value) => sum + value, 0) / nodeSpacings.length),
      components: components.length,
      componentIntersections,
      longWires,
      reverseWires,
      zigZags,
      branchMisalignment,
      branchOrderInversions,
      branchOrderDetails,
      concentration: concentrationNodes.length,
      crossings,
      wireNodeIntersections: wireNodeHits.length,
      wireNodeDetails: wireNodeHits.map((hit) => ({
        source: hit.source.id,
        target: hit.target.id,
        obstacle: hit.obstacle.id,
      })),
      wireNodeExamples: wireNodeHits.slice(0, 4).map((hit) => `${label(hit.source)} → ${label(hit.target)} sobre ${label(hit.obstacle)}`),
      tests: testNodes.length,
      testClosePairs,
      testCrossings,
      hotSpots,
    };
    metrics.classification = classification(metrics);
    audits.push(metrics);
  }
  return audits;
}

export function renderAudit(flows, sourcePath) {
  const audits = auditFlows(flows);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  const lines = [
    "# Auditoria de layout dos canvases Node-RED",
    "",
    "## Escopo e método",
    "",
    `Baseline auditado: ${sourcePath.startsWith(`${path.sep}tmp${path.sep}`) ? "snapshot temporário anterior à mudança" : `\`${path.relative(process.cwd(), sourcePath) || sourcePath}\``} (SHA-256 \`${digest}\`).`,
    "",
    "Esta é a medição **antes** da padronização. A análise é conservadora e combina topologia e geometria aproximada: dimensões visuais estimadas pelo renderizador do repositório, colisão entre retângulos de groups e nodes, curva Bézier aproximada desde cada porta de saída até a entrada, direção real entre as portas dos wires, ordem vertical das portas de saída, dispersão das branches, distância ao group vizinho, conectividade espacial entre todos os groups e interseção de segmentos entre centros. Wire sobre node, sobreposição, retorno visual, inversão da ordem de branches, group isolado, cadeias de groups separadas e gap excessivo são violações; cruzamentos entre wires e proximidades continuam candidatos para inspeção visual. Links virtuais entre tabs não são tratados como wires locais.",
    "",
    "Limites usados: margem esquerda de 64 px; groups não podem se sobrepor; o gutter-alvo até o vizinho mais próximo é 24–80 px, nenhum group pode superar 160 px e todos os groups do canvas devem formar uma única cadeia espacial nesse limite; largura e área do envelope completo de groups não podem regredir durante uma reorganização; saídas de um mesmo node devem manter ordem vertical monotônica com tolerância de 20 px; node praticamente encostado quando a folga estimada é menor que 20 px; gap excessivo quando um wire mede mais de 500 px; retorno visual quando a entrada do destino recua mais de 60 px em relação à saída da origem; mudança vertical potencialmente em zig-zag quando supera 220 px com avanço horizontal inferior a 180 px; concentração quando um node soma pelo menos seis entradas e saídas locais.",
    "",
    "## Resumo por canvas",
    "",
    "| Canvas | Tipo | Nodes | Groups | Área aproximada (px) | Margem | Groups sobrepostos | Groups isolados | Cadeias separadas | Nodes sobrepostos | Próximos | Wires sobre nodes | Gaps >500 | Retornos visuais | Zig-zags | Branches desalinhadas | Concentrações | Cruzamentos possíveis | Testes (nodes / conflitos) | Classificação |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const audit of audits) {
    lines.push(
      `| ${escapeCell(audit.name)} | ${audit.kind} | ${audit.nodes} | ${audit.groups} | ` +
      `${audit.width} × ${audit.height} | ${audit.leftMargin} | ${audit.groupOverlaps} | ${audit.isolatedGroups} | ${audit.separatedGroupClusters} | ${audit.overlaps} | ${audit.closePairs} | ${audit.wireNodeIntersections} | ` +
      `${audit.longWires} | ${audit.reverseWires} | ${audit.zigZags} | ${audit.branchMisalignment} | ` +
      `${audit.concentration} | ${audit.crossings} | ${audit.tests} / ${audit.testClosePairs + audit.testCrossings} | ` +
      `**${audit.classification}** |`,
    );
  }

  lines.push("", "## Áreas que exigem atenção", "");
  for (const audit of audits) {
    const findings = [];
    if (audit.leftMargin < 64) findings.push(`margem esquerda de ${audit.leftMargin} px`);
    if (audit.groupOverlaps) findings.push(`${audit.groupOverlaps} sobreposição(ões) entre groups: ${audit.groupOverlapDetails.map((item) => `\`${item.left} / ${item.right}\``).join(", ")}`);
    if (audit.isolatedGroups) findings.push(`${audit.isolatedGroups} group(s) isolado(s): ${audit.isolatedGroupDetails.map((item) => `\`${item.group} (${item.nearestGap} px)\``).join(", ")}`);
    if (audit.separatedGroupClusters) findings.push(`${audit.separatedGroupClusters + 1} cadeias de groups separadas: ${audit.groupClusterDetails.map((cluster) => `\`${cluster.join(", ")}\``).join(" / ")}`);
    if (audit.excessiveGroupGaps) findings.push(`${audit.excessiveGroupGaps} group(s) acima do gutter-alvo de 80 px; maior distância ${audit.maxGroupNearestGap} px`);
    if (audit.overlaps) findings.push(`${audit.overlaps} possível(is) sobreposição(ões)`);
    if (audit.closePairs) findings.push(`${audit.closePairs} par(es) praticamente encostado(s)`);
    if (audit.wireNodeIntersections) findings.push(`${audit.wireNodeIntersections} wire(s) possivelmente atravessando node(s): ${audit.wireNodeExamples.map((item) => `\`${item}\``).join(", ")}`);
    if (audit.longWires) findings.push(`${audit.longWires} gap(s)/wire(s) acima de 500 px`);
    if (audit.reverseWires) findings.push(`${audit.reverseWires} retorno(s) direita → esquerda`);
    if (audit.branchOrderInversions) findings.push(`${audit.branchOrderInversions} node(s) com ordem vertical das saídas invertida: ${audit.branchOrderDetails.slice(0, 4).map((item) => `\`${item.source}\``).join(", ")}`);
    if (audit.zigZags) findings.push(`${audit.zigZags} mudança(s) vertical(is)/zig-zag`);
    if (audit.branchMisalignment) findings.push(`${audit.branchMisalignment} branch(es) com destinos desalinhados`);
    if (audit.crossings) findings.push(`${audit.crossings} cruzamento(s) geométrico(s) possível(is)`);
    if (audit.concentration) findings.push(`${audit.concentration} ponto(s) de concentração de wires`);
    if (audit.tests && audit.testClosePairs + audit.testCrossings) {
      findings.push(`${audit.testClosePairs + audit.testCrossings} conflito(s) potencial(is) na área de testes`);
    }
    if (findings.length === 0) findings.push("nenhum candidato geométrico relevante detectado automaticamente");
    const hotSpots = audit.hotSpots.length > 0 ? ` Pontos mais carregados: ${audit.hotSpots.map((item) => `\`${item}\``).join(", ")}.` : "";
    lines.push(`- **${audit.name} — ${audit.classification}:** ${findings.join("; ")}.${hotSpots}`);
  }

  lines.push(
    "",
    "## Restrições da correção",
    "",
    "A reorganização deve preservar integralmente IDs, tipos, tabs, memberships, conexões, links, ordem de execução, regras, mensagens, payloads, JavaScript, entidades, serviços, tópicos e configuração. Somente `x`/`y` dos objetos posicionados e `w`/`h` de `group` podem mudar. Um candidato que não possa ser corrigido apenas com essas propriedades permanece documentado.",
    "",
  );
  return lines.join("\n");
}

function main(argv) {
  if (argv.length < 1 || argv.length > 2) {
    console.error("Usage: node nodered/tools/audit-flow-layout.mjs FLOWS.json [REPORT.md]");
    return 2;
  }
  const sourcePath = path.resolve(argv[0]);
  const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  if (!Array.isArray(flows)) throw new Error("expected a top-level JSON array");
  const report = renderAudit(flows, sourcePath);
  if (argv[1]) fs.writeFileSync(path.resolve(argv[1]), report);
  else process.stdout.write(report);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
