return Array.isArray(msg.zigbee_publications)
    ? msg.zigbee_publications.map((publication) => ({ ...msg, ...publication }))
    : null;
