import { createScraper, CompanyTypes } from "israeli-bank-scrapers";
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { decrypt } from "./crypto";
import { registerNewCharge } from "./transactionService";
import { sendTransactionNotification } from "../whatsapp/client";

const prisma = new PrismaClient();

/**
 * מזהה נתיב לדפדפן Chrome או Edge במחשב המקומי (Windows).
 */
function getLocalChromePath(): string | undefined {
  if (process.platform !== "win32") return undefined;

  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

  if (fs.existsSync(chromePath)) return chromePath;
  if (fs.existsSync(edgePath)) return edgePath;

  return undefined;
}

/**
 * מפה שממירה בין שמות החברות ב-DB לסוג החברה ב-israeli-bank-scrapers
 */
export const COMPANY_MAP: Record<string, CompanyTypes> = {
  max: CompanyTypes.max,
  isracard: CompanyTypes.isracard,
  visaCal: CompanyTypes.visaCal,
  hapoalim: CompanyTypes.hapoalim,
  leumi: CompanyTypes.leumi,
  discount: CompanyTypes.discount,
  mizrahi: CompanyTypes.mizrahi,
  yahav: CompanyTypes.yahav,
  pagi: CompanyTypes.pagi,
};

/**
 * מביא את רשימת הכרטיסים המוצפנים מה-DB ומפענח אותם לשימוש בסקריפר
 */
async function getTargetAccountsFromDB() {
  const savedCards = await prisma.creditCard.findMany({
    where: { isActive: true },
  });

  return savedCards.map((card) => {
    const card6Digits = card.card6Digits ? decrypt(card.card6Digits) : undefined;
    return {
      name: card.name,
      companyId: COMPANY_MAP[card.company],
      credentials: {
        username: decrypt(card.username),
        password: decrypt(card.password),
        ...(card6Digits ? { card6Digits } : {}),
      },
    };
  });
}

/**
 * מריץ סריקה על כל החשבונות והכרטיסים הרשומים ב-DB ומעבד את העסקאות
 */
export async function fetchAndProcessTransactions() {
  console.log("🔍 מתחיל משיכת עסקאות מכל הכרטיסים ב-DB...");

  const targetAccounts = await getTargetAccountsFromDB();
  if (targetAccounts.length === 0) {
    console.log("ℹ️ לא נרשמו כרטיסי אשראי פעילים במסד הנתונים.");
    return;
  }

  const executablePath = getLocalChromePath();
  const targetJid = process.env.WHATSAPP_GROUP_ID;

  if (!targetJid) {
    console.error("⚠️ WHATSAPP_GROUP_ID אינו מוגדר ב-.env");
    return;
  }

  // מעבר בלולאה על כל כרטיס מוגדר
  for (const accountConfig of targetAccounts) {
    console.log(`💳 סורק את: ${accountConfig.name}...`);

    const options = {
      companyId: accountConfig.companyId,
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 שעות אחרונות
      showBrowser: false,
      executablePath,
    };

    try {
      const scraper = createScraper(options);
      const result = await scraper.scrape(accountConfig.credentials);

      if (!result.success) {
        console.error(`❌ שגיאה בסריקת ${accountConfig.name} [${result.errorType}]:`, result.errorMessage);
        continue; // ממשיך לכרטיס הבא במידה ונכשל
      }

      const accounts = result.accounts || [];

      for (const account of accounts) {
        for (const tx of account.txns) {
          if (tx.status === "pending") continue;

          const merchant = tx.description;
          const amount = Math.abs(tx.chargedAmount);

          // 1. רישום העסקה במערכת (כולל סינון הוראות קבע)
          const chargeResult = await registerNewCharge(merchant, amount, tx);

          // 2. שליחת התראה לוואטסאפ במידה והעסקה נוצרה ב-DB
          if (chargeResult) {
            await sendTransactionNotification(targetJid, {
              id: chargeResult.transactionId,
              merchant,
              amount,
              suggestedCategoryName: chargeResult.suggestedCategoryName,
              status: chargeResult.status,
            });
          }
        }
      }

      console.log(`✅ סיום בהצלחה עבור ${accountConfig.name}.`);
    } catch (error) {
      console.error(`❌ שגיאה בלתי צפויה בסריקת ${accountConfig.name}:`, error);
    }
  }

  console.log("🏁 סיום סריקת כל הכרטיסים.");
}