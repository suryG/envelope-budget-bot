import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { getStatusMessage, getOverBudgetMessage } from "../commands/status";
import { handleEditCommand } from "../commands/edit";
import { confirmTransaction, getLatestPendingTransaction } from "../services/transactionService";

let sock: WASocket | null = null;
const AUTH_FOLDER = "auth_info_baileys";

export async function startWhatsAppClient() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  // Fetch latest official WA version
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📱 Baileys version: v${version.join('.')}, isLatest: ${isLatest}`);

  sock = makeWASocket({ 
    auth: state,
    version,
    printQRInTerminal: true,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n==========================================");
      console.log("סרקו את קוד ה-QR הבא עם וואטסאפ (Linked Devices):");
      console.log("==========================================\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("החיבור נסגר. קוד שגיאה:", statusCode, "| מתחבר מחדש?", shouldReconnect);
      
      if (shouldReconnect) {
        startWhatsAppClient();
      } else {
        console.log("נותקת (loggedOut) - מנקה את תיקיית האימות...");
        if (fs.existsSync(AUTH_FOLDER)) {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        }
        startWhatsAppClient();
      }
    } else if (connection === "open") {
      console.log("✅ מחובר בהצלחה לוואטסאפ!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const groupId = process.env.WHATSAPP_GROUP_ID;
      if (groupId && msg.key.remoteJid !== groupId) continue;

      const text =
        msg.message.conversation ?? msg.message.extendedTextMessage?.text ?? "";
      if (!text) continue;

      const reply = await handleIncomingText(text.trim());
      if (reply) {
        await sock!.sendMessage(msg.key.remoteJid!, { text: reply });
      }
    }
  });

  return sock;
}

async function handleIncomingText(text: string): Promise<string | null> {
  if (text === "יתרות" || text === "!status") return getStatusMessage();
  if (text === "חריגות") return getOverBudgetMessage();
  if (text.startsWith("ערוך") || text.startsWith("שנה עסקה")) return handleEditCommand(text);

  const pending = await getLatestPendingTransaction();
  if (pending) {
    try {
      const { category } = await confirmTransaction(pending.id, text);
      return `✅ שוייך ל-${category.name}. 📊 יתרה מעודכנת: ${category.currentBalance.toLocaleString()} ₪ / ${category.monthlyBudget.toLocaleString()} ₪`;
    } catch {
      return null;
    }
  }

  return null;
}

export function getSocket() {
  return sock;
}