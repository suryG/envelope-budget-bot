import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import pino from "pino";
import { getStatusMessage, getOverBudgetMessage } from "../commands/status";
import { handleEditCommand } from "../commands/edit";
import { confirmTransaction, getLatestPendingTransaction } from "../services/transactionService";

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
    logger: pino({ level: "silent" }), // משתיק לוגים פנימיים כגון כשלים בפענוח סטטוסים
    browser: Browsers.ubuntu("Desktop"),
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false, // מתעלם מטעינת היסטוריה כבדה
    connectTimeoutMs: 60000,              // מאריך זמן המתינה ל-60 שניות
    defaultQueryTimeoutMs: 60000,
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
      // שמירת קוד ה-QR בפורמט Data URL עבור תצוגה בדפדפן ב-Express
      latestQrDataUrl = await QRCode.toDataURL(qr);
    }

    if (connection === "close") {
      currentSocket = null;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`החיבור נסגר. קוד שגיאה: ${statusCode} | מתחבר מחדש? ${shouldReconnect}`);

      if (shouldReconnect) {
        startWhatsAppClient();
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

      // 1. התעלם מהודעות ריקות, הודעות שנשלחו ע"י הבוט, או עדכוני סטטוס/סטורי
      if (
        !msg ||
        msg.key.fromMe ||
        msg.key.remoteJid === "status@broadcast"
      ) {
        return;
      }

      // 2. חילוץ טקסט בטוח (התעלמות מ-pkmsg והודעות מערכת)
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text;

      if (!text) return;

      const sender = msg.key.remoteJid;
      if (!sender) return; // Guard clause עבור הטיפוס של sender

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

      // כאן ניתן להמשיך לוגיקת פקודות נוספות...

    } catch (error) {
      console.error("❌ שגיאה בעיבוד ההודעה:", error);
    }
  });

  return sock;
}