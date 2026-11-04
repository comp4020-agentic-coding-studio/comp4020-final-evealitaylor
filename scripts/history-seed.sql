-- Fills an existing app database with a long, plausible history for
-- scripts/history-bench.sh. All rows are finished (released/expired, old
-- reports), so none should show on the map or be scanned per request.
CREATE TEMP TABLE d AS SELECT row_number() OVER (ORDER BY id) - 1 AS k, id FROM desks;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 50000)
INSERT INTO claims (desk_id, name, started_at, checked_in_at, expires_at, status, token)
SELECT d.id, 'hist'||i, 1700000000000 + i*60000, NULL, 1700000000000 + i*60000 + 20000, CASE WHEN i%2=0 THEN 'expired' ELSE 'released' END, NULL FROM n JOIN d ON d.k = i % 56;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 50000)
INSERT INTO occupancy_reports (desk_id, status, created_at)
SELECT d.id, CASE WHEN i%2=0 THEN 'free' ELSE 'taken' END, 1700000000000 + i*60000 FROM n JOIN d ON d.k = i % 56;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 100000)
INSERT INTO activity (at, kind, desk_id, claim_id, actor, detail)
SELECT 1700000000000 + i*30000, 'claim', '2.22-1', i, 'hist'||i, NULL FROM n;
