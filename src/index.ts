import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { startWhatsAppClient, latestQrDataUrl, getSocket } from "./whatsapp/client";
import { runMonthlyRollover } from "./services/rollover";
import { fetchAndProcessTransactions } from "./services/scraper";
import smsWebhookRouter from "./routes/smsWebhook";

// ⏰ תזמון הרצת ה-Scraper בדיוק כל שעתיים
cron.schedule("0 */2 * * *", async () => {
  console.log("⏰ הרצת סקריפר אשראי מתוזמנת (כל שעתיים)...");
  await fetchAndProcessTransactions();
});

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.redirect("/qr");
});
app.use(smsWebhookRouter);


// Health check route - keeps the Render instance awake
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// QR Code route for easy WhatsApp scanning via browser
app.get("/qr", (_req, res) => {
  if (!latestQrDataUrl) {
    return res.send(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;" dir="rtl">
        <h2>אין קוד QR זמין כרגע</h2>
        <p>אם הבוט כבר מחובר, אין צורך לסרוק.</p>
        <p>אם נותקתם, רעננו את הדף בעוד מספר שניות.</p>
      </div>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html dir="rtl">
      <head>
        <title>סריקת קוד QR לוואטסאפ</title>
        <meta http-equiv="refresh" content="15">
        <style>
          body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; background: #f0f2f5; margin: 0; }
          .card { background: white; padding: 28px; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; }
          img { border: 4px solid #00a884; border-radius: 12px; margin-top: 16px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>סריקת קוד QR לחיבור הבוט</h2>
          <p>פתחו את וואטסאפ בטלפון > מכשירים מקושרים > קישור מכשיר</p>
          <img src="${latestQrDataUrl}" alt="WhatsApp QR Code" />
          <p style="color: #666; font-size: 14px; margin-top: 16px;">העמוד מתרענן אוטומטית כל 15 שניות</p>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🌐 שרת health-check פעיל על פורט ${PORT}`);
});

startWhatsAppClient();

// ⏰ תזמון מבוסס Cron: רץ בדיוק ב-1 בחודש בחצות הלילה (00:00)
// בגלל שב-Prisma הגדרת unique constraint על (monthYear, categoryId) ב-MonthlyLog,
// גם אם יתרחש ריסטארט, המסד נתונים מוגן מכפילויות!
cron.schedule("0 0 1 * *", async () => {
  console.log("🔄 מפעיל גלגול חודשי אוטומטי...");
  try {
    const summary = await runMonthlyRollover();
    const groupId = process.env.WHATSAPP_GROUP_ID;
    const sock = getSocket();

    if (sock && groupId) {
      await sock.sendMessage(groupId, { text: summary });
      console.log("✅ הודעת גלגול חודשי נשלחה בהצלחה לוואטסאפ.");
    }
  } catch (error) {
    console.error("❌ שגיאה בביצוע גלגול חודשי:", error);
  }
});