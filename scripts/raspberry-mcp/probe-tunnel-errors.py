import collections,datetime,json,re,subprocess
r=subprocess.run(['journalctl','-u','raspberry-mcp-tunnel.service','--since','2026-10-19 00:00:00 UTC','-n','2000','--no-pager','-o','cat'],capture_output=True,text=True,timeout=10)
text=r.stdout
patterns={'initialization_required':r'mcp_initialization_required','http_409':r'\b409\b','initialize':r'\binitialize\b','initialized_notification':r'notifications/initialized','session_expired':r'session.{0,30}expir|expir.{0,30}session','connection_closed':r'connection.{0,20}closed','ttl':r'\bttl\b','auth_error':r'\b401\b|\b403\b'}
counts={name:len(re.findall(pattern,text,re.I)) for name,pattern in patterns.items()}
error_categories=[name for name,pattern in {'permission_denied':r'permission|not seeing messages|access','journal_unavailable':r'No journal files|No entries','invalid_timestamp':r'parse timestamp|Invalid argument'}.items() if re.search(pattern,r.stderr,re.I)]
print(json.dumps({'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'tunnel.systemd.journal','exit_code':r.returncode,'collection_error':error_categories or ('unclassified_collection_failure' if r.returncode else None),'available_lines':len(text.splitlines()),'counts':counts,'coverage':['last_2000_lines_today','patterns_only','no_raw_logs','absence_not_proof_of_no_remote_errors']}))
