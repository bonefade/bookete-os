import { SCHEMA_VERSION } from './constants.js';

// Records per import call: keeps each request well inside D1's per-invocation query limit.
export const IMPORT_CHUNK = 40;
export const BACKUP_FORMAT = "bookete-crm-backup";
export function createBackup({ leads, activities, templates, settings }, now) {
  return { format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now, data: { leads, activities, templates, settings } };
}

/** Splits a backup into backups of at most IMPORT_CHUNK records each. */
export function chunkBackup(backup) {
  const chunks = [];
  for (const [collection, records] of Object.entries(backup.data || {}))
    for (let i = 0; i < records.length; i += IMPORT_CHUNK)
      chunks.push({ ...backup, data: { [collection]: records.slice(i, i + IMPORT_CHUNK) } });
  return chunks;
}
