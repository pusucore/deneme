const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launchPersistentContext("./chatgpt-profile", {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 900 }
  });

  const page = await browser.newPage();
  await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded" });

  console.log("Chrome açıldı. ChatGPT’ye manuel giriş yap.");
})();
