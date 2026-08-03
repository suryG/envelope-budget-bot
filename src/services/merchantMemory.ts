import { prisma, normalizeMerchant } from "../db";

/**
 * Looks up whether we've seen this merchant before and remember
 * which category it was assigned to. This replaces the AI-guess step
 * from the original spec entirely.
 */
export async function lookupMerchant(merchantRaw: string) {
  const merchantName = normalizeMerchant(merchantRaw);
  return prisma.merchantMapping.findUnique({
    where: { merchantName },
    include: { category: true },
  });
}

/**
 * Records (or updates) which category a merchant belongs to.
 * Called whenever a transaction is confirmed, so next time the same
 * merchant appears we can suggest the right category automatically.
 */
export async function rememberMerchant(merchantRaw: string, categoryId: string) {
  const merchantName = normalizeMerchant(merchantRaw);

  const existing = await prisma.merchantMapping.findUnique({
    where: { merchantName },
  });

  if (existing) {
    return prisma.merchantMapping.update({
      where: { merchantName },
      data: {
        categoryId, // overwrite in case the user corrected it
        timesUsed: existing.categoryId === categoryId ? existing.timesUsed + 1 : 1,
        lastUsed: new Date(),
      },
    });
  }

  return prisma.merchantMapping.create({
    data: { merchantName, categoryId, timesUsed: 1 },
  });
}
