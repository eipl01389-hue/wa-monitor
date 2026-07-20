import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getContacts } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, 'wa_session');

let sock = null;
let isReady = false;
let presenceCallback = null;
const subscribedContacts = new Set();

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
            console.log(`[WA] Subscribed: ${name || phoneNumber}`);
        } catch (e) {
            console.log(`[WA] Subscribe error: ${e.message}`);
        }
    }
}

export async function startWAClient() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['WA Monitor', 'Chrome', '1.0.0'],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n[WA] ===== SCAN QR CODE =====');
            console.log('[WA] Open WhatsApp → Linked Devices → Link a Device\n');
        }

        if (connection === 'open') {
            isReady = true;
            console.log('[WA] Connected!');
            
            // Subscribe to existing contacts
            const contacts = getContacts();
            for (const c of contacts) {
                const jid = `${c.phone_number}@s.whatsapp.net`;
                try {
                    sock.presenceSubscribe(jid);
                    subscribedContacts.add(jid);
                    console.log(`[WA] Auto-subscribed: ${c.name || c.phone_number}`);
                } catch (e) {}
            }
        }

        if (connection === 'close') {
            isReady = false;
            const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
            if (!loggedOut) {
                console.log('[WA] Reconnecting in 3s...');
                setTimeout(() => startWAClient(), 3000);
            } else {
                console.log('[WA] Logged out. Delete session and restart.');
            }
        }
    });

    sock.ev.on('presence.update', (update) => {
        const { id, presences } = update;
        if (!id || !presences) return;

        for (const [jid, presence] of Object.entries(presences)) {
            if (!subscribedContacts.has(jid)) continue;
            
            const number = jid.split('@')[0];
            const isOnline = presence.lastKnownPresence === 'available' || 
                           presence.lastKnownPresence === 'composing';
            const status = isOnline ? 'online' : 'offline';

            if (presenceCallback) {
                presenceCallback(jid, number, null, status);
            }
        }
    });

    // Keep alive
    sock.ev.on('messages.upsert', () => {});
}

export function getConnectionStatus() {
    return {
        isReady,
        subscribedCount: subscribedContacts.size
    };
}
