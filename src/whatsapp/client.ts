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

import { getStatusMessage, getOverBudgetMessage } from "../commands/status";
import { handleEditCommand } from "../commands/edit";
import { 
  getLatestPendingTransaction, 
  confirmTransaction, 
  rejectSuggestedCategory 
} from "../services/transactionService";
import { isUserInWizard, handleWizardStep, startCardWizard } from "./cardWizard";

// משתנים גלובליים המיוצאים לשימוש Express
export let latestQrDataUrl: string | null = null;
let currentSocket: WASocket | null = null;

// NodeCache לניהול מנגנון ה-Retry של הודעות ומניעת לופים של סנכרון/פיענוח
const msgRetryCounterCache = new NodeCache();

export function getSocket(): WASocket | null {
  return currentSocket;
}

/**
 * פונקציה לשליחת הודעה על עסקה חדשה שהגיעה (נקראת למשל מתוך ה-Scraper)
 */
export async function sendTransactionNotification(
  targetJid: string, 
  transactionData: { id: string; merchant: string; amount: number; suggestedCategoryName: string | null; status: string }
) {
  if (!currentSocket) {
    console.error("❌ לא ניתן לשלוח הודעה: ה-Socket של WhatsApp אינו מחובר.");
    return;
  }

  let text = "";
  if (transactionData.status === "PENDING_CONFIRMATION") {
    text = `💳 *עסקה חדשה!*\n` +
           `רכישה ב- *${transactionData.merchant}* על סך *${transactionData.amount} ₪*.\n\n` +
           `לשייך לקטגוריה *${transactionData.suggestedCategoryName}*? (השיבו *כן* / *לא*)`;
  } else {
    text = `💳 *עסקה חדשה!*\n` +
           `רכישה ב- *${transactionData.merchant}* על סך *${transactionData.amount} ₪*.\n\n` +
           `לאיזו קטגוריה לשייך את העסקה? (רשמו את שם הקטגוריה)`;
  }

  await currentSocket.sendMessage(targetJid, { text });
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

      // 1. התעלמות מהודעות ריקות, הודעות שנשלחו ע"י הבוט עצמו או מסטטוסים ברשת
      if (!msg || !msg.message || msg.key.fromMe || isJidStatusBroadcast(msg.key.remoteJid || "")) {
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

      // הדפסת לוג לכל הודעה שנקלטת
      console.log(`📩 התקבלה הודעה מ-${sender}: "${trimmedText}"`);

      // -------------------------------------------------------------
      // 🟢 3. דיאלוג הוספת כרטיס אשראי (Wizard State)
      // -------------------------------------------------------------
      if (isUserInWizard(sender)) {
        await handleWizardStep(sock, sender, trimmedText);
        return;
      }

      if (trimmedText === "הוסף כרטיס") {
        await startCardWizard(sock, sender);
        return;
      }

      // -------------------------------------------------------------
      // 🟢 4. הודעת פתיחה / תפריט ראשי ("היי")
      // -------------------------------------------------------------
      const lowerText = trimmedText.toLowerCase();
      if (["היי", "הי", "hi", "hello", "שלום", "תפריט"].includes(lowerText)) {
        const welcomeMessage = 
`👋 *היי! איזה כיף שפנית אלי.*

מה ברצונך לעשות? הנה הפקודות הזמינות:

📊 *לצפייה ביתרות:* רשום/י *יתרות*
⚠️ *לצפייה בחריגות תקציב:* רשום/י *חריגות*
💳 *להוספת כרטיס אשראי חדש:* רשום/י *הוסף כרטיס*
✏️ *לעריכת קטגוריות/תקציב:* רשום/י *ערוך*`;

        await sock.sendMessage(sender, { text: welcomeMessage });
        return;
      }

      // -------------------------------------------------------------
      // 5. טיפול בפקודת "יתרות" / status
      // -------------------------------------------------------------
      if (trimmedText === "יתרות" || lowerText === "status") {
        const statusMsg = await getStatusMessage();
        await sock.sendMessage(sender, { text: statusMsg });
        return;
      }

      // -------------------------------------------------------------
      // 6. טיפול בפקודת "חריגות"
      // -------------------------------------------------------------
      if (trimmedText === "חריגות") {
        const overBudgetMsg = await getOverBudgetMessage();
        await sock.sendMessage(sender, { text: overBudgetMsg });
        return;
      }

      // -------------------------------------------------------------
      // 7. טיפול בפקודת עריכה
      // -------------------------------------------------------------
      if (trimmedText.startsWith("ערוך") || lowerText.startsWith("edit")) {
        const responseText = await handleEditCommand(trimmedText);
        await sock.sendMessage(sender, { text: responseText });
        return;
      }

      // -------------------------------------------------------------
      // 8. טיפול בעסקאות הממתינות למיון/אישור (Transaction Engine)
      // -------------------------------------------------------------
      const pendingTx = await getLatestPendingTransaction();

      if (pendingTx) {
        // --- מקרה א': עסקה בסטטוס PENDING_CONFIRMATION (מחכה ל"כן" / "לא") ---
        if (pendingTx.status === "PENDING_CONFIRMATION") {
          if (trimmedText === "כן" || lowerText === "yes") {
            const { category } = await confirmTransaction(pendingTx.id, pendingTx.category!.name);
            await sock.sendMessage(sender, {
              text: `✅ אושר! העסקה שוייכה ל- *${category.name}*.\n` +
                    `יתרה עדכנית: *${category.currentBalance.toLocaleString()} ₪*`
            });
            return;
          }

          if (trimmedText === "לא" || lowerText === "no") {
            await rejectSuggestedCategory(pendingTx.id);
            await sock.sendMessage(sender, {
              text: `הבנתי. לאיזו קטגוריה לשייך את העסקה ב- *${pendingTx.merchant}*?`
            });
            return;
          }
        }

        // --- מקרה ב': עסקה בסטטוס PENDING_CATEGORY (מחכה לשם קטגוריה) ---
        if (pendingTx.status === "PENDING_CATEGORY") {
          try {
            const { category } = await confirmTransaction(pendingTx.id, trimmedText);
            await sock.sendMessage(sender, {
              text: `🎯 שוייך בהצלחה ל- *${category.name}*!\n` +
                    `העסק *${pendingTx.merchant}* נזכר לפעמים הבאות.\n` +
                    `יתרה עדכנית בקטגוריה: *${category.currentBalance.toLocaleString()} ₪*`
            });
            return;
          } catch (err: any) {
            await sock.sendMessage(sender, {
              text: `⚠️ ${err.message}. אנא נסו שוב עם שם קטגוריה תקין.`
            });
            return;
          }
        }
      }

    } catch (error) {
      console.error("❌ שגיאה בעיבוד ההודעה:", error);
    }
  });

  return sock;
}