import { createScraper, CompanyTypes } from "israeli-bank-scrapers";
import fs from "fs";
import puppeteer from "puppeteer"; // 👈 ייבוא puppeteer לקבלת הנתיב האוטומטי
import { PrismaClient } from "@prisma/client";
import { decrypt } from "./crypto";
import { registerNewCharge } from "./transactionService";
import { sendTransactionNotification } from "../whatsapp/client";

const prisma = new PrismaClient();

/**
 * מזהה נתיב לדפדפן Chrome:
 * 1. ב-Windows: מחפש בנתיבי המחשב המקומי.
 * 2. ב-Linux (Render): משתמש בנתיב הדינמי של Puppeteer!
 */
async function getExecutablePath(): Promise<string | undefined> {
  if (process.platform === "win32") {
    const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    if (fs.existsSync(chromePath)) return chromePath;
    if (fs.existsSync(edgePath)) return edgePath;
    return undefined;
  }

  try {
    // 🟢 הוספת await פותרת את שגיאת ה-TypeScript!
    return await puppeteer.executablePath();
  } catch (e) {
    console.warn("⚠️ לא ניתן היה לזהות את נתיב Puppeteer האוטומטי:", e);
    return undefined;
  }
}

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

export async function fetchAndProcessTransactions() {
  console.log("🔍 מתחיל משיכת עסקאות מכל הכרטיסים ב-DB...");

  const targetAccounts = await getTargetAccountsFromDB();
  if (targetAccounts.length === 0) {
    console.log("ℹ️ לא נרשמו כרטיסי אשראי פעילים במסד הנתונים.");
    return;
  }

  const executablePath =await getExecutablePath();
  const targetJid = process.env.WHATSAPP_GROUP_ID;

  if (!targetJid) {
    console.error("⚠️ WHATSAPP_GROUP_ID אינו מוגדר ב-.env");
    return;
  }

  for (const accountConfig of targetAccounts) {
    console.log(`💳 סורק את: ${accountConfig.name}...`);

    const options = {
      companyId: accountConfig.companyId,
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      showBrowser: false,
      ...(executablePath ? { executablePath } : {}),
      // 🟢 הגדרות קריטיות להרצת Chrome בסביבת Linux / Render
      browserOptions: {
        args: [
          "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--disable-gpu",
        ],
      },
    };

    try {
      const scraper = createScraper(options as any);
      const result = await scraper.scrape(accountConfig.credentials);

      if (!result.success) {
        console.error(`❌ שגיאה בסריקת ${accountConfig.name} [${result.errorType}]:`, result.errorMessage);
        continue;
      }

      const accounts = result.accounts || [];

      for (const account of accounts) {
        for (const tx of account.txns) {
          if (tx.status === "pending") continue;

          const merchant = tx.description;
          const amount = Math.abs(tx.chargedAmount);

          const chargeResult = await registerNewCharge(merchant, amount, tx);

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