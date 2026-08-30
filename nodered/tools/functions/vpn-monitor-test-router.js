if (msg._vpn_test !== true) return null;
if (msg._vpn_test_kind === "internet") return [msg, null, null];
if (msg._vpn_test_kind === "report") return [null, msg, null];
if (msg._vpn_test_kind === "evaluate") return [null, null, msg];
return null;
