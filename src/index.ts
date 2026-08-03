import "dotenv/config";
import express from "express";
import { startWhatsAppClient, latestQrDataUrl, getSocket } from "./whatsapp/client";
import { runMonthlyRollover } from "./services/rollover";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.redirect("/qr");
});

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

// Naive in-process scheduler: checks once an hour whether it's the 1st
// of the month and, if so, runs the rollover once.
let rolloverRanThisMonth = false;
setInterval(async () => {
  const now = new Date();
  if (now.getDate() === 1) {
    if (!rolloverRanThisMonth) {
      rolloverRanThisMonth = true;
      const summary = await runMonthlyRollover();
      const groupId = process.env.WHATSAPP_GROUP_ID;
      const sock = getSocket();
      if (sock && groupId) {
        await sock.sendMessage(groupId, { text: summary });
      }
    }
  } else {
    rolloverRanThisMonth = false;
  }
}, 60 * 60 * 1000);