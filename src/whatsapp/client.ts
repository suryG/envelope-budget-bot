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
import { getStatusMessage } from "../commands/status";
import { handleEditCommand } from "../commands/edit";

// משתנים גלובליים המיוצאים לשימוש Express
export let latestQrDataUrl: string | null = null;
let currentSocket: WASocket | null = null;

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
    // משתיק לוגים פנימיים לחלוטין ברמת הספרייה
    logger: pino({ level: "fatal" }), 
    browser: Browsers.ubuntu("Desktop"),
    
    // סינון סטטוסים וסנכרון היסטוריה ברמת הפרוטוקול
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    shouldIgnoreJid: (jid) => isJidStatusBroadcast(jid), // סינון מוחלט של סטטוסים לפני פיענוח
    
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,

    // פונקציית מפתח למניעת קריסות Retry בעת שגיאות פיענוח
    getMessage: async (_key: WAMessageKey) => {
      return undefined;
    },
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
      
      console.log(`החיבור נסגר. קוד שגיאה: ${statusCode} | מתחבר מחדש? ${shouldReconnect}`);

      if (shouldReconnect) {
        startWhatsAppClient();
      } else {
        console.log("❌ החיבור נזנח (Logged Out). נדרש סריקת QR מחדש.");
      }
    } else if (connection === "open") {
      currentSocket = sock;
      latestQrDataUrl = null; // איפוס ה-QR לאחר התחברות בהצלחה
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

      // 2. חילוץ טקסט
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text;

      if (!text) return;

      const sender = msg.key.remoteJid;
      if (!sender) return;

      const trimmedText = text.trim();

      console.log(`📩 התקבלה הודעה מ-${sender}: "${trimmedText}"`);

      // 3. טיפול בפקודת "יתרות"
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