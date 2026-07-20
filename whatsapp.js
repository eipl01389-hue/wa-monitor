import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, 'wa_session');

let sock = null;
let isReady = false;
let presenceCallback = null;
let subscribedContacts = new Set();
let authState = null;

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

export function setPresenceCallback(cb) {
    presenceCallback = cb;
}

export function subscribeToPresence(phoneNumber, name) {
    const jid = `${phoneNumber}@s.whatsapp.net`;
    
    if (subscribedContacts.has(jid)) return;
    subscribedContacts.add(jid);
    
    if (isReady && sock) {
        try {
            sock.presenceSubscribe(jid);
            console.log(`[WA] Subscribed to presence: ${name || phoneNumber}`);
        } catch (e) {
            console.log(`[WA] Subscribe error for ${phoneNumber}: ${e.message}`);
        }
    }
}

export async function startWAClient() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    authState = state;

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['WA Monitor', 'Chrome', '1.0.0'],
        syncFullHistory: false
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // QR code is printed to terminal by default
            console.log('\n[WA] ========== SCAN QR CODE ==========');
            console.log('[WA] Open WhatsApp → Linked Devices → Link a Device');
            console.log('[WA] Scan the QR code printed above\n');
        }

        if (connection === 'open') {
            isReady = true;
            console.log('[WA] Connected successfully!');
            
            // Subscribe to all already-added contacts
            const { getContacts } = require('./database.js');
            const contacts = getContacts();
            for (const c of contacts) {
                const jid = `${c.phone_number}@s.whatsapp.net`;
                try {
                    sock.presenceSubscribe(jid);
                    subscribedContacts.add(jid);
                } catch (e) {}
            }
        }

        if (connection === 'close') {
            isReady = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[WA] Disconnected. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(() => startWAClient(), 3000);
            }
        }
    });

    // Presence updates
    sock.ev.on('presence.update', (update) => {
        const { id, presences } = update;
        if (!id || !presences) return;

        for (const [jid, presence] of Object.entries(presences)) {
            // Extract number from jid
            const number = jid.split('@')[0];
            
            // Only process if we're subscribed to this contact
            if (!subscribedContacts.has(jid)) continue;

            // Baileys presence values: 'available' = online, 'unavailable' = offline
            // 'composing' = typing (still online)
            const isOnline = presence.lastKnownPresence === 'available' || 
                           presence.lastKnownPresence === 'composing';
            
            const status = isOnline ? 'online' : 'offline';

            if (presenceCallback) {
                presenceCallback(jid, number, null, status);
            }
        }
    });

    // Messages (just to keep connection alive)
    sock.ev.on('messages.upsert', () => {});
}

export function getConnectionStatus() {
    return {
        isReady,
        subscribedCount: subscribedContacts.size
    };
}
