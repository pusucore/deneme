const { chromium } = require("playwright");

(async () => {

  const browser = await chromium.launchPersistentContext(
    "./chatgpt-profile",
    {
      headless: false,
      viewport: {
        width: 1440,
        height: 900
      }
    }
  );

  const page = await browser.newPage();

  await page.goto("https://chatgpt.com", {
    waitUntil: "domcontentloaded"
  });

  console.log("ChatGPT login page opened.");
  console.log("Login manually and keep browser open.");

})();
