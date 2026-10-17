import { SCHEMA_VERSION } from './constants.js';
import { upgradeLead } from './lead.js';
import { firstContactUntil } from './activity.js';
import { groupByLead } from './stats.js';

// Records per import call: keeps each request well inside D1's per-invocation query limit.
export const IMPORT_CHUNK = 40;
export const BACKUP_FORMAT = "bookete-crm-backup";
export function createBackup({ leads, activities, templates, settings }, now) {
  return { format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now, data: { leads, activities, templates, settings } };
}

/** Brings the leads of an older backup to the current format, while their activities are still in the same file. */
export function upgradeBackup(backup, today) {
  const acts = groupByLead(backup.data?.activities || []);
  const leads = backup.data?.leads?.map((l) => upgradeLead(l, firstContactUntil(acts.get(l.id) || [], today)));
  return leads ? { ...backup, data: { ...backup.data, leads } } : backup;
}

/** Splits a backup into backups of at most IMPORT_CHUNK records each, upgraded first: the server sees one collection at a time. */
export function chunkBackup(backup, today) {
  const chunks = [];
  for (const [collection, records] of Object.entries(upgradeBackup(backup, today).data || {}))
    for (let i = 0; i < records.length; i += IMPORT_CHUNK)
      chunks.push({ ...backup, data: { [collection]: records.slice(i, i + IMPORT_CHUNK) } });
  return chunks;
}
