-- Contract step of 1.4.0's five statuses: rewrites the leads stored before it (schemaVersion below 3) by the rule
-- of upgradeLead in src/domain/lead.js, which 1.4.0 already applies on read. Deployed code reads both shapes, so
-- nothing that runs reads what this removes. test/migration.test.js holds SQL, upgradeLead and the first 1.4.0
-- write to the same result; where the upgrade finds no day, SQL stores what that write stores. An erased lead ('{}')
-- stays a tombstone.

-- One new seq per live lead rewritten, so every client gets the change through /api/sync.
UPDATE counter SET seq = seq + (
  SELECT COUNT(*) FROM docs
  WHERE collection = 'leads' AND deleted = 0 AND data != '{}' AND COALESCE(json_extract(data, '$.schemaVersion'), 0) < 3
) WHERE id = 1;

-- Each step below is one line of upgradeLead. A live lead takes those seqs in its old order, and the history trigger
-- records the change under 'migration 0003'. A trashed lead changes in place: its seq and updated_by still say who
-- deleted it and when, and it gets no history row. It was trashed together with its activities, so its first
-- contact is a trashed activity. The first contact is the earliest activity either way, as on every 1.4.0 write.
WITH lead AS (
  SELECT
    d.id,
    (SELECT seq FROM counter WHERE id = 1) - COUNT(*) OVER (PARTITION BY d.deleted) + ROW_NUMBER() OVER (PARTITION BY d.deleted ORDER BY d.seq) AS new_seq,
    -- A row without a status reads as neu, as LEAD_FIELDS fills it in on read.
    COALESCE(json_extract(d.data, '$.status'), 'neu') AS old_status,
    json_extract(d.data, '$.lostReason') AS old_reason,
    json_extract(d.data, '$.followUp') AS follow_up,
    NULLIF(json_extract(d.data, '$.contactedAt'), '') AS stored_contacted_at,
    NULLIF(json_extract(d.data, '$.optOutAt'), '') AS stored_opt_out_at,
    -- An activity dated after today (1.3 took any date) is no contact yet, as in firstContactUntil.
    (SELECT MIN(json_extract(a.data, '$.date')) FROM docs a
      WHERE a.collection = 'activities' AND a.deleted = d.deleted AND json_extract(a.data, '$.leadId') = d.id
        AND json_extract(a.data, '$.date') <= date('now')) AS first_contact,
    -- The UTC day, as dayOf cuts it; a timestamp an old import stored in another format gives none.
    CASE WHEN json_type(d.data, '$.createdAt') = 'text' AND substr(json_extract(d.data, '$.createdAt'), 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      THEN substr(json_extract(d.data, '$.createdAt'), 1, 10) END AS created_day,
    CASE WHEN json_type(d.data, '$.updatedAt') = 'text' AND substr(json_extract(d.data, '$.updatedAt'), 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      THEN substr(json_extract(d.data, '$.updatedAt'), 1, 10) END AS updated_day
  FROM docs d
  WHERE d.collection = 'leads' AND d.data != '{}' AND COALESCE(json_extract(d.data, '$.schemaVersion'), 0) < 3
), dated AS (
  SELECT *,
    COALESCE(stored_contacted_at, first_contact, CASE WHEN old_status IN ('kontaktiert', 'antwort', 'demo', 'onboarding', 'kunde', 'qualifiziert')
      OR (old_status = 'kein-interesse' AND old_reason = 'Keine Antwort') THEN created_day END) AS contacted_at,
    CASE old_reason WHEN 'Zu wenig Reservierungen' THEN 'Zu klein' WHEN 'Telefon reicht ihnen' THEN 'Kein Bedarf' ELSE old_reason END AS reason
  FROM lead
), opted AS (
  SELECT *,
    COALESCE(stored_opt_out_at, CASE WHEN reason = 'Keine Kontaktaufnahme gewünscht' THEN COALESCE(updated_day, created_day) END) AS opt_out_at,
    CASE WHEN old_status = 'kein-interesse' THEN
      CASE WHEN reason IN ('Zufrieden mit aktueller Lösung', 'Kein Bedarf', 'Zu klein', 'Nicht unsere Zielgruppe', 'Geschlossen / existiert nicht', 'Nicht erreicht', 'Keine Kontaktaufnahme gewünscht')
        THEN 'disqualifiziert' ELSE 'neu' END
    ELSE CASE old_status WHEN 'recherchiert' THEN 'neu' WHEN 'antwort' THEN 'kontaktiert' WHEN 'demo' THEN 'qualifiziert' WHEN 'onboarding' THEN 'kunde' ELSE old_status END
    END AS mapped_status
  FROM dated
), closed AS (
  SELECT *, CASE WHEN opt_out_at IS NOT NULL AND mapped_status IS NOT 'kunde' THEN 'disqualifiziert' ELSE mapped_status END AS opted_status
  FROM opted
), upgraded AS (
  SELECT id, new_seq, contacted_at, opt_out_at, reason, follow_up,
    CASE WHEN opted_status = 'neu' AND contacted_at IS NOT NULL THEN 'kontaktiert' ELSE opted_status END AS status
  FROM closed
)
UPDATE docs SET
  data = json_set(docs.data,
    '$.status', u.status,
    -- Where the upgrade finds no day (an old import's timestamp in another format, no logged contact), the first 1.4.0
    -- write dates a contacted lead's first contact, or an opt-out reason's opt-out, today (normalizeLead). date('now')
    -- is the UTC day; 1.4.0's is Vienna's, which differs only between midnight and 2 am.
    '$.contactedAt', COALESCE(u.contacted_at, CASE WHEN u.status IN ('kontaktiert', 'qualifiziert', 'kunde') THEN date('now') END),
    '$.optOutAt', COALESCE(u.opt_out_at, CASE WHEN u.status = 'disqualifiziert' AND u.reason = 'Keine Kontaktaufnahme gewünscht' THEN date('now') END),
    '$.lostReason', CASE WHEN u.status = 'disqualifiziert' THEN CASE WHEN u.opt_out_at IS NOT NULL THEN 'Keine Kontaktaufnahme gewünscht' ELSE u.reason END END,
    '$.followUp', CASE WHEN u.status = 'disqualifiziert' THEN NULL ELSE u.follow_up END,
    '$.schemaVersion', 3),
  seq = CASE WHEN docs.deleted = 0 THEN u.new_seq ELSE docs.seq END,
  updated_by = CASE WHEN docs.deleted = 0 THEN 'migration 0003' ELSE docs.updated_by END
FROM upgraded u
WHERE docs.collection = 'leads' AND docs.id = u.id;

-- Last, so it can fail the whole file: any lead, rewritten or not, that breaks a 1.4.0 rule fails write_guard's
-- stale_write CHECK.
INSERT OR REPLACE INTO write_guard (id, hit)
SELECT 1, COUNT(*) = 0 FROM (
  SELECT
    json_extract(data, '$.status') AS status,
    json_extract(data, '$.lostReason') AS reason,
    NULLIF(json_extract(data, '$.contactedAt'), '') AS contacted_at,
    NULLIF(json_extract(data, '$.optOutAt'), '') AS opt_out_at,
    NULLIF(json_extract(data, '$.followUp'), '') AS follow_up,
    COALESCE(json_extract(data, '$.schemaVersion'), 0) AS schema_version
  FROM docs WHERE collection = 'leads' AND data != '{}'
)
WHERE status IS NULL OR status NOT IN ('neu', 'kontaktiert', 'qualifiziert', 'kunde', 'disqualifiziert')
  OR (status = 'disqualifiziert' AND (follow_up IS NOT NULL OR reason IS NULL OR reason NOT IN ('Zufrieden mit aktueller Lösung', 'Kein Bedarf',
    'Zu klein', 'Nicht unsere Zielgruppe', 'Geschlossen / existiert nicht', 'Nicht erreicht', 'Keine Kontaktaufnahme gewünscht')))
  OR (status != 'disqualifiziert' AND reason IS NOT NULL)
  OR (status = 'neu' AND contacted_at IS NOT NULL)
  OR (status IN ('kontaktiert', 'qualifiziert', 'kunde') AND contacted_at IS NULL)
  OR (reason = 'Keine Kontaktaufnahme gewünscht' AND opt_out_at IS NULL)
  OR (opt_out_at IS NOT NULL AND status IN ('neu', 'kontaktiert', 'qualifiziert'))
  OR (opt_out_at IS NOT NULL AND status = 'disqualifiziert' AND reason IS NOT 'Keine Kontaktaufnahme gewünscht')
  -- A day of slack: 1.4.0 dates by Vienna's day, ahead of date('now') between midnight and 2 am.
  OR contacted_at > date('now', '+1 day')
  OR contacted_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR opt_out_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR schema_version < 3;
