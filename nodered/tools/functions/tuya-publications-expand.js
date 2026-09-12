return Array.isArray(msg.tuya_publications)
    ? msg.tuya_publications.map((publication) => ({ ...msg, ...publication }))
    : null;
