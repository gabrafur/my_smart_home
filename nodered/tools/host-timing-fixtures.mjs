// Public synthetic fixtures; never invokes a household producer.
export const wall=1800000000000, hash='a'.repeat(64), boot='b'.repeat(64);
export const limits={event_latency_ms:10000,resource_latency_ms:60000};
export const frame=(tick=0, counts={docker:0,systemd:0},events=[])=>{
 const seq=counts.docker+counts.systemd;
 return {report:{schema_version:1,source:'fixed_readonly_host_observer',evicted_event_records:0,instance_id:hash,boot_id_sha256:boot,observed_at:new Date(wall+tick*1000).toISOString(),sequence:seq,events,
  sources:{docker:{state:'connected',collection_error:null},systemd:{state:'connected',collection_error:null}},
  resources:{observed_at:new Date(wall+Math.floor(tick/20)*20000).toISOString(),data:{cpu_busy_percent:20,memory_available_bytes:4000000000,memory_total_bytes:8000000000,oom_kill_count:0,disk_used_percent:60,inodes_used_percent:10,temperature_celsius:50},collection_errors:[]},
  timing_v1:{version:1,state:'observed',report_monotonic_seconds:1000+tick,resource_sample_sequence:Math.floor(tick/20)+1,
   resource_sampled_monotonic_seconds:1000+Math.floor(tick/20)*20,source_event_counts:{...counts},
   source_fault_counts:{docker:0,systemd:0},clock_stable:true,clock_change_count:0,resource_period_seconds:20,idle_report_period_seconds:10}},
  reader:{state:'observed',boot_id_sha256:boot,observed_at:new Date(wall+tick*1000+200).toISOString(),monotonic_seconds:1000+tick+.2},
  now_ms:wall+tick*1000+250,canvas_monotonic_ms:5000+tick*1000+250,limits,max_report_age_ms:30000,runtime_restarted:false};
};
export const event=(tick,sequence,source='systemd')=>({id:sequence.toString(16).padStart(64,'0'),service:source==='docker'?'nodered':'procmon',action:source==='docker'?'start':'started',occurred_at:new Date(wall+tick*1000-150).toISOString(),observed_at:new Date(wall+tick*1000-50).toISOString(),sequence,source,source_clock_ordered:true,source_to_observer_ms:100,observer_monotonic_seconds:1000+tick-.05});
