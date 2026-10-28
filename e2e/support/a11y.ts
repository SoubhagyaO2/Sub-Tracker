import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

export interface AxeSummary {
  id: string;
  impact: string | null | undefined;
  help: string;
  targets: string[];
}

/** Runs axe-core in the real page, INCLUDING colour contrast (the browser has real layout and styles). */
export async function runAxe(page: Page): Promise<AxeSummary[]> {
  if (!(await page.evaluate(() => 'axe' in window))) {
    // The app's Content-Security-Policy forbids inline scripts, so axe is served as a same-origin file (not injected inline).
    await page.route('**/__axe.js', (route) => route.fulfill({ path: AXE_PATH, contentType: 'application/javascript' }));
    await page.addScriptTag({ url: '/__axe.js' });
  }
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const results = await axe.run(document.body, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: { region: { enabled: false } } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 5).map((n: any) => n.target.join(' ')) }));
  });
}

export interface LayoutReport {
  scrollWidth: number;
  clientWidth: number;
  /** Visible elements that extend past the viewport and are not inside a deliberately scrollable region. */
  escaping: string[];
  /** Interactive controls smaller than the WCAG 2.2 minimum target size (24 x 24 CSS px). */
  tooSmall: string[];
}

export async function layoutReport(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const describe = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String((e as HTMLElement).className).slice(0, 60)} "${(e.textContent ?? '').trim().slice(0, 30)}"`;
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !(r.width <= 1 && r.height <= 1);
    };
    const inScroller = (e: Element) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
      }
      return false;
    };
    const escaping: string[] = [];
    const tooSmall: string[] = [];
    for (const e of document.querySelectorAll('body *')) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      if ((r.right > vw + 1 || r.left < -1) && getComputedStyle(e).position !== 'fixed' && !inScroller(e)) escaping.push(`${describe(e)} left=${Math.round(r.left)} right=${Math.round(r.right)}`);
      if (e.matches('button, select, input:not([type=hidden]):not([type=radio]):not([type=checkbox]), [role=button]') && (r.width < 24 || r.height < 24)) tooSmall.push(`${describe(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: vw, escaping: escaping.slice(0, 8), tooSmall: tooSmall.slice(0, 8) };
  });
}
