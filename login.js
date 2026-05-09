const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");

  const context = browser.contexts()[0];
  const page = await context.newPage();

  await page.goto("https://chatgpt.com", {
    waitUntil: "domcontentloaded"
  });

  console.log("Connected to real Chrome over CDP.");
})();
