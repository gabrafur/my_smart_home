const previous = flow.get(msg._mqtt_key,msg._mqtt_store) ?? {};
msg._mqtt_commit_valid = msg._mqtt_valid === true && msg._mqtt_commit_allowed === true && /^[a-f0-9]{64}$/.test(msg._mqtt_proposal_sha ?? "");
msg._mqtt_ticket_duplicate = msg._mqtt_commit_valid && previous.last_committed_proposal_sha === msg._mqtt_proposal_sha;
msg.payload = msg._mqtt_commit_valid ? msg._mqtt_proposal_sha : "";
return msg;
