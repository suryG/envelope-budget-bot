import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

async function runDiagnosis() {
  console.log("🔍 מתחיל דיאגנוסטיקת חיבור מול ישראכארט ומקס...");

  let executablePath: string | undefined;
  try {
    executablePath = await puppeteer.executablePath();
  } catch {
    console.warn("⚠️ לא נמצא נתיב אוטומטי ל-Puppeteer, משתמש בברירת המחדל.");
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--window-size=1920,1080",
      "--disable-blink-features=AutomationControlled",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ],
  });

  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
  });

  const targets = [
    {
      name: "Isracard Login",
      url: "https://digital.isracard.co.il/personalarea/Login/",
      selectorToWait: "input",
    },
    {
      name: "Max Login",
      url: "https://www.max.co.il/login",
      selectorToWait: "#regular-login",
    },
  ];

  for (const target of targets) {
    console.log(`\n🌐 בודק גישה ל: ${target.name} (${target.url})...`);

    try {
      const response = await page.goto(target.url, {
        waitUntil: "networkidle2",
        timeout: 45000,
      });

      const status = response ? response.status() : "No Response";
      console.log(`📡 סטטוס תגובה (HTTP Status): ${status}`);

      const screenshotPath = path.join(process.cwd(), `diag-${target.name.replace(/\s+/g, "_")}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`📸 צילום מסך נשמר ב: ${screenshotPath}`);

      try {
        await page.waitForSelector(target.selectorToWait, { timeout: 10000 });
        console.log(`✅ האלמנט המבוקש '${target.selectorToWait}' נמצא בדף בהצלחה!`);
      } catch {
        console.error(`❌ האלמנט '${target.selectorToWait}' לא נמצא בדף בתוך 10 שניות.`);
      }

      const pageTitle = await page.title();
      console.log(`📄 כותרת הדף שהתקבלה: "${pageTitle}"`);

    } catch (error: any) {
      console.error(`💥 כשל מוחלט בטעינת ${target.name}:`, error.message);
    }
  }

  await browser.close();
  console.log("\n🏁 בדיקת האבחון הסתיימה.");
}

runDiagnosis();