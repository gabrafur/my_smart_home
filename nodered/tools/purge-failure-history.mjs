#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { purgeHistory } from "./purge-notification-history.mjs";
try {
  const days = Number(process.argv[2]);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("invalid retention");
  console.log(JSON.stringify(await purgeHistory(fileURLToPath(new URL("../failure-history/", import.meta.url)), Date.now(), days)));
} catch {
  console.error("NODERED_FAILURE_HISTORY_PURGE_FAILED");
  process.exitCode = 1;
}
