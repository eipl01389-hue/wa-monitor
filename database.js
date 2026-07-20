import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'presence.db');

let db;

export function initDatabase() {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone_number TEXT UNIQUE NOT NULL,
            name TEXT,
            added_at TEXT DEFAULT (datetime('now'))
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS presence_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_number TEXT NOT NULL,
            contact_name TEXT,
            timestamp TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('online', 'offline')),
            duration_seconds INTEGER DEFAULT 0,
            session_start TEXT
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS active_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_number TEXT UNIQUE NOT NULL,
            start_time TEXT NOT NULL,
            last_updated TEXT NOT NULL
        )
    `);

    console.log('[DB] Initialized');
    return db;
}

export function getDB() {
    if (!db) return initDatabase();
    return db;
}

export function addContact(phoneNumber, name) {
    const d = getDB();
    const clean = phoneNumber.replace(/[\s\-\+\(\)]/g, '').replace(/^\+/, '');
    try {
        const r = d.prepare('INSERT OR IGNORE INTO contacts (phone_number, name) VALUES (?, ?)').run(clean, name || clean);
        return r.changes > 0;
    } catch (e) { return false; }
}

export function removeContact(phoneNumber) {
    const d = getDB();
    const clean = phoneNumber.replace(/[\s\-\+\(\)]/g, '').replace(/^\+/, '');
    d.prepare('DELETE FROM presence_events WHERE contact_number = ?').run(clean);
    d.prepare('DELETE FROM active_sessions WHERE contact_number = ?').run(clean);
    return d.prepare('DELETE FROM contacts WHERE phone_number = ?').run(clean).changes > 0;
}

export function getContacts() {
    return getDB().prepare('SELECT * FROM contacts ORDER BY added_at DESC').all();
}

export function logPresenceEvent(contactNumber, contactName, status) {
    const d = getDB();
    const now = new Date().toISOString();

    if (status === 'online') {
        // Clear any existing session for this contact
        d.prepare('DELETE FROM active_sessions WHERE contact_number = ?').run(contactNumber);
        d.prepare('INSERT INTO active_sessions (contact_number, start_time, last_updated) VALUES (?, ?, ?)').run(contactNumber, now, now);
        d.prepare('INSERT INTO presence_events (contact_number, contact_name, timestamp, status) VALUES (?, ?, ?, ?)').run(contactNumber, contactName, now, 'online');
    } else {
        const session = d.prepare('SELECT start_time FROM active_sessions WHERE contact_number = ?').get(contactNumber);
        if (session) {
            const duration = Math.floor((new Date() - new Date(session.start_time)) / 1000);
            d.prepare(`UPDATE presence_events SET duration_seconds = ?, session_start = ?
                       WHERE contact_number = ? AND status = 'online'
                       AND id = (SELECT MAX(id) FROM presence_events WHERE contact_number = ? AND status = 'online')`)
                .run(duration, session.start_time, contactNumber, contactNumber);
            d.prepare('DELETE FROM active_sessions WHERE contact_number = ?').run(contactNumber);
        }
        d.prepare('INSERT INTO presence_events (contact_number, contact_name, timestamp, status) VALUES (?, ?, ?, ?)').run(contactNumber, contactName, now, 'offline');
    }
}

export function getPresenceHistory(contactNumber, limit = 50) {
    const clean = contactNumber.replace(/[\s\-\+\(\)]/g, '').replace(/^\+/, '');
    return getDB().prepare('SELECT * FROM presence_events WHERE contact_number = ? ORDER BY id DESC LIMIT ?').all(clean, limit);
}

export function getStats(contactNumber) {
    const d = getDB();
    const clean = contactNumber.replace(/[\s\-\+\(\)]/g, '').replace(/^\+/, '');
    const today = new Date().toISOString().split('T')[0];

    const active = d.prepare('SELECT * FROM active_sessions WHERE contact_number = ?').get(clean);
    const todayOnline = d.prepare(`SELECT COALESCE(SUM(duration_seconds),0) as t FROM presence_events
                                  WHERE contact_number=? AND status='online' AND date(timestamp)=?`).get(clean, today);
    const totalOnline = d.prepare(`SELECT COALESCE(SUM(duration_seconds),0) as t FROM presence_events
                                  WHERE contact_number=? AND status='online'`).get(clean);
    const todayEvents = d.prepare(`SELECT COUNT(*) as c FROM presence_events
                                  WHERE contact_number=? AND date(timestamp)=?`).get(clean, today);
    const lastSession = d.prepare(`SELECT duration_seconds FROM presence_events
                                  WHERE contact_number=? AND status='online' AND duration_seconds>0
                                  ORDER BY id DESC LIMIT 1`).get(clean);
    const avgSession = d.prepare(`SELECT COALESCE(AVG(duration_seconds),0) as a FROM presence_events
                                 WHERE contact_number=? AND status='online' AND duration_seconds>0`).get(clean);
    const totalSessions = d.prepare(`SELECT COUNT(*) as c FROM presence_events
                                   WHERE contact_number=? AND status='online'`).get(clean);

    return {
        currentlyOnline: !!active,
        sessionStart: active ? active.start_time : null,
        todayOnlineSeconds: todayOnline.t,
        totalOnlineSeconds: totalOnline.t,
        todayEvents: todayEvents.c,
        lastSessionSeconds: lastSession ? lastSession.duration_seconds : 0,
        avgSessionSeconds: Math.floor(avgSession.a),
        totalSessions: totalSessions.c
    };
}
