msg.method = "GET";
msg.url = "http://ai-bridge:8099/usage";
msg.payload = "";
delete msg.headers;
return msg;
