const text = String(msg.payload ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 400);
msg.guardian_request_status = text.match(/\bstatus=(accepted|coalesced)\b/)?.[1] ?? "invalid";
return msg;
