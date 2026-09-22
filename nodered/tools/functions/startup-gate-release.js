const output = msg.pending.message;
delete output._startup_tick;
return output;
