import { PrismaClient } from "@prisma/client";

// A single shared Prisma client for the whole app.
export const prisma = new PrismaClient();

// Normalizes a merchant name so "Super-Pharm", "SUPER PHARM ", and
// "super pharm" are all treated as the same merchant for memory lookups.
export function normalizeMerchant(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
