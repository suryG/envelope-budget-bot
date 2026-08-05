import { PrismaClient } from "@prisma/client";
import { encrypt } from "../services/crypto";
import { COMPANY_MAP } from "../services/scraper";

const prisma = new PrismaClient();

interface WizardState {
  step: "COMPANY" | "NAME" | "USERNAME" | "PASSWORD" | "CARD_6_DIGITS";
  company?: string;
  name?: string;
  username?: string;
  password?: string;
}

// זיכרון זמני לניהול ה-Flow לפי מזהה משתמש (JID)
const activeSessions = new Map<string, WizardState>();

/**
 * בודק אם המשתמש נמצא כרגע בתהליך הוספת כרטיס
 */
export function isUserInWizard(userJid: string): boolean {
  return activeSessions.has(userJid);
}

/**
 * התחלת התהליך
 */
export async function startCardWizard(sock: any, userJid: string) {
  activeSessions.set(userJid, { step: "COMPANY" });

  const message = 
`💳 *הוספת כרטיס אשראי חדש*

אנא בחר/י את חברת האשראי מהרשימה (השב עם המספר המתאים):
1. MAX (מאקס)
2. Isracard (ישראכרט / אמריקן אקספרס / פועלים)
3. VisaCal (כאל)
4. Hapoalim (חשבון בנק פועלים)
5. Leumi (בנק לאומי)
6. Discount (בנק דיסקונט)
7. Mizrahi (בנק מזרחי טפחות)

_(תוכל לרשום 'ביטול' בכל שלב לביטול התהליך)_`;

  await sock.sendMessage(userJid, { text: message });
}

/**
 * עיבוד התשובות של המשתמש לאורך הדיאלוג
 */
export async function handleWizardStep(sock: any, userJid: string, text: string) {
  const session = activeSessions.get(userJid);
  if (!session) return;

  const trimmedText = text.trim();

  // 🟢 מניעת לופים קריטית: התעלמות מהודעות שהבוט בעצמו הרגע שלח
  if (
    trimmedText.startsWith("👌") ||
    trimmedText.startsWith("👤") ||
    trimmedText.startsWith("🔑") ||
    trimmedText.startsWith("💳") ||
    trimmedText.startsWith("⚠️") ||
    trimmedText.startsWith("❌") ||
    trimmedText.includes("אנא בחר/י מספר מהרשימה") ||
    trimmedText.includes("איך תרצה/י לקרוא לכרטיס") ||
    trimmedText.includes("הזן/י את שם המשתמש") ||
    trimmedText.includes("הזן/י את סיסמת ההתחברות") ||
    trimmedText.includes("6 הספרות האחרונות")
  ) {
    return; // זו הודעה של הבוט, לא תשובה מהמשתמש!
  }

  if (trimmedText === "ביטול") {
    activeSessions.delete(userJid);
    await sock.sendMessage(userJid, { text: "❌ תהליך הוספת הכרטיס בוטל." });
    return;
  }

  switch (session.step) {
    case "COMPANY": {
      const companies = ["max", "isracard", "visaCal", "hapoalim", "leumi", "discount", "mizrahi"];
      const index = parseInt(trimmedText) - 1;

      if (isNaN(index) || index < 0 || index >= companies.length) {
        await sock.sendMessage(userJid, { text: "⚠️ בחירה לא תקינה. אנא בחר/י מספר מהרשימה (1-7)." });
        return;
      }

      session.company = companies[index];
      session.step = "NAME";
      await sock.sendMessage(userJid, { text: "👌 מעולה. איך תרצה/י לקרוא לכרטיס הזה? (למשל: 'כרטיס הוצאות הבית')" });
      break;
    }

    case "NAME": {
      session.name = trimmedText;
      session.step = "USERNAME";
      await sock.sendMessage(userJid, { text: "👤 הזן/י את שם המשתמש / תעודת הזהות להתחברות:" });
      break;
    }

    case "USERNAME": {
      session.username = trimmedText;
      session.step = "PASSWORD";
      await sock.sendMessage(userJid, { text: "🔑 הזן/י את סיסמת ההתחברות:" });
      break;
    }

    case "PASSWORD": {
      session.password = trimmedText;

      // אם מדובר בישראכרט / כאל, נבקש 6 ספרות אחרונות
      if (session.company === "isracard" || session.company === "visaCal") {
        session.step = "CARD_6_DIGITS";
        await sock.sendMessage(userJid, { text: "💳 הזן/י את 6 הספרות האחרונות של כרטיס האשראי:" });
      } else {
        await saveCardAndFinish(sock, userJid, session);
      }
      break;
    }

    case "CARD_6_DIGITS": {
      await saveCardAndFinish(sock, userJid, session, trimmedText);
      break;
    }
  }
}
/**
 * הצפנת הנתונים ושמירתם ל-DB בסיום הדיאלוג
 */
async function saveCardAndFinish(sock: any, userJid: string, session: WizardState, card6Digits?: string) {
  try {
    await prisma.creditCard.create({
      data: {
        name: session.name!,
        company: session.company!,
        username: encrypt(session.username!),
        password: encrypt(session.password!),
        card6Digits: card6Digits ? encrypt(card6Digits) : null,
      },
    });

    activeSessions.delete(userJid);

    await sock.sendMessage(userJid, {
      text: `🔒 *הכרטיס "${session.name}" נשמר בהצלחה במערכת!*\nהפרטים הוצפנו בבטחה (AES-256). הבוט יכלול כרטיס זה בסריקה הקרובה.`,
    });
  } catch (error) {
    console.error("שגיאה בשמירת הכרטיס:", error);
    activeSessions.delete(userJid);
    await sock.sendMessage(userJid, { text: "❌ אירעה שגיאה בשמירת הכרטיס במערכת. אנא נסה שוב מאוחר יותר." });
  }
}