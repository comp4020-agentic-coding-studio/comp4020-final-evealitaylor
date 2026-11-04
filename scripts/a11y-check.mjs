// Accessibility scan with axe-core at both marking viewports, in each state a
// marker reaches: the map, a desk sheet open (signed out), and the sign-up
// dialog. Fails on any "serious" or "critical" violation; lists the rest.
// See CLAUDE.md "Holds up under bad conditions".
//
//   pnpm a11y-check [APP_URL]   # app must be running
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = await import("playwright-core");

const BASE = process.argv[2] ?? process.env.APP_URL ?? "http://localhost:8080";
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const VIEWS = {
  desktop: { viewport: { width: 1920, height: 1080 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};

async function scan(page, label) {
  await page.addScriptTag({ content: AXE });
  const { violations } = await page.evaluate(() =>
    window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }),
  );
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log(`${label}: ${violations.length} issue(s), ${bad.length} serious/critical`);
  for (const v of violations) {
    console.log(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}x)`);
    for (const n of v.nodes.slice(0, 2)) console.log(`      ${n.target.join(" ")}`);
  }
  return bad.length;
}

const browser = await chromium.launch();
let failures = 0;
for (const [name, opts] of Object.entries(VIEWS)) {
  const page = await (await browser.newContext(opts)).newPage();
  await page.goto(BASE);
  await page.waitForSelector("#conn.conn--live");
  failures += await scan(page, `${name} map`);

  await page.locator(".seat.seat--available").first().click();
  await page.waitForSelector(".sheet.open");
  await page.waitForTimeout(300);
  failures += await scan(page, `${name} desk sheet`);

  await page.click('[data-action="signin"]');
  await page.click('[data-acct="tab-signup"]');
  await page.click(".privacy summary");
  failures += await scan(page, `${name} signup dialog`);
}
await browser.close();
console.log(failures === 0 ? "✓ no serious or critical accessibility issues" : `✗ ${failures} serious/critical`);
process.exit(failures === 0 ? 0 : 1);
