-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING_CONFIRMATION', 'PENDING_CATEGORY', 'CONFIRMED');

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthly_budget" DOUBLE PRECISION NOT NULL,
    "current_balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "merchant" TEXT NOT NULL,
    "category_id" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING_CATEGORY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_mappings" (
    "id" TEXT NOT NULL,
    "merchant_name" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "times_used" INTEGER NOT NULL DEFAULT 1,
    "last_used" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_logs" (
    "id" TEXT NOT NULL,
    "month_year" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "rollover_amount" DOUBLE PRECISION NOT NULL,
    "starting_balance" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "monthly_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_mappings_merchant_name_key" ON "merchant_mappings"("merchant_name");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_logs_month_year_category_id_key" ON "monthly_logs"("month_year", "category_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_mappings" ADD CONSTRAINT "merchant_mappings_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_logs" ADD CONSTRAINT "monthly_logs_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
