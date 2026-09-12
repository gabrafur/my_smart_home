return (msg.internet_publications ?? []).map((publication) => ({
    ...msg,
    topic: publication.topic,
    payload: publication.payload
}));
