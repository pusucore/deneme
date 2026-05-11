// ============================================================
// PUSULA SPOR - GPT Worker v2
// Düzeltmeler: hata yönetimi, retry, footer/logo sistemi, stabil upload
// ============================================================

const express = require('express');
const { chromium } = require('playwright');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/file', express.static(path.join(__dirname, 'jobs')));

const JOBS_DIR = path.join(__dirname, 'jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

// ── Job store ──────────────────────────────────────────────
const jobs = {};

function createJob() {
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  jobs[jobId] = { status: 'pending', imageUrl: null, error: null, createdAt: Date.now() };
  const dir = path.join(JOBS_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return jobId;
}

// ── Dosya indirme ──────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    protocol.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode} for ${url}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// ── Playwright: Chrome'a bağlan ───────────────────────────
let browserInstance = null;

async function getBrowser() {
  if (browserInstance) {
    try {
      // Bağlantı hâlâ canlı mı?
      await browserInstance.contexts();
      return browserInstance;
    } catch {
      browserInstance = null;
    }
  }
  console.log('[Browser] Chrome remote debug bağlantısı kuruluyor...');
  browserInstance = await chromium.connectOverCDP('http://127.0.0.1:9222');
  console.log('[Browser] Bağlantı başarılı.');
  return browserInstance;
}

// ── ChatGPT ile görsel üret ────────────────────────────────
async function generateWithChatGPT(sourceImagePath, prompt, jobDir) {
  const browser = await getBrowser();
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('[GPT] ChatGPT sayfasına gidiliyor...');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    try {
      const newChatBtn = page.locator('a[href="/"]').first();
      if (await newChatBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await newChatBtn.click();
        await page.waitForTimeout(1500);
      }
    } catch {}

    console.log('[GPT] Görsel yükleniyor...');
    let uploaded = false;

    try {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(sourceImagePath);
      uploaded = true;
      console.log('[GPT] Upload OK: hidden input');
    } catch (e1) {
      console.warn('[GPT] Hidden input başarısız:', e1.message);

      try {
        const attachButton = page.locator(
          'button[aria-label*="Attach"], button[aria-label*="attach"], button[aria-label*="Dosya"], button[aria-label*="Ekle"], button:has-text("+")'
        ).first();

        const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
        await attachButton.click();

        const chooser = await chooserPromise;
        await chooser.setFiles(sourceImagePath);

        uploaded = true;
        console.log('[GPT] Upload OK: filechooser');
      } catch (e2) {
        console.warn('[GPT] Upload tamamen başarısız:', e2.message);
      }
    }

    if (!uploaded) {
      throw new Error('Görsel ChatGPT’ye yüklenemedi.');
    }

    await page.waitForTimeout(5000);

    // KRİTİK: Upload edilmiş/orijinal görsellerin src değerlerini kaydet.
    // Capture sadece bundan sonra oluşan YENİ GPT çıktısını alacak.
    const beforeImageSrcs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img'))
        .map(img => img.src)
        .filter(Boolean);
    });

    console.log('[GPT] Upload sonrası mevcut img sayısı:', beforeImageSrcs.length);

    console.log('[GPT] Prompt gönderiliyor...');

    const finalPrompt = prompt || `
Bu görseli düzenle.

Görev:
- Görseldeki tüm "DE MARKE", "DE MARKE SPORTS", watermark, logo, footer ve marka izlerini tamamen kaldır.
- Bu alanları arka planla doğal şekilde doldur.
- Oyuncuları, kişileri, stadyumu, kompozisyonu, ışığı, renkleri ve kaliteyi koru.
- Görsele yeni yazı, yeni logo, yeni watermark veya yeni footer ekleme.
- PUSULA SPOR yazısı üretme.
- Sadece De Marke marka izlerini temizle.

Sonuç doğal, gerçekçi, yüksek kaliteli ve profesyonel görünmeli.
`;

    const inputSelector = 'div.ProseMirror, div[contenteditable="true"], div#prompt-textarea, #prompt-textarea, textarea';
    await page.waitForSelector(inputSelector, { timeout: 60000, state: 'attached' });

    let promptWritten = false;

    try {
      const editor = page.locator('div.ProseMirror, div[contenteditable="true"], div#prompt-textarea, #prompt-textarea').first();
      if (await editor.count()) {
        await editor.click({ timeout: 10000 }).catch(() => {});
      }

      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: 'https://chatgpt.com',
      }).catch(() => {});

      await page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
      }, finalPrompt);

      await page.keyboard.press('Control+V');
      await page.waitForTimeout(1500);

      const currentText = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll(
          'div.ProseMirror, div[contenteditable="true"], div#prompt-textarea, #prompt-textarea, textarea'
        ));

        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };

        const el = candidates.find(isVisible) || candidates[0];
        return (el && (el.innerText || el.value || el.textContent)) || '';
      });

      if (currentText && currentText.length > 30) {
        promptWritten = true;
        console.log('[GPT] Prompt OK: clipboard');
      }
    } catch (e) {
      console.warn('[GPT] Clipboard prompt başarısız:', e.message);
    }

    if (!promptWritten) {
      await page.evaluate((promptText) => {
        const candidates = Array.from(document.querySelectorAll(
          'div.ProseMirror, div[contenteditable="true"], div#prompt-textarea, #prompt-textarea, textarea'
        ));

        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };

        const el =
          candidates.find((x) => isVisible(x) && x.tagName !== 'TEXTAREA') ||
          candidates.find(isVisible) ||
          candidates[0];

        if (!el) throw new Error('Prompt input bulunamadı');

        el.focus();

        if (el.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, promptText);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.innerHTML = '';
          const p = document.createElement('p');
          p.textContent = promptText;
          el.appendChild(p);

          el.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            inputType: 'insertText',
            data: promptText,
          }));

          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: promptText,
          }));

          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, finalPrompt);

      await page.waitForTimeout(1500);
      console.log('[GPT] Prompt OK: DOM');
    }

    let sent = false;
    const sendSelectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="Gönder"]'
    ];

    for (const selector of sendSelectors) {
      const btn = page.locator(selector).last();

      if (await btn.count()) {
        const disabled = await btn.getAttribute('disabled').catch(() => null);
        if (disabled === null) {
          await btn.click();
          sent = true;
          console.log('[GPT] Send OK:', selector);
          break;
        }
      }
    }

    if (!sent) {
      await page.keyboard.press('Enter');
      console.log('[GPT] Send fallback: Enter');
    }

    console.log('[GPT] YENİ çıktı görseli bekleniyor...');
    const rawPath = path.join(jobDir, 'raw.png');
    const beforeSet = new Set(beforeImageSrcs);

    for (let attempt = 0; attempt < 60; attempt++) {
      await page.waitForTimeout(5000);

      const isGenerating = await page.locator('[data-testid="stop-button"], .result-streaming').isVisible().catch(() => false);
      if (isGenerating) {
        console.log(`[GPT] Üretim devam ediyor... ${attempt + 1}/60`);
        continue;
      }

      const imgs = page.locator('img');
      const count = await imgs.count();
      const candidates = [];

      for (let i = 0; i < count; i++) {
        const img = imgs.nth(i);
        const src = await img.getAttribute('src').catch(() => null);
        const box = await img.boundingBox().catch(() => null);

        if (!src || !box) continue;

        // YÜKLENEN DE MARKE'Lİ ORİJİNALİ ASLA ALMA
        if (beforeSet.has(src)) continue;

        if (box.width < 300 || box.height < 220) continue;

        const low = src.toLowerCase();
        if (low.includes('avatar')) continue;
        if (low.includes('favicon')) continue;
        if (low.includes('logo')) continue;

        candidates.push({
          index: i,
          src,
          area: box.width * box.height,
          width: box.width,
          height: box.height
        });
      }

      console.log(`[GPT] Tarama ${attempt + 1}/60: img=${count}, yeni büyük aday=${candidates.length}`);

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.area - a.area);
        const best = candidates[0];
        const bestImg = imgs.nth(best.index);

        console.log(`[GPT] YENİ çıktı bulundu: ${Math.round(best.width)}x${Math.round(best.height)} src=${best.src.slice(0, 100)}`);

        try {
          const buffer = await page.evaluate(async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('fetch failed ' + res.status);
            const ab = await res.arrayBuffer();
            return Array.from(new Uint8Array(ab));
          }, best.src);

          fs.writeFileSync(rawPath, Buffer.from(buffer));

          const stat = fs.statSync(rawPath);
          if (stat.size > 20000) {
            console.log('[GPT] Ham görsel fetch ile indirildi:', rawPath);
            return rawPath;
          }
        } catch (e) {
          console.warn('[GPT] Fetch olmadı, img screenshot deneniyor:', e.message);
        }

        try {
          await bestImg.screenshot({ path: rawPath });

          const stat = fs.statSync(rawPath);
          if (stat.size > 20000) {
            console.log('[GPT] Ham görsel img screenshot ile alındı:', rawPath);
            return rawPath;
          }
        } catch (e) {
          console.warn('[GPT] img screenshot başarısız:', e.message);
        }
      }

      try {
        const downloadBtn = page
          .locator('button[aria-label*="Download"], button[aria-label*="İndir"], [data-testid*="download"]')
          .last();

        if (await downloadBtn.count()) {
          const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
          await downloadBtn.click();
          const download = await downloadPromise;
          await download.saveAs(rawPath);

          const stat = fs.statSync(rawPath);
          if (stat.size > 20000) {
            console.log('[GPT] Ham görsel download ile indirildi:', rawPath);
            return rawPath;
          }
        }
      } catch {}

      console.log(`[GPT] Yeni çıktı henüz bulunamadı... ${attempt + 1}/60`);
    }

    throw new Error('ChatGPT yeni çıktı görseli bulunamadı.');

  } finally {
    await page.close();
  }
}

// ── Sharp: Sadece sol-alt logo (şeritsiz, sade) ──────────
async function addFooterAndLogo(rawImagePath, logoPath, title, outputPath) {
  console.log('[Sharp] Logo ekleniyor (şeritsiz, sol-alt)...');

  const mainImage = sharp(rawImagePath);
  const meta = await mainImage.metadata();
  const W = meta.width || 1200;
  const H = meta.height || 675;

  // Logo yüksekliği: görselin %13'ü
  const LOGO_H = Math.round(H * 0.05);
  const PADDING = Math.round(W * 0.025);

  const composites = [];

  if (logoPath && fs.existsSync(logoPath)) {
    const logoBuffer = await sharp(logoPath)
      .resize({ height: LOGO_H, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const logoMeta = await sharp(logoBuffer).metadata();
    const LOGO_W = logoMeta.width || LOGO_H;

    const left = PADDING;
    const top  = H - LOGO_H - PADDING;

    // Logoyu okunabilir kılan hafif karartma hâlesi
    const shadowW = LOGO_W + PADDING * 2;
    const shadowH = LOGO_H + PADDING * 2;
    const shadowSvg = `<svg width="${shadowW}" height="${shadowH}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="s" cx="30%" cy="70%" r="60%">
          <stop offset="0%" stop-color="#000" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <ellipse cx="${shadowW / 2}" cy="${shadowH / 2}"
        rx="${shadowW / 2}" ry="${shadowH / 2}" fill="url(#s)"/>
    </svg>`;

    composites.push({
      input: Buffer.from(shadowSvg),
      top: Math.max(0, top - PADDING),
      left: Math.max(0, left - PADDING)
    });

    composites.push({ input: logoBuffer, top, left });
  }

  await mainImage
    .composite(composites)
    .png()
    .toFile(outputPath);

  console.log('[Sharp] Final görsel (logo-only):', outputPath);
}

// ── Ana işlem fonksiyonu ───────────────────────────────────
async function processJob(jobId, { title, sourceImageUrl, prompt, logoUrl }) {
  const jobDir = path.join(JOBS_DIR, jobId);

  try {
    jobs[jobId].status = 'processing';

    // 1. Kaynak görseli indir
    const sourceImagePath = path.join(jobDir, 'source.jpg');
    console.log(`[Job ${jobId}] Kaynak görsel indiriliyor: ${sourceImageUrl}`);
    await downloadFile(sourceImageUrl, sourceImagePath);

    // 2. Logo indir (local asset veya URL)
    let logoPath = null;
    const localLogo = path.join(__dirname, 'assets', 'pusula-logo.png');
    if (fs.existsSync(localLogo)) {
      logoPath = localLogo;
    } else if (logoUrl && logoUrl.startsWith('http')) {
      logoPath = path.join(jobDir, 'logo.png');
      await downloadFile(logoUrl, logoPath).catch(() => { logoPath = null; });
    }

    // 3. ChatGPT ile görsel üret
    const rawImagePath = await generateWithChatGPT(sourceImagePath, prompt, jobDir);

    // 4. Footer + Logo ekle
    const finalPath = path.join(jobDir, 'final.png');
    await addFooterAndLogo(rawImagePath, logoPath, title, finalPath);

    // 5. Job tamamlandı
    jobs[jobId].status = 'done';
    jobs[jobId].imageUrl = `http://127.0.0.1:3000/file/${jobId}/final.png`;
    console.log(`[Job ${jobId}] ✅ Tamamlandı: ${jobs[jobId].imageUrl}`);

  } catch (err) {
    console.error(`[Job ${jobId}] ❌ Hata:`, err.message);
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
  }
}

// ── API Endpointleri ──────────────────────────────────────

// Görsel oluştur
app.post('/create-image', async (req, res) => {
  const { title, sourceImageUrl, prompt, logoUrl } = req.body;

  if (!sourceImageUrl) {
    return res.status(400).json({ error: 'sourceImageUrl zorunlu' });
  }

  const jobId = createJob();
  console.log(`[API] Yeni job oluşturuldu: ${jobId}`);

  // Async işlem başlat (beklemeden dön)
  processJob(jobId, { title, sourceImageUrl, prompt, logoUrl });

  res.json({ jobId, status: 'pending' });
});

// Sonuç kontrol
app.get('/result/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job bulunamadı' });
  res.json({
    jobId: req.params.jobId,
    status: job.status,
    imageUrl: job.imageUrl,
    error: job.error
  });
});

// Footer ekle (direkt görsel - GPT'siz)
app.post('/add-footer', async (req, res) => {
  const { title, sourceImageUrl, logoUrl } = req.body;

  if (!sourceImageUrl) {
    return res.status(400).json({ error: 'sourceImageUrl zorunlu' });
  }

  const jobId = createJob();
  console.log(`[API] Footer job oluşturuldu: ${jobId}`);

  // Async işlem
  (async () => {
    const jobDir = path.join(JOBS_DIR, jobId);
    try {
      jobs[jobId].status = 'processing';

      // Görseli indir
      const sourcePath = path.join(jobDir, 'source.jpg');
      await downloadFile(sourceImageUrl, sourcePath);

      // Logo yolu
      let logoPath = path.join(__dirname, 'assets', 'pusula-logo.png');
      if (!fs.existsSync(logoPath)) logoPath = null;

      // ── GPT ile De Marke temizle ───────────────────────
      let cleanPath = sourcePath;
      try {
        console.log(`[Footer ${jobId}] GPT ile De Marke temizleniyor...`);
        const prompt = 'Bu görselde "De Marke" veya "DE MARKE" yazısı, logosu veya watermarkı var. Sadece bu logoyu/yazıyı tamamen kaldır, yerine arka planla uyumlu temiz görüntü koy. Başka hiçbir şeyi değiştirme.';
        cleanPath = await generateWithChatGPT(sourcePath, prompt, jobDir);
        console.log(`[Footer ${jobId}] GPT temizleme tamamlandı: ${cleanPath}`);
      } catch (gptErr) {
        console.warn(`[Footer ${jobId}] GPT başarısız, orijinal kullanılıyor:`, gptErr.message);
        cleanPath = sourcePath;
      }

      // Pusula logosu ekle
      const finalPath = path.join(jobDir, 'final.png');
      await addFooterAndLogo(cleanPath, logoPath, title || '', finalPath);

      jobs[jobId].status = 'done';
      jobs[jobId].imageUrl = `http://127.0.0.1:3000/file/${jobId}/final.png`;
      console.log(`[Footer Job ${jobId}] ✅ Tamamlandı`);
    } catch (err) {
      console.error(`[Footer Job ${jobId}] ❌`, err.message);
      jobs[jobId].status = 'error';
      jobs[jobId].error = err.message;
    }
  })();

  // GPT işlemi uzun sürer - hemen jobId dön, n8n /result/:jobId ile poll eder
  res.json({ jobId, status: 'pending' });
});

app.get('/latest-demarke', async (req, res) => {
  try {
    const browser = await getBrowser();
    const contexts = browser.contexts();
    const context = contexts[0] || await browser.newContext();

    const page = await context.newPage();

    await page.goto('https://x.com/demarkesports', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.waitForTimeout(5000);

    const tweet = await page.evaluate(() => {
      const article = document.querySelector('article');

      if (!article) return null;

      const text =
        article.innerText || '';

      const tweetLink =
        article.querySelector('a[href*="/status/"]')?.href || '';

      const tweetId =
        tweetLink.split('/status/')[1]?.split('?')[0];

      const image =
        article.querySelector('img[src*="pbs.twimg.com/media"]');

      const video =
        article.querySelector('video');

      return {
        tweetId,
        text,
        imageUrl: image?.src || null,
        isVideo: !!video,
        link: tweetLink,
      };
    });

    await page.close();

    res.json(tweet || {});
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: e.message,
    });
  }
});

// Sağlık kontrolü
app.get('/health', (req, res) => {
  const activeJobs = Object.values(jobs).filter(j => j.status === 'processing').length;
  res.json({ status: 'ok', activeJobs, totalJobs: Object.keys(jobs).length });
});

// ── Başlat ─────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 PUSULA SPOR Worker çalışıyor: http://127.0.0.1:${PORT}`);
  console.log('📁 Jobs dizini:', JOBS_DIR);
  console.log('🎨 Assets dizini:', path.join(__dirname, 'assets'));
  console.log('\nEndpointler:');
  console.log('  POST /create-image  → Yeni job başlat');
  console.log('  GET  /result/:jobId → Job durumu');
  console.log('  GET  /health        → Sağlık kontrolü\n');
});
