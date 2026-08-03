import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { getStatusMessage, getOverBudgetMessage } from "../commands/status";
import { handleEditCommand } from "../commands/edit";
import { confirmTransaction, getLatestPendingTransaction } from "../services/transactionService";

let sock: WASocket | null = null;

// Session credentials are saved to disk so the bot doesn't need a new
// QR scan every time it restarts (e.g. after Render wakes back up).
const AUTH_FOLDER = "auth_info_baileys";

export async function startWhatsAppClient() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({ auth: state });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("סרקו את קוד ה-QR הבא עם וואטסאפ (Linked Devices):");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("החיבור נסגר. מתחבר מחדש?", shouldReconnect);
      if (shouldReconnect) {
        startWhatsAppClient();
      } else {
        console.log("נותקת (loggedOut) - יש למחוק את תיקיית auth_info_baileys ולסרוק QR מחדש.");
      }
    } else if (connection === "open") {
      console.log("✅ מחובר לוואטסאפ");
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

  // Otherwise, treat the message as a reply naming a category for the
  // most recent pending transaction (confirmation or correction flow).
  const pending = await getLatestPendingTransaction();
  if (pending) {
    try {
      const { category } = await confirmTransaction(pending.id, text);
      return `✅ שוייך ל-${category.name}. 📊 יתרה מעודכנת: ${category.currentBalance.toLocaleString()} ₪ / ${category.monthlyBudget.toLocaleString()} ₪`;
    } catch {
      // Not a recognized category name - ignore silently, could just be chit-chat.
      return null;
    }
  }

  return null;
}

export function getSocket() {
  return sock;
}
