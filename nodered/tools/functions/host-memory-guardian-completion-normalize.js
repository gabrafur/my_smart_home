const raw = msg.payload && typeof msg.payload === "object" ? msg.payload.code : msg.payload;
const parsed = String(raw ?? "").trim() === "" ? Number.NaN : Number(raw);
msg.guardian_exit_code = Number.isFinite(parsed) ? parsed : -1;
return msg;
