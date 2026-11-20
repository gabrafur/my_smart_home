// One output: Node-RED reads a returned array as one message per output, so the
// publications go wrapped in an inner array to all leave through output 1.
// (Without the wrapper only the first publication left; state and attributes
// stayed frozen on the broker from 12/09 to 20/11/2026.)
return Array.isArray(msg.tuya_publications)
    ? [msg.tuya_publications.map((publication) => ({ ...msg, ...publication }))]
    : null;
