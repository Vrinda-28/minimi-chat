import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localDay } from './dates.js';

export function openStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'New chat',
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chats_owner ON chats(owner, updated_at DESC);
    CREATE TABLE IF NOT EXISTS turns (
      rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL REFERENCES chats(id),
      asked_at INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
      parts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_chat ON turns(chat_id, rowid DESC);
    CREATE INDEX IF NOT EXISTS turns_date ON turns(asked_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS turn_search USING fts5(
      question, answer, content='turns', content_rowid='rowid', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS turns_insert AFTER INSERT ON turns BEGIN
      INSERT INTO turn_search(rowid, question, answer) VALUES (new.rowid, new.question, new.answer);
    END;
  `);
  const ignored = new Set('about again all also and any are asked been before can change changed check could day days did does each for from had has have how since still than that the them then there these they this those today too update updates was were what when which who will with would yesterday you your last monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december'.split(' '));
  const select = 't.rowid, t.id, t.chat_id AS chatId, t.asked_at AS askedAt, t.question, t.answer, t.parts';
  const hydrate = ({ parts, ...turn }) => ({ ...turn, parts: JSON.parse(parts) });

  return {
    close: () => db.close(),
    list(owner) {
      return db.prepare('SELECT id, title, updated_at AS updatedAt FROM chats WHERE owner = ? ORDER BY updated_at DESC LIMIT 100').all(owner);
    },
    create(owner, now) {
      const id = randomUUID();
      db.prepare('INSERT INTO chats(id, owner, updated_at) VALUES (?, ?, ?)').run(id, owner, now);
      return { id, title: 'New chat', updatedAt: now };
    },
    chat(owner, chatId) {
      return db.prepare('SELECT id, title, updated_at AS updatedAt FROM chats WHERE owner = ? AND id = ?').get(owner, chatId);
    },
    history(chatId) {
      return db.prepare(`SELECT ${select} FROM turns t WHERE chat_id = ? ORDER BY rowid DESC LIMIT 150`).all(chatId).reverse().map(hydrate);
    },
    turn(chatId, id) {
      const row = db.prepare(`SELECT ${select} FROM turns t WHERE chat_id = ? AND id = ?`).get(chatId, id);
      return row && hydrate(row);
    },
    save({ id, chatId, askedAt, question, parts }) {
      const answer = parts.map(part => part.text).join('\n\n');
      const title = [...question.replace(/\s+/g, ' ')].slice(0, 62).join('');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO turns(id, chat_id, asked_at, question, answer, parts) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, chatId, askedAt, question, answer, JSON.stringify(parts));
        db.prepare(`UPDATE chats SET updated_at = max(updated_at, ?),
          title = CASE WHEN (SELECT count(*) FROM turns WHERE chat_id = ?) = 1 THEN ? ELSE title END
          WHERE id = ?`).run(askedAt, chatId, title, chatId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    recall({ owner, chatId, question, dates, zone }) {
      const fields = 't.rowid, t.chat_id AS chatId, t.asked_at AS askedAt, t.question, t.answer, c.title';
      const recent = db.prepare(`SELECT ${fields} FROM turns t JOIN chats c ON c.id = t.chat_id
        WHERE c.owner = ? AND c.id = ? ORDER BY t.rowid DESC LIMIT 8`).all(owner, chatId).reverse();

      // A 24-hour margin covers offsets including UTC+14 and daylight-saving changes.
      const dateMatches = db.prepare(`SELECT ${fields} FROM turns t JOIN chats c ON c.id = t.chat_id
        WHERE c.owner = ? AND t.asked_at >= ? AND t.asked_at < ? ORDER BY t.asked_at ASC, t.rowid ASC`);
      const dayMs = 86_400_000;
      const dated = dates.flatMap(day => {
        const midnight = Date.parse(day + 'T00:00:00Z');
        return dateMatches.all(owner, midnight - dayMs, midnight + 2 * dayMs)
          .filter(turn => localDay(turn.askedAt, zone) === day)
          .map(turn => ({ ...turn, day }));
      });

      const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])]
        .filter(term => !ignored.has(term) && !/^\d+$/.test(term)).slice(0, 16);
      const matches = terms.length ? db.prepare(`SELECT ${fields} FROM turn_search
        JOIN turns t ON t.rowid = turn_search.rowid JOIN chats c ON c.id = t.chat_id
        WHERE turn_search MATCH ? AND c.owner = ?
        ORDER BY bm25(turn_search, 4.0, 1.0), t.asked_at DESC LIMIT 16`)
        .all(terms.map(term => `"${term}"`).join(' OR '), owner) : [];
      return { recent, dated, matches };
    },
  };
}
