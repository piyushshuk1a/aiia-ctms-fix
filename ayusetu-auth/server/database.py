"""SQLite persistence with serialized state changes and transactional audit/account updates."""
import sqlite3
from pathlib import Path
from contextlib import contextmanager

SCHEMA = '''
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
 password_hash TEXT, active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
 assignments TEXT NOT NULL DEFAULT '[]', created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL,
 access_digest TEXT UNIQUE, access_expires REAL, refresh_digest TEXT UNIQUE,
 created REAL NOT NULL, absolute_expires REAL NOT NULL, last_activity REAL NOT NULL,
 remembered INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, csrf_digest TEXT NOT NULL,
 otp_verified INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS session_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS spent_refresh (digest TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), cookie_digest TEXT NOT NULL UNIQUE,
 code_digest TEXT NOT NULL, expires REAL NOT NULL, created REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 last_sent REAL NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, remembered INTEGER NOT NULL,
 destination TEXT NOT NULL, user_version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recovery (
 digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS throttle (
 key TEXT PRIMARY KEY, window_start REAL NOT NULL, count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS security_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, actor_id TEXT, event TEXT NOT NULL,
 reason TEXT NOT NULL, subject TEXT, ip_digest TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS security_no_update BEFORE UPDATE ON security_log
 BEGIN SELECT RAISE(ABORT, 'Security events are append-only through the application.'); END;
CREATE TRIGGER IF NOT EXISTS security_no_delete BEFORE DELETE ON security_log
 BEGIN SELECT RAISE(ABORT, 'Security events are append-only through the application.'); END;
CREATE TABLE IF NOT EXISTS clinical_state (id INTEGER PRIMARY KEY CHECK (id=1), body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
'''
class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try: return super().__exit__(*args)
        finally: self.close()

class Database:
    def __init__(self, filename: str):
        self.filename = filename
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)
        Path(filename).chmod(0o600)
    def connect(self):
        conn = sqlite3.connect(self.filename, timeout=30, check_same_thread=False, factory=ClosingConnection)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA busy_timeout=30000')
        return conn
    @contextmanager
    def transaction(self):
        conn = self.connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.commit()
        except BaseException as exc:
            if getattr(exc, 'persist', False): conn.commit()
            else: conn.rollback()
            raise
        finally:
            conn.close()
