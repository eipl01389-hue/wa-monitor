import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { initDatabase, addContact, removeContact, getContacts, logPresenceEvent, getPresenceHistory, getStats } from './database.js';
import { startWAClient, onPresenceUpdate, getConnectionStatus, subscribeToPresence, setPresenceCallback } from './whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

initDatabase();

// Track last known status
const lastStatus = {};
let waReady = false;

// WhatsApp presence callback
setPresenceCallback((jid, number, name, status) => {
    const prev = lastStatus[number];
    if (prev !== status) {
        lastStatus[number] = status;
        logPresenceEvent(number, name, status);
        console.log(`[Event] ${name || number}: ${status}`);
    }
});

// ==== API Routes ====

app.get('/api/status', (req, res) => {
    res.json(getConnectionStatus());
});

app.get('/api/contacts', (req, res) => {
    const contacts = getContacts();
    const enhanced = contacts.map(c => {
        const stats = getStats(c.phone_number);
        return { ...c, currentStatus: lastStatus[c.phone_number] || 'unknown', stats };
    });
    res.json(enhanced);
});

app.post('/api/contacts', (req, res) => {
    const { phone_number, name } = req.body;
    if (!phone_number) return res.status(400).json({ error: 'Phone number required' });

    const added = addContact(phone_number, name);
    if (added) {
        const clean = phone_number.replace(/[\s\-\+\(\)]/g, '').replace(/^\+/, '');
        subscribeToPresence(clean, name || clean);
        res.json({ success: true, message: `Now monitoring ${name || phone_number}` });
    } else {
        res.json({ success: false, message: 'Contact already exists' });
    }
});

app.delete('/api/contacts/:number', (req, res) => {
    const removed = removeContact(req.params.number);
    delete lastStatus[req.params.number];
    res.json({ success: removed });
});

app.get('/api/history/:number', (req, res) => {
    res.json(getPresenceHistory(req.params.number, 100));
});

app.get('/api/stats/:number', (req, res) => {
    const stats = getStats(req.params.number);
    stats.currentStatus = lastStatus[req.params.number] || 'unknown';
    res.json(stats);
});

// ==== Start ====
console.log('[Server] Starting WhatsApp client...');
startWAClient();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║  📡 WhatsApp Presence Monitor        ║`);
    console.log(`║  Running on port ${PORT}               ║`);
    console.log(`╚═══════════════════════════════════════╝\n`);
});
