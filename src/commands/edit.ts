import { prisma } from "../db";
import { confirmTransaction } from "../services/transactionService";

/**
 * Parses and executes "ערוך" commands. Expected forms:
 *   ערוך <קטגוריה קיימת> <תקציב חדש>       -> update monthly budget
 *   ערוך חדש <שם קטגוריה> <תקציב>          -> create a new category
 *   שנה עסקה <מזהה עסקה> <קטגוריה>         -> reassign a past transaction
 *
 * Returns the reply text to send back to the group.
 */
export async function handleEditCommand(text: string): Promise<string> {
  const parts = text.trim().split(/\s+/);

  // ערוך חדש <שם> <תקציב>
  if (parts[0] === "ערוך" && parts[1] === "חדש") {
    const budget = Number(parts[parts.length - 1]);
    const name = parts.slice(2, -1).join(" ");
    if (!name || Number.isNaN(budget)) {
      return "פורמט לא תקין. דוגמה: ערוך חדש בילויים 2000";
    }
    const category = await prisma.category.create({
      data: { name, monthlyBudget: budget, currentBalance: budget },
    });
    return `✅ נוצרה קטגוריה חדשה "${category.name}" עם תקציב חודשי של ${budget.toLocaleString()} ₪`;
  }

  // ערוך <קטגוריה קיימת> <תקציב חדש>
  if (parts[0] === "ערוך") {
    const budget = Number(parts[parts.length - 1]);
    const name = parts.slice(1, -1).join(" ");
    const category = await prisma.category.findUnique({ where: { name } });
    if (!category) return `לא מצאתי קטגוריה בשם "${name}"`;
    if (Number.isNaN(budget)) return "פורמט לא תקין. דוגמה: ערוך בילויים 2500";

    await prisma.category.update({
      where: { id: category.id },
      data: { monthlyBudget: budget },
    });
    return `✅ תקציב "${name}" עודכן ל-${budget.toLocaleString()} ₪ לחודש`;
  }

  // שנה עסקה <מזהה> <קטגוריה חדשה>
  if (parts[0] === "שנה" && parts[1] === "עסקה") {
    const transactionId = parts[2];
    const categoryName = parts.slice(3).join(" ");
    try {
      const { category } = await confirmTransaction(transactionId, categoryName);
      return `✅ העסקה שויכה מחדש ל-"${category.name}". יתרה מעודכנת: ${category.currentBalance.toLocaleString()} ₪`;
    } catch (err) {
      return `שגיאה: ${(err as Error).message}`;
    }
  }

  return "פקודה לא מוכרת. אפשרויות: 'ערוך <קטגוריה> <תקציב>', 'ערוך חדש <שם> <תקציב>', 'שנה עסקה <מזהה> <קטגוריה>'";
}
