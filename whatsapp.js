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
let pairingCodeResolve = null;

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

/**
 * Generate a pairing code for a given phone number.
 * The user enters this code in WhatsApp → Linked Devices → Link with Phone Number
 */
export async function requestPairingCode(phoneNumber) {
    if (!sock) {
        throw new Error('WhatsApp client not initialized');
    }
    
    try {
        // Clean the phone number
        const cleanNumber = phoneNumber.replace(/[\s\-\+\(\)]/g, '').replace(/^\+/, '');
        
        console.log(`[WA] Requesting pairing code for: ${cleanNumber}`);
        
        // Request pairing code from WhatsApp
        const code = await sock.requestPairingCode(cleanNumber);
        
        // Format nicely: XXXX-XXXX
        const formattedCode = code.substring(0, 4) + '-' + code.substring(4, 8);
        
        console.log(`[WA] Pairing code: ${formattedCode}`);
        
        return {
            success: true,
            code: formattedCode,
            rawCode: code,
            message: `Pairing code generated. Open WhatsApp → Linked Devices → Link with Phone Number → Enter: ${formattedCode}`
        };
    } catch (error) {
        console.error(`[WA] Pairing code error: ${error.message}`);
        return {
            success: false,
            error: error.message,
            message: `Failed to generate code: ${error.message}`
        };
    }
}

export async function startWAClient() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,  // Don't print QR since we use pairing code
        browser: ['WA Monitor', 'Chrome', '1.0.0'],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            isReady = true;
            console.log('[WA] ✅ Connected successfully!');
            
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
                console.log('[WA] Logged out. Session cleared.');
                // Clean up session so user can re-link
                try {
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    fs.mkdirSync(SESSION_DIR, { recursive: true });
                } catch(e) {}
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
    // Check if we have credentials (means previously authenticated)
    const hasAuth = fs.existsSync(path.join(SESSION_DIR, 'creds.json'));
    
    return {
        isReady,
        subscribedCount: subscribedContacts.size,
        hasStoredSession: hasAuth,
        // If we have stored session but not ready, we're connecting
        status: isReady ? 'connected' : (hasAuth ? 'connecting' : 'disconnected')
    };
}
