const s = msg.storage;
const p = msg.policy;
const retention = p.history_retention_days * 86400000;
const interval = p.sample_interval_min * 60000;
const source = s.testMode ? "test" : "production";
let history = s.testMode ? flow.get(s.historyKey) : flow.get(s.historyKey, "persistent");
if (!Array.isArray(history)) history = [];
history = history.filter((x) => x?.source === source && Number.isFinite(x?.ts) && Number.isFinite(x?.used) && x.ts >= s.now - retention && x.ts <= s.now + interval);
const last = history.at(-1);
if (!last || s.now - last.ts >= interval / 2) history.push({ ts: s.now, used: s.used, source });
else history[history.length - 1] = { ts: s.now, used: s.used, source };
history.sort((a, b) => a.ts - b.ts);
if (s.testMode) flow.set(s.historyKey, history); else flow.set(s.historyKey, history, "persistent");
const growth = (age) => {
    const point = history.filter((x) => x.ts <= s.now - age).at(-1);
    if (!point || Math.abs((s.now - point.ts) - age) > 7200000) return null;
    return Math.round((s.used - point.used) * 10) / 10;
};
s.growth24h = growth(86400000);
s.growth7d = growth(604800000);
let categoryHistory = s.testMode ? flow.get(s.categoryHistoryKey) : flow.get(s.categoryHistoryKey, "persistent");
if (!Array.isArray(categoryHistory)) categoryHistory = [];
categoryHistory = categoryHistory.filter((x) => x?.source === source && Number.isFinite(x?.ts) && x.ts >= s.now - retention && x.ts <= s.now + interval);
if (Object.keys(s.categories).length) {
    const categoryLast = categoryHistory.at(-1);
    if (!categoryLast || s.now - categoryLast.ts >= interval / 2) categoryHistory.push({ ts: s.now, values: s.categories, source });
    else categoryHistory[categoryHistory.length - 1] = { ts: s.now, values: s.categories, source };
}
categoryHistory.sort((a, b) => a.ts - b.ts);
if (s.testMode) flow.set(s.categoryHistoryKey, categoryHistory); else flow.set(s.categoryHistoryKey, categoryHistory, "persistent");
const baseline = categoryHistory.filter((x) => x.ts <= s.now - 86400000 && s.now - x.ts >= 79200000 && s.now - x.ts <= 93600000).at(-1);
s.category_growth = {};
for (const [key, value] of Object.entries(s.categories)) if (Number.isFinite(Number(baseline?.values?.[key]))) s.category_growth[key] = value - Number(baseline.values[key]);
const largest = Object.entries(s.category_growth).filter(([, bytes]) => bytes >= 67108864).sort((a, b) => b[1] - a[1])[0];
s.growth_cause = largest ? s.labels[largest[0]] : "nao identificado";
s.growth_cause_bytes = largest?.[1] ?? null;
return msg;
