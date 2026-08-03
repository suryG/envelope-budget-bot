import { prisma } from "../db";

/**
 * Runs on the 1st of each month. New balance = monthly budget +
 * whatever was left over from the previous month.
 */
export async function runMonthlyRollover(): Promise<string> {
  const now = new Date();
  const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const categories = await prisma.category.findMany();
  const summaryLines: string[] = [];

  for (const category of categories) {
    const rolloverAmount = category.currentBalance;
    const startingBalance = category.monthlyBudget + rolloverAmount;

    await prisma.$transaction([
      prisma.category.update({
        where: { id: category.id },
        data: { currentBalance: startingBalance },
      }),
      prisma.monthlyLog.upsert({
        where: { monthYear_categoryId: { monthYear, categoryId: category.id } },
        create: { monthYear, categoryId: category.id, rolloverAmount, startingBalance },
        update: { rolloverAmount, startingBalance },
      }),
    ]);

    summaryLines.push(
      `• ${category.name}: ${startingBalance.toLocaleString()} ₪ (כולל גלגול של ${rolloverAmount.toLocaleString()} ₪)`
    );
  }

  return `📅 סיכום גלגול חודשי (${monthYear}):\n${summaryLines.join("\n")}`;
}
