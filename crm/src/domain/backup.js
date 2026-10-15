import { SCHEMA_VERSION } from './constants.js';

export const BACKUP_FORMAT = "bookete-crm-backup";
export function createBackup({ leads, activities, templates, settings }, now) {
  return { format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now, data: { leads, activities, templates, settings } };
}
