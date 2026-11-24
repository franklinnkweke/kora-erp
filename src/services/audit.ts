import type { DB } from '../db.js';

export function audit(db: DB, userId: number | null, action: string, entity: string, entityId: number | null, detail?: string) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(userId, action, entity, entityId, detail ?? null);
}

export function listAudit(db: DB, limit = 100) {
  return db.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                     ORDER BY a.id DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 500));
}
