import crypto from "node:crypto";

export const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const recordPattern = /<!-- memory-record (\{[^\n]+\}) -->\n([\s\S]*?)<!-- \/memory-record -->/g;
export const categories = new Set([
  "LONG_LIVED_DECISION", "ARCHITECTURE", "CONSTRAINT", "IMPORTANT_DISCOVERY",
  "OPERATING_PROCEDURE", "KNOWN_FAILURE_MODE", "PROJECT_CONVENTION",
]);

export function records(markdown) {
  const found = [...markdown.matchAll(recordPattern)].map((match) => ({
    metadata: JSON.parse(match[1]), body: match[2], raw: match[0], offset: match.index,
  }));
  if ((markdown.match(/<!-- memory-record /g) || []).length !== found.length ||
      (markdown.match(/<!-- \/memory-record -->/g) || []).length !== found.length) {
    throw new Error("malformed memory record");
  }
  return found;
}

// Fingerprints detect source drift; they do not establish semantic truth.
export function checkEvidence(markdown, readPublic) {
  const errors = [];
  const ids = new Set();
  try {
    for (const { metadata: m, body } of records(markdown)) {
      if (/(?:password|senha|secret|api_key|access_token)\s*[:=]\s*["']?[^\s"'<>]{8,}/i.test(body + JSON.stringify(m))) throw new Error("prohibited credential assignment in memory record");
      if (typeof m.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.id) || ids.has(m.id)) throw new Error("invalid or duplicate memory id");
      ids.add(m.id);
      if (!categories.has(m.category) || !["VERIFIED_FACT", "PROJECT_DECISION"].includes(m.kind)) throw new Error("unverified memory kind/category");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.last_verified) || !Number.isFinite(Date.parse(m.last_verified)) || new Date(m.last_verified).toISOString().slice(0, 10) !== m.last_verified || !body.trim()) throw new Error("invalid verification date/body");
      if (!Array.isArray(m.evidence) || !m.evidence.length) throw new Error("missing memory evidence");
      for (const e of m.evidence) {
        if (typeof e.file !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256)) throw new Error("invalid evidence reference");
        const source = readPublic(e.file);
        if (digest(source) !== e.sha256) errors.push(`${m.id}: evidence_changed; revalidate source ${e.file}`);
      }
    }
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

export function reconcileRecord(markdown, candidate) {
  const { id, category, kind, last_verified, evidence, title, body } = candidate;
  if (typeof title !== "string" || !title.trim() || /[\r\n<>]/.test(title) || typeof body !== "string" || /<!--|-->/.test(body)) throw new Error("invalid memory text");
  const metadata = { id, category, kind, last_verified, evidence };
  const replacement = `<!-- memory-record ${JSON.stringify(metadata)} -->\n## ${title}\n\n${body.trim()}\n\n<!-- /memory-record -->`;
  const old = records(markdown).find((r) => r.metadata.id === id);
  if (old) {
    // Repeating an unchanged fact does not manufacture a new verification date.
    const previous = { ...old.metadata, last_verified };
    if (JSON.stringify(previous) === JSON.stringify(metadata) && old.body === `## ${title}\n\n${body.trim()}\n\n`) return markdown;
    return markdown.slice(0, old.offset) + replacement + markdown.slice(old.offset + old.raw.length);
  }
  return `${markdown.trimEnd()}\n\n${replacement}\n`;
}
