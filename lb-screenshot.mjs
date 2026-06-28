import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.setItem('torble_welcome_seen', 'true');
  localStorage.setItem('torble_welcomed', 'true');
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const lbBtn = await page.$('.lb-trigger');
if (lbBtn) {
  await lbBtn.click();
  await page.waitForSelector('.lb-modal', { timeout: 5000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/lb-xp.png' });
  console.log('XP screenshot taken');
  const goldBtn = await page.$('.lb-type-btn--gold');
  if (goldBtn) {
    await goldBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/lb-gold.png' });
    console.log('Gold screenshot taken');
  }
} else {
  await page.screenshot({ path: '/tmp/lb-page.png' });
  console.log('lb-trigger not found - page screenshot taken');
}
await browser.close();
