import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  WASocket,
  isJidStatusBroadcast,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import pino from "pino";
import NodeCache from "node-cache";

import { getStatusMessage } from "../commands/status";
import { handleEditCommand } from "../commands/edit";

// משתנים גלובליים המיוצאים לשימוש Express
export let latestQrDataUrl: string | null = null;
let currentSocket: WASocket | null = null;

// NodeCache לניהול מנגנון ה-Retry של הודעות ומניעת לופים של סנכרון/פיענוח
const msgRetryCounterCache = new NodeCache();

export function getSocket(): WASocket | null {
  return currentSocket;
}

export async function startWhatsAppClient() {
  // טעינת מפתחות האוטנטיקציה
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  // יצירת ה-Socket
  const sock: WASocket = makeWASocket({
    auth: state,
    version,
    // משתיק לוגים פנימיים לחלוטין ברמת הספרייה למניעת הצפת Log Buffer
    logger: pino({ level: "fatal" }),
    browser: Browsers.ubuntu("Desktop"),

    // --- הגדרות קריטיות למניעת שגיאות פיענוח, סנכרון היסטוריה ולופי Identity ---
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    shouldIgnoreJid: (jid) => isJidStatusBroadcast(jid), // התעלמות מסטטוסים ברמת ה-Protocol לפני פיענוח

    // ניהול Retry Cache למניעת Bad MAC ולופים של סנכרון מפתחות
    msgRetryCounterCache,

    // פונקציית מפתח להתמודדות עם הודעות שה-PreKey שלהן נכשל/חסר
    getMessage: async (_key: WAMessageKey) => {
      return undefined;
    },

    // הגדלת טיימאאוטים ושמירת חיבור יציב ב-Render
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });

  // שמירת עדכוני סשן
  sock.ev.on("creds.update", saveCreds);

  // ניהול החיבור ועדכוני סטטוס
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n==========================================");
      console.log("🔗 קוד QR חדש נוצר בהצלחה!");
      console.log("==========================================\n");
      latestQrDataUrl = await QRCode.toDataURL(qr);
    }

    if (connection === "close") {
      currentSocket = null;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`🔌 החיבור נסגר. קוד שגיאה: ${statusCode} | מתחבר מחדש? ${shouldReconnect}`);

      if (shouldReconnect) {
        startWhatsAppClient();
      } else {
        console.log("❌ החיבור נזנח (Logged Out). נדרשת סריקת QR מחדש.");
      }
    } else if (connection === "open") {
      currentSocket = sock;
      latestQrDataUrl = null; // איפוס ה-QR לאחר התחברות מוצלחת
      console.log("✅ מחובר בהצלחה לוואטסאפ!");
    }
  });

  // מנגנון קבלת הודעות נכנסות
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];

      // 1. התעלמות מהודעות לא תקינות, הודעות עצמיות, או סטטוסים
      if (
        !msg ||
        msg.key.fromMe ||
        isJidStatusBroadcast(msg.key.remoteJid || "")
      ) {
        return;
      }

      // 2. חילוץ טקסט ההודעה
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text;

      if (!text) return;

      const sender = msg.key.remoteJid;
      if (!sender) return;

      const trimmedText = text.trim();

      console.log(`📩 התקבלה הודעה מ-${sender}: "${trimmedText}"`);

      // 3. טיפול בפקודת "יתרות" / status
      if (trimmedText === "יתרות" || trimmedText.toLowerCase() === "status") {
        const statusMsg = await getStatusMessage();
        await sock.sendMessage(sender, { text: statusMsg });
        return;
      }

      // 4. טיפול בפקודת עריכה
      if (trimmedText.startsWith("ערוך") || trimmedText.startsWith("edit")) {
        await handleEditCommand(sock, sender, trimmedText);
        return;
      }

    } catch (error) {
      console.error("❌ שגיאה בעיבוד ההודעה:", error);
    }
  });

  return sock;
}