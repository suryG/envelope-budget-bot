import { prisma } from "../db";
import { lookupMerchant, rememberMerchant } from "./merchantMemory";

interface NewChargeResult {
  transactionId: string;
  suggestedCategoryName: string | null;
  status: "PENDING_CONFIRMATION" | "PENDING_CATEGORY";
}

/**
 * Handles an incoming charge (from manual entry today, from a bank
 * feed later). Looks up merchant history and creates a transaction
 * in the right pending state. Does NOT touch any balance yet -
 * balances only change once the user confirms or picks a category.
 */
export async function registerNewCharge(
  merchant: string,
  amount: number
): Promise<NewChargeResult> {
  const mapping = await lookupMerchant(merchant);

  const transaction = await prisma.transaction.create({
    data: {
      merchant,
      amount,
      categoryId: mapping?.categoryId ?? null,
      status: mapping ? "PENDING_CONFIRMATION" : "PENDING_CATEGORY",
    },
  });

  return {
    transactionId: transaction.id,
    suggestedCategoryName: mapping?.category.name ?? null,
    status: mapping ? "PENDING_CONFIRMATION" : "PENDING_CATEGORY",
  };
}

/**
 * Confirms (or corrects) a pending transaction into a final category.
 * Updates the category balance and teaches the merchant-memory table.
 */
export async function confirmTransaction(transactionId: string, categoryName: string) {
  const category = await prisma.category.findUnique({ where: { name: categoryName } });
  if (!category) {
    throw new Error(`קטגוריה "${categoryName}" לא קיימת`);
  }

  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new Error("עסקה לא נמצאה");

  await prisma.$transaction([
    prisma.transaction.update({
      where: { id: transactionId },
      data: { categoryId: category.id, status: "CONFIRMED" },
    }),
    prisma.category.update({
      where: { id: category.id },
      data: { currentBalance: { decrement: transaction.amount } },
    }),
  ]);

  await rememberMerchant(transaction.merchant, category.id);

  const updated = await prisma.category.findUnique({ where: { id: category.id } });
  return { category: updated!, transaction };
}

/** Returns the most recent still-pending transaction, so a bare-word
 * reply like "קניות לבית" in the group knows which charge it refers to. */
export async function getLatestPendingTransaction() {
  return prisma.transaction.findFirst({
    where: { status: { in: ["PENDING_CATEGORY", "PENDING_CONFIRMATION"] } },
    orderBy: { createdAt: "desc" },
  });
}
