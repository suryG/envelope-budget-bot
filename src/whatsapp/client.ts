import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import fs from "fs";
import { getStatusMessage, getOverBudgetMessage } from "../commands/status";
import { handleEditCommand } from "../commands/edit";
import { confirmTransaction, getLatestPendingTransaction } from "../services/transactionService";

export async function startWhatsAppClient() {
  // טעינת מפתחות האוטנטיקציה
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  // יצירת ה-Socket עם הגדרות מותאמות למניעת Timeout ועומס זיכרון
  const sock: WASocket = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu("Desktop"),
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false, // מתעלם מטעינת היסטוריית עבר כבדה
    connectTimeoutMs: 60000,              // מאריך את זמן ההמתנה לחיבור ל-60 שניות
    defaultQueryTimeoutMs: 60000,
  });

  // שמירת עדכוני אשראי/סשן
  sock.ev.on("creds.update", saveCreds);

  // ניהול החיבור ועדכוני סטטוס
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n==========================================");
      console.log("🔗 קוד QR חדש נוצר בהצלחה!");
      console.log("פתחו בדפדפן את הכתובת: <YOUR_RENDER_URL>/qr");
      console.log("==========================================\n");
      // שמירת קוד ה-QR כקובץ/תמונה במידת הצורך עבור נתיב ה-/qr
      await QRCode.toFile("./qr.png", qr);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`החיבור נסגר. קוד שגיאה: ${statusCode} | מתחבר מחדש? ${shouldReconnect}`);

      if (shouldReconnect) {
        startWhatsAppClient();
      }
    } else if (connection === "open") {
      console.log("✅ מחובר בהצלחה לוואטסאפ!");
    }
  });

  // מנגנון קבלת הודעות נכנסות
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];

      // התעלם מהודעות שאין לצידן תוכן או שנשלחו על ידי הבוט עצמו
      if (!msg || msg.key.fromMe) return;

      // חילוץ טקסט בטוח (התעלמות מהודעות מוצפנות מסוג pkmsg / הודעות מערכת)
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text;

      if (!text) return;

      const trimmedText = text.trim();
      const sender = msg.key.remoteJid;

      if (!sender) return;

      console.log(`📩 התקבלה הודעה מ-${sender}: "${trimmedText}"`);

      // טיפול בפקודת "יתרות"
      if (trimmedText === "יתרות" || trimmedText.toLowerCase() === "status") {
        const statusMsg = await getStatusMessage();
        await sock.sendMessage(sender, { text: statusMsg });
        return;
      }

      // טיפול בפקודת עריכה
      if (trimmedText.startsWith("ערוך") || trimmedText.startsWith("edit")) {
        await handleEditCommand(sock, sender, trimmedText);
        return;
      }

      // כאן ניתן להוסיף טיפול בפקודות נוספות (כמו אישור עסקאות וכד')...

    } catch (error) {
      console.error("❌ שגיאה בעיבוד ההודעה:", error);
    }
  });

  return sock;
}