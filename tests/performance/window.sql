-- Synthetic acceptance data only. The runner owns a random Compose project/volume.
-- Seed timeouts are disabled here; production API/worker timeouts stay unchanged.
BEGIN;
SET LOCAL statement_timeout=0;
CREATE TEMP TABLE m5_sites AS SELECT id,public_id,row_number() OVER(ORDER BY id)::int AS n FROM sites;
DO $$ BEGIN IF (SELECT count(*) FROM m5_sites)<>5 OR EXISTS(SELECT 1 FROM sites WHERE name NOT LIKE 'M5 %') THEN RAISE EXCEPTION 'M5 fixture requires five isolated acceptance sites'; END IF; END $$;
UPDATE sites SET created_at=current_date-365,config=jsonb_set(config,'{identity_epochs}',jsonb_build_array(jsonb_build_object('visitor',1,'ip',1,'effective_at',current_date-365)));
CREATE TEMP TABLE m5_facts AS
SELECT s.id AS site_id,g.i,md5('event-'||g.i)::uuid AS eid,md5('session-'||g.i)::uuid AS sid,
  decode(repeat(md5('visitor-'||s.n||'-'||CASE WHEN s.n=5 THEN (g.i%1000)::text ELSE g.i::text END),2),'hex') AS visitor_key,
  decode(repeat(md5('ip-'||s.n||'-'||(g.i%100)),2),'hex') AS ip_key,
  current_date-30+(g.i-1)*interval '8.64 seconds' AS at,
  CASE WHEN s.n=2 THEN '/high-cardinality/'||g.i ELSE '/article/'||(g.i%30) END AS path
FROM generate_series(1,300000) g(i) JOIN m5_sites s ON s.n=(g.i-1)%5+1;
CREATE INDEX ON m5_facts(i);
INSERT INTO visitors(site_id,visitor_key,first_seen_pv_at,last_activity_at,latest_path)
SELECT site_id,visitor_key,min(at),max(at),min(path) FROM m5_facts GROUP BY site_id,visitor_key;
-- One small transaction per day limits deferred FK and WAL bursts.
COMMIT;
DO $$ DECLARE day integer; BEGIN
FOR day IN 0..29 LOOP
  INSERT INTO sessions(site_id,id,visitor_key,status,started_at,last_activity_at,ended_at,closed_at,close_reason,entry_path,exit_path,source_channel,page_views,active_ms)
  SELECT site_id,sid,visitor_key,'closed',at-CASE WHEN i%10000 BETWEEN 1 AND 5 THEN interval '2 minutes' ELSE interval '0' END,at,at,at+interval '30 minutes','timeout',path,path,'direct',1,1000
  FROM m5_facts WHERE i>day*10000 AND i<=(day+1)*10000;
  INSERT INTO events(site_id,event_id,session_id,visitor_key,ip_key,event_type,page_view_id,path,occurred_at,received_at,local_date,payload_fingerprint,rule_version,first_seen_pv_at,client_ip)
  SELECT f.site_id,eid,sid,f.visitor_key,ip_key,'page_view',eid,path,at,at,at::date,decode(repeat(md5(eid::text),2),'hex'),1,v.first_seen_pv_at,'192.0.2.1'::inet
  FROM m5_facts f JOIN visitors v ON v.site_id=f.site_id AND v.visitor_key=f.visitor_key WHERE i>day*10000 AND i<=(day+1)*10000;
  INSERT INTO page_views(site_id,id,session_id,occurred_at)
  SELECT site_id,eid,sid,at FROM m5_facts WHERE i>day*10000 AND i<=(day+1)*10000;
  COMMIT;
END LOOP;
END $$;
BEGIN;
SET LOCAL statement_timeout=0;
INSERT INTO visitor_days(site_id,local_date,visitor_key,first_seen_pv_at)
SELECT site_id,at::date,visitor_key,min(at) FROM m5_facts GROUP BY site_id,at::date,visitor_key;
INSERT INTO ip_days SELECT DISTINCT site_id,at::date,ip_key FROM m5_facts;
-- The older 60 days contain 600,000 additional exact membership records.
INSERT INTO visitor_days(site_id,local_date,visitor_key,first_seen_pv_at)
SELECT s.id,current_date-d,decode(repeat(md5('old-'||s.n||'-'||d||'-'||i),2),'hex'),current_date-d
FROM m5_sites s CROSS JOIN generate_series(31,90) d CROSS JOIN generate_series(1,2000) i;
INSERT INTO ip_days
SELECT s.id,current_date-d,decode(repeat(md5('old-ip-'||s.n||'-'||i),2),'hex')
FROM m5_sites s CROSS JOIN generate_series(31,90) d CROSS JOIN generate_series(1,200) i;
INSERT INTO distinct_hours(site_id,bucket_start,kind,member_key,first_seen_pv_at)
SELECT site_id,date_trunc('hour',at),1,visitor_key,min(at) FROM m5_facts GROUP BY site_id,date_trunc('hour',at),visitor_key
UNION ALL SELECT DISTINCT site_id,date_trunc('hour',at),2,ip_key,NULL::timestamptz FROM m5_facts;
INSERT INTO stats_daily(site_id,local_date,pv,uv,ip,sessions_total,closed_sessions,bounced_sessions,active_ms,is_final,computed_at,revision,finalized_at)
SELECT s.id,current_date-d,2000,2000,200,2000,2000,2000,2000000,true,clock_timestamp(),1,clock_timestamp()
FROM m5_sites s CROSS JOIN generate_series(1,365) d;
UPDATE stats_daily d SET pv=f.pv,uv=f.uv,ip=f.ip FROM
(SELECT site_id,at::date AS date,count(*) AS pv,count(DISTINCT visitor_key) AS uv,count(DISTINCT ip_key) AS ip FROM m5_facts GROUP BY site_id,at::date) f
WHERE d.site_id=f.site_id AND d.local_date=f.date;
UPDATE stats_daily d SET sessions_total=f.n,closed_sessions=f.n,bounced_sessions=f.n,active_ms=f.n*1000 FROM
(SELECT site_id,started_at::date AS date,count(*) AS n FROM sessions GROUP BY site_id,started_at::date) f
WHERE d.site_id=f.site_id AND d.local_date=f.date AND d.local_date>=current_date-30;
INSERT INTO stats_hourly(site_id,bucket_start,pv,uv,ip,is_final,computed_at,revision,finalized_at)
SELECT site_id,date_trunc('hour',at),count(*),count(DISTINCT visitor_key),count(DISTINCT ip_key),true,clock_timestamp(),1,clock_timestamp()
FROM m5_facts GROUP BY site_id,date_trunc('hour',at);
UPDATE stats_hourly h SET sessions_total=f.n,closed_sessions=f.n,bounced_sessions=f.n,active_ms=f.n*1000 FROM
(SELECT site_id,date_trunc('hour',started_at) AS hour,count(*) AS n FROM sessions GROUP BY site_id,date_trunc('hour',started_at)) f
WHERE h.site_id=f.site_id AND h.bucket_start=f.hour;
INSERT INTO stats_pages_daily(site_id,local_date,path,pv,entry_sessions,exit_sessions,revision)
SELECT site_id,at::date,path,count(*),0,0,1 FROM m5_facts GROUP BY site_id,at::date,path;
INSERT INTO stats_pages_daily(site_id,local_date,path,pv,entry_sessions,exit_sessions,revision)
SELECT site_id,started_at::date,entry_path,0,count(*),count(*),1 FROM sessions WHERE started_at>=current_date-30 GROUP BY site_id,started_at::date,entry_path
ON CONFLICT(site_id,local_date,path) DO UPDATE SET entry_sessions=excluded.entry_sessions,exit_sessions=excluded.exit_sessions;
INSERT INTO stats_pages_daily(site_id,local_date,path,pv,entry_sessions,exit_sessions,revision)
SELECT s.id,current_date-d,'/archive',2000,2000,2000,1 FROM m5_sites s CROSS JOIN generate_series(31,365) d;
INSERT INTO stats_sources_daily(site_id,local_date,source_key,channel,sessions_total,closed_sessions,bounced_sessions,active_ms,revision)
SELECT site_id,local_date,decode(repeat(md5('direct'),2),'hex'),'direct',sessions_total,closed_sessions,bounced_sessions,active_ms,1 FROM stats_daily;
UPDATE site_data_coverage SET observed_from=current_date-365,
available_from=current_date-CASE WHEN layer='day_members' THEN 90 WHEN layer='day_aggregates' THEN 365 ELSE 30 END,
available_through=current_date,aggregated_through=current_date,finalized_through=current_date;
INSERT INTO freeze_cursors(site_id,grain,next_bucket_start)
SELECT s.id,g,current_date FROM m5_sites s CROSS JOIN unnest(ARRAY['hour','day']) g
ON CONFLICT(site_id,grain) DO UPDATE SET next_bucket_start=excluded.next_bucket_start;
COMMIT;
ANALYZE;
SELECT json_build_object('pv',(SELECT count(*) FROM events),'member_rows',(SELECT count(*) FROM visitor_days),
  'member_days',(SELECT count(DISTINCT local_date) FROM visitor_days),'aggregate_days',(SELECT count(DISTINCT local_date) FROM stats_daily),
  'cross_midnight_sessions',(SELECT count(*) FROM sessions WHERE started_at::date<>last_activity_at::date),
  'relation_bytes',(SELECT sum(pg_total_relation_size(quote_ident(tablename))) FROM pg_tables WHERE schemaname=current_schema())) AS fixture;
