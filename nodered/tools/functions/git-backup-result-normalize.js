const testMode = msg._git_backup_test === true;
const text = String(msg.payload ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 500);
if (!text) {
    node.status({ fill: "grey", shape: "ring", text: "sem saída; erro tratado separadamente" });
    return null;
}
const status = text.match(/\bstatus=(success|failed|deferred)\b/)?.[1] ?? "invalid";
const finishedAt = text.match(/\bfinished_at=([^ ]+)\b/)?.[1] ?? null;
const result = { status, finished_at: finishedAt };
if (testMode) flow.set("git_backup_last_result_v1__test", result);
else flow.set("git_backup_last_result_v1", result, "persistent");
msg.git_backup_status = status;
msg.payload = { ...result, test_mode: testMode };
return msg;
