// Closed diagnostic vocabulary. Never export exception text, URL or stack.
const categories = new Map([
  ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"],
  ["ETIMEDOUT", "transport_timeout"],
  ["EAI_AGAIN", "dns_resolution_failed"],
  ["ENOTFOUND", "dns_resolution_failed"],
  ["ECONNRESET", "connection_failed"],
  ["ECONNREFUSED", "connection_failed"],
  ["ENETUNREACH", "connection_failed"],
  ["EHOSTUNREACH", "connection_failed"],
  ["UND_ERR_SOCKET", "connection_failed"],
  ["CERT_HAS_EXPIRED", "tls_verification_failed"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_verification_failed"],
]);

export function auditFailureCategory(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    try {
      const category = categories.get(current.code);
      if (category) return category;
      current = current.cause;
    } catch {
      break;
    }
  }
  return "audit_failed_unclassified";
}
