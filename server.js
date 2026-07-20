import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, addContact, removeContact, getContacts, logPresenceEvent, getPresenceHistory, getStats } from './database.js';
import { startWAClient, onPresenceUpdate, getConnectionStatus, subscribeToPresence, setPresenceCallback, requestPairingCode } from './whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

initDatabase();

// Track last known status
const lastStatus = {};

// WhatsApp presence callback
setPresenceCallback((jid, number, name, status) => {
    const prev = lastStatus[number];
    if (prev !== status) {
        lastStatus[number] = status;
        logPresenceEvent(number, name || number, status);
        console.log(`[Event] ${name || number}: ${status}`);
    }
});

// ==== API Routes ====

// Connection status
app.get('/api/status', (req, res) => {
    res.json(getConnectionStatus());
});

// Request a pairing code to link WhatsApp
app.post('/api/pair', async (req, res) => {
    const { phone_number } = req.body;
    
    if (!phone_number) {
        return res.status(400).json({ 
            success: false, 
            message: 'Phone number is required' 
        });
    }
    
    try {
        const result = await requestPairingCode(phone_number);
        res.json(result);
    } catch (error) {
        res.json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Check if session exists (already paired)
app.get('/api/session-status', (req, res) => {
    const status = getConnectionStatus();
    res.json(status);
});

// Contacts
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
    console.log(`[Server] To connect WhatsApp:`);
    console.log(`[Server] 1. Go to the web app → tap "Connect WhatsApp"`);
    console.log(`[Server] 2. Enter your phone number`);
    console.log(`[Server] 3. Enter the code in WhatsApp → Linked Devices\n`);
});
