import { prisma } from "../db";

/** "יתרות" / "!status" - shows all envelopes and their balances. */
export async function getStatusMessage(): Promise<string> {
  const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
  if (categories.length === 0) return "עדיין אין קטגוריות מוגדרות. השתמשו ב'ערוך חדש <שם> <תקציב>' כדי להוסיף אחת.";

  const lines = categories.map(
    (c) => `${c.currentBalance < 0 ? "🔴" : "💰"} ${c.name}: ${c.currentBalance.toLocaleString()} ₪`
  );
  return `📊 יתרות נוכחיות:\n${lines.join("\n")}`;
}

/** "חריגות" - shows only categories at 0 or negative. */
export async function getOverBudgetMessage(): Promise<string> {
  const categories = await prisma.category.findMany({
    where: { currentBalance: { lte: 0 } },
    orderBy: { currentBalance: "asc" },
  });
  if (categories.length === 0) return "✅ אין חריגות כרגע - כל הקטגוריות בתקציב.";

  const lines = categories.map((c) => `🔴 ${c.name}: ${c.currentBalance.toLocaleString()} ₪`);
  return `⚠️ קטגוריות בחריגה:\n${lines.join("\n")}`;
}
