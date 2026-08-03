import "dotenv/config";
import express from "express";
import { startWhatsAppClient } from "./whatsapp/client";
import { runMonthlyRollover } from "./services/rollover";
import { getSocket } from "./whatsapp/client";

const app = express();
const PORT = process.env.PORT || 3000;

// Health check route - this is what cron-job.org (or Uptime Robot)
// should ping every ~10-14 minutes to keep the Render free instance awake.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🌐 שרת health-check פעיל על פורט ${PORT}`);
});

startWhatsAppClient();

// Naive in-process scheduler: checks once an hour whether it's the 1st
// of the month and, if so, runs the rollover once. Good enough for a
// personal project without adding a separate cron dependency.
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
