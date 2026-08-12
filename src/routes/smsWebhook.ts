import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { registerNewCharge, confirmTransaction } from "../services/transactionService";
import { waitForUserCategorySelection } from "../whatsapp/client";

const router = Router();
const prisma = new PrismaClient();

export interface ParsedSms {
  merchant: string;
  amount: number;
  company?: string;
}

/**
 * מפענח טקסט בבטחה מבלי להפיל את השרת אם הטקסט כבר מפוענח ומכיל תווים כמו %
 */
function safeDecodeSms(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // כבר מפוענח או מכיל תווים שלא ניתנים לפיענוח URL - נחזיר כמו שהוא
  }
}

/**
 * מנתח טקסט הודעות SMS של חברות אשראי בישראל (ישראכרט, מקס, כאל)
 */
export function parseCreditSms(text: string): ParsedSms | null {
  if (!text || typeof text !== "string") return null;

  const cleanText = text.replace(/\s+/g, " ").trim();

  // 1. חילוץ הסכום (תומך ב: 150 ₪, 150.00 ש"ח, 1,250.50 שח וכו')
  const amountRegex = /(?:בסך|על סך|סכום של|סכום)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:₪|ש"?ח|שח|ILS)/i;
  const fallbackAmountRegex = /([\d,]+(?:\.\d{1,2})?)\s*(?:₪|ש"?ח|שח|ILS)/i;

  const amountMatch = cleanText.match(amountRegex) || cleanText.match(fallbackAmountRegex);
  if (!amountMatch) return null;

  // המרה למספר תקין (הסרת פסיקים של אלפים)
  const rawAmountStr = amountMatch[1].replace(/,/g, "");
  const amount = parseFloat(rawAmountStr);

  if (isNaN(amount) || amount <= 0) return null;

  // 2. חילוץ שם בית העסק
  let merchant = "";

  // תבנית א': "ב-שופרסל", "בבית העסק שופרסל", "אצל רמי לוי"
  const merchantMatchA = cleanText.match(/(?:בבית\s*העסק|בבית-העסק|ב-|אצל)\s*([^\n,.₪]+?)(?=\s+(?:בתאריך|בסך|בכרטיס|ע"ס|מסתיים|בתשלומים|מיום|$))/i);
  
  // תבנית ב': "עסקה ב שופרסל", "חיוב ב רמי לוי"
  const merchantMatchB = cleanText.match(/(?:עסקה|חיוב)\s+(?:ב-|ב|אצל)\s*([^\n,.₪]+?)(?=\s+(?:בתאריך|בסך|בכרטיס|ע"ס|מסתיים|בתשלומים|מיום|$))/i);

  if (merchantMatchA && merchantMatchA[1].trim()) {
    merchant = merchantMatchA[1].trim();
  } else if (merchantMatchB && merchantMatchB[1].trim()) {
    merchant = merchantMatchB[1].trim();
  } else {
    merchant = "בית עסק לא זוהה (יש לקבוע קטגוריה)";
  }

  // ניקוי מילים מיותרות שעלולות להילכד בשם העסק
  merchant = merchant.replace(/^בית העסק\s*/i, "").trim();

  return {
    merchant,
    amount,
  };
}

// 📡 ה-Endpoint הראשי לקבלת הודעות ה-SMS מ-MacroDroid
router.post("/api/sms-webhook", async (req: Request, res: Response) => {
  try {
    // תמיכה גם ב-Query Parameters וגם ב-Body
    const secret = (req.query.secret || req.body?.secret) as string;
    const rawSms = (req.query.sms || req.body?.sms || req.body?.sms_message) as string;

    // 🔒 בדיקת אבטחה
    if (!secret || secret !== process.env.SMS_WEBHOOK_SECRET) {
      console.warn("🔒 ניסיון גישה לא מורשה ל-SMS Webhook");
      return res.status(401).json({ error: "unauthorized" });
    }

    if (!rawSms) {
      return res.status(400).json({ error: "missing sms content" });
    }

    // 🛡️ פענוח בטוח של ה-SMS מנעת URIError
    const smsText = safeDecodeSms(String(rawSms));
    console.log("📩 התקבל SMS חדש בשרת:", smsText);

    // ניתוח ה-SMS
    const parsed = parseCreditSms(smsText);

    if (!parsed) {
      console.warn("⚠️ לא הצלחנו לחלץ סכום/עסק מה-SMS. ניסוח ההודעה לא נתמך עדיין ב-Regex:");
      console.warn(`--> "${smsText}"`);
      return res.status(200).json({ 
        received: true, 
        parsed: false, 
        message: "SMS received but could not be parsed automatically" 
      });
    }

    const { merchant, amount } = parsed;
    console.log(`✅ SMS חולץ בהצלחה! עסק: "${merchant}", סכום: ${amount} ₪`);

    // יצירת אובייקט עסקה מדומה לשימוש ב-transactionService
    const fakeTx = {
      description: merchant,
      chargedAmount: amount,
      date: new Date(),
      status: "completed",
      identifier: `sms-${Date.now()}`,
    };

    // 1. רישום החיוב במערכת (בדיקת תקציב/מעטפה + הצעת קטגוריה)
    const chargeResult = await registerNewCharge(merchant, amount, fakeTx as any);

    if (chargeResult) {
      // 2. שליחת הודעת וואטסאפ למשתמש לבחירת קטגוריה
      const allCategories = await prisma.category.findMany({ select: { name: true } });
      const categoryNames = allCategories.map((c) => c.name);
      const targetJid = process.env.WHATSAPP_GROUP_ID!;

      const chosenCategory = await waitForUserCategorySelection(
        targetJid,
        merchant,
        amount,
        chargeResult.suggestedCategoryName,
        categoryNames
      );

      // 3. אישור העסקה ושמירה סופית
      await confirmTransaction(chargeResult.transactionId, chosenCategory);
    }

    return res.status(200).json({ 
      received: true, 
      parsed: true, 
      merchant, 
      amount 
    });

  } catch (error: any) {
    console.error("❌ שגיאה בלתי צפויה ב-SMS Webhook:", error);
    return res.status(500).json({ error: "internal server error" });
  }
});

export default router;