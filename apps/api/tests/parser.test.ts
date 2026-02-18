import { describe, it, expect } from 'vitest';
import { parseMarkdownTasks, computeFingerprint } from '../src/parser.js';

// ─── Real content from VirtoSoftware file ─────────────────────
const VS_CONTENT = `---
tags:
  - vs
---
- [ ] MS Case - EU Commission - track
- [ ] MS Case - Letter to lawyers - see typingmind research
- [ ] faq Calendar - ss
\t    - настройки для браузеров
- [ ] VS DB - plan and share for Alisa
- [ ] Alert app for Admins - simple notifications - AL
- [ ] Marketing plan with Olga and Kri - till 1st June. How to measure
- [ ] Marketing VS - Reddit, Quora - KS
 - [ ] Privacy and other docs - monitor task for KS - to plan

- [ ] https://sam.gov/ 🔺 - delayed because of the passports
- [ ] [Your support request 2510150040002749 has been created. A support advocate will contact you during our](https://learn.microsoft.com/partner-center/support/support-hours) [support business hours](https://learn.microsoft.com/partner-center/support/support-hours) at the **email address you provided** in your request. - virtoway.com tenant
- [ ] Alerts - M365 Assessment Tool - check if its's suitable for alerts
- [ ] Calendar Time Zones visualisation - like Outlook
- [ ] Calendar Zoom + Google
- [ ] Onprem Calendar
- [ ] AD apps to release - data?
- [ ] Online Upload app - date?
- [ ] India's Employee - research
- [ ] SharePoint Companies List - ideas?

- [ ] Lost Deals - email and contact - [Lost Deals 2024-2025.xlsx](https://virtosoftware370.sharepoint.com/:x:/s/demo-Alisascalendar/EYxvh5wPZXRGm07-pTCU4XUBndw7CKFkJiyU4yY_aA6PyA?e=FRQb6V)

- [ ] Docs Page for Admins - template and what to put on it ⏫
- [ ] Built summ https://transloadit.com/devtips/hashing-files-with-curl-a-developer-s-guide/?utm_source=chatgpt.com

- [ ] List of Subscriptions to Check
- [ ] VirtoOne Page License - add more description

- [ ] One Major Update for Every on-premises component
- [ ] Pittsburgh Case - Alisa control - AK?
- [ ] VirtoSoftware Shared Calendar - permissions - AL

General plan for Onpremises web parts - https://virtosoftware370-my.sharepoint.com/:w:/r/personal/s_virtosoftware_com/_layouts/15/Doc.aspx

##### New NCAGE Request Success!

**NCAGE kodu 0273R.**

Your request REF LT25265466625 has been pre-recorded and a VALIDATION Email transmitted to your mailbox.

https://eportal.nspa.nato.int/vendorregistration/private/registration - in progress ![[Screenshot 2025-09-25 at 11.27.15.png]]`;

// ─── Real content from Private file ──────────────────────────
const PRIVATE_CONTENT = `---
tags:
  - bank
  - car/bmw
  - contacts
  - finance/expense
  - personal
  - receipt
  - spain

---

https://app.houdiniswap.com/order-details?houdiniId=q3dEQEn38q65BWw3TBheuN

- [x] BMW color - ordered ➕ 2025-10-15  https://www.ebay.es/ItemNotReceived/5368990195?itemId=192476173508&transactionId=10076089921204
\t
- [ ] Oleg расчет
- [ ] VC Case - date of answer 🔺
- [ ] Agreement with a new Director - check amil and ask Anna for support
- [ ] Singvest shares to answer??? Check email🔺
- [ ] VP debt - personal + VS - date to pay?
- [ ] Invest VP - see details and talk to Solo, Sobol and Olga
- [ ] Cache забрать у Юли Аликанте - среда? `;

// ─── Real content from Cervantes file (duplicate frontmatter) ─
const CERVANTES_CONTENT = `---
type: general
tags: property/cervantes
---

---
tags:
  - property
  - property/cervantes
  - spain

- [ ] Вода - труба для дренажа
- [ ] Доводчик

- [x] Подкраска - кухня, офис, гест рум, спальня
\t
- [ ] Led barbacoa 25 1 sm depth 1 sm wide
- [ ] электрика - схема на участке, дом, барбакоа
- [ ] электрика - схема на шкаф
- [ ] Вода план/схема

- [ ] Электрика барбакоа - проверить

- [ ] Замена автоматизации полива - https://www.hunterirrigation.com/en-metric/irrigation-product/controllers/node-bt - отправлен запрос в испанскую компанию https://riegopro.com/

`;

// ─── Real content from VP file ───────────────────────────────
const VP_CONTENT = `
- [ ] Analysis https://8080-i8n2bgxmipjtxgnkrg37t-bef15db2.us2.manus.computer/`;

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('parseMarkdownTasks', () => {
  describe('VirtoSoftware file', () => {
    const tasks = parseMarkdownTasks(VS_CONTENT);

    it('parses all tasks (skipping frontmatter, headings, paragraphs)', () => {
      expect(tasks.length).toBe(26);
    });

    it('parses simple unchecked task', () => {
      expect(tasks[0].title).toBe('MS Case - EU Commission - track');
      expect(tasks[0].isDone).toBe(false);
      expect(tasks[0].priority).toBeNull();
      expect(tasks[0].lineNumber).toBe(5);
    });

    it('captures sub-items for faq Calendar task', () => {
      const faqTask = tasks.find((t) => t.title.startsWith('faq Calendar'));
      expect(faqTask).toBeDefined();
      expect(faqTask!.subItems).toHaveLength(1);
      expect(faqTask!.subItems[0]).toBe('- настройки для браузеров');
    });

    it('recognizes task with leading space as separate task', () => {
      const privacyTask = tasks.find((t) => t.title.startsWith('Privacy and other docs'));
      expect(privacyTask).toBeDefined();
      expect(privacyTask!.isDone).toBe(false);
    });

    it('extracts urgent priority from 🔺 emoji', () => {
      const samTask = tasks.find((t) => t.title.includes('sam.gov'));
      expect(samTask).toBeDefined();
      expect(samTask!.priority).toBe('urgent');
    });

    it('extracts high priority from ⏫ emoji', () => {
      const docsTask = tasks.find((t) => t.title.includes('Docs Page for Admins'));
      expect(docsTask).toBeDefined();
      expect(docsTask!.priority).toBe('high');
    });

    it('extracts markdown link URLs', () => {
      const supportTask = tasks.find((t) => t.title.includes('support request'));
      expect(supportTask).toBeDefined();
      expect(supportTask!.urls).toContain('https://learn.microsoft.com/partner-center/support/support-hours');
    });

    it('extracts bare URLs', () => {
      const samTask = tasks.find((t) => t.title.includes('sam.gov'));
      expect(samTask).toBeDefined();
      expect(samTask!.urls).toContain('https://sam.gov/');
    });

    it('extracts sharepoint link from Lost Deals task', () => {
      const lostDeals = tasks.find((t) => t.title.includes('Lost Deals'));
      expect(lostDeals).toBeDefined();
      expect(lostDeals!.urls.length).toBeGreaterThanOrEqual(1);
      expect(lostDeals!.urls[0]).toContain('sharepoint.com');
    });

    it('extracts bare URL from Built summ task', () => {
      const builtTask = tasks.find((t) => t.title.includes('Built summ'));
      expect(builtTask).toBeDefined();
      expect(builtTask!.urls).toContain(
        'https://transloadit.com/devtips/hashing-files-with-curl-a-developer-s-guide/?utm_source=chatgpt.com',
      );
    });

    it('skips non-task content (headings, paragraphs, bare URLs, images)', () => {
      // None of these should be parsed as tasks:
      // - "General plan for Onpremises..."
      // - "##### New NCAGE Request Success!"
      // - "**NCAGE kodu 0273R.**"
      // - bare URL lines
      // - image embeds
      const titles = tasks.map((t) => t.title);
      expect(titles.some((t) => t.includes('NCAGE'))).toBe(false);
      expect(titles.some((t) => t.includes('General plan'))).toBe(false);
      expect(titles.some((t) => t.includes('VALIDATION'))).toBe(false);
      expect(titles.some((t) => t.includes('eportal.nspa'))).toBe(false);
    });

    it('all tasks are not done', () => {
      expect(tasks.every((t) => !t.isDone)).toBe(true);
    });
  });

  describe('Private file', () => {
    const tasks = parseMarkdownTasks(PRIVATE_CONTENT);

    it('parses all 8 tasks', () => {
      expect(tasks.length).toBe(8);
    });

    it('detects done task (BMW color)', () => {
      expect(tasks[0].title).toContain('BMW color');
      expect(tasks[0].isDone).toBe(true);
    });

    it('extracts URLs from done task with inline links', () => {
      expect(tasks[0].urls.length).toBeGreaterThanOrEqual(1);
      expect(tasks[0].urls[0]).toContain('ebay.es');
    });

    it('skips bare URL line (houdiniswap) before tasks', () => {
      const titles = tasks.map((t) => t.title);
      expect(titles.some((t) => t.includes('houdiniswap'))).toBe(false);
    });

    it('does not capture tab-only line as sub-item', () => {
      // After BMW task there's a line with just a tab
      expect(tasks[0].subItems).toHaveLength(0);
    });

    it('detects urgent priority in VC Case', () => {
      const vcTask = tasks.find((t) => t.title.includes('VC Case'));
      expect(vcTask).toBeDefined();
      expect(vcTask!.priority).toBe('urgent');
    });

    it('detects urgent priority when emoji is adjacent to text (no space)', () => {
      // "Singvest shares to answer??? Check email🔺"
      const singvest = tasks.find((t) => t.title.includes('Singvest'));
      expect(singvest).toBeDefined();
      expect(singvest!.priority).toBe('urgent');
    });

    it('handles mixed language tasks', () => {
      const olegTask = tasks.find((t) => t.title.includes('Oleg'));
      expect(olegTask).toBeDefined();
      expect(olegTask!.title).toContain('расчет');
    });
  });

  describe('Cervantes file (duplicate frontmatter)', () => {
    const tasks = parseMarkdownTasks(CERVANTES_CONTENT);

    it('parses all 9 tasks despite duplicate frontmatter blocks', () => {
      expect(tasks.length).toBe(9);
    });

    it('first task is Вода', () => {
      expect(tasks[0].title).toContain('Вода');
      expect(tasks[0].isDone).toBe(false);
    });

    it('detects done task (Подкраска)', () => {
      const doneTask = tasks.find((t) => t.title.includes('Подкраска'));
      expect(doneTask).toBeDefined();
      expect(doneTask!.isDone).toBe(true);
    });

    it('extracts multiple bare URLs from Замена автоматизации task', () => {
      const irrigationTask = tasks.find((t) => t.title.includes('Замена автоматизации'));
      expect(irrigationTask).toBeDefined();
      expect(irrigationTask!.urls.length).toBe(2);
      expect(irrigationTask!.urls).toContain(
        'https://www.hunterirrigation.com/en-metric/irrigation-product/controllers/node-bt',
      );
      expect(irrigationTask!.urls).toContain('https://riegopro.com/');
    });

    it('does not include YAML list items as tasks or sub-items', () => {
      const titles = tasks.map((t) => t.title);
      expect(titles.some((t) => t === 'property')).toBe(false);
      expect(titles.some((t) => t === 'spain')).toBe(false);
    });
  });

  describe('VP file (no frontmatter, minimal)', () => {
    const tasks = parseMarkdownTasks(VP_CONTENT);

    it('parses single task', () => {
      expect(tasks.length).toBe(1);
    });

    it('extracts URL from task title', () => {
      expect(tasks[0].title).toContain('Analysis');
      expect(tasks[0].urls.length).toBe(1);
      expect(tasks[0].urls[0]).toContain('manus.computer');
    });

    it('has no priority', () => {
      expect(tasks[0].priority).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles empty content', () => {
      expect(parseMarkdownTasks('')).toEqual([]);
    });

    it('handles content with only frontmatter', () => {
      const content = `---\ntags:\n  - test\n---\n`;
      expect(parseMarkdownTasks(content)).toEqual([]);
    });

    it('handles content with only non-task lines', () => {
      const content = `# Heading\n\nSome paragraph.\n\nhttps://example.com\n`;
      expect(parseMarkdownTasks(content)).toEqual([]);
    });

    it('handles task immediately after frontmatter with no blank line', () => {
      const content = `---\ntags: test\n---\n- [ ] First task`;
      const tasks = parseMarkdownTasks(content);
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('First task');
    });

    it('handles [X] (uppercase) as done', () => {
      const content = `- [X] Done with uppercase X`;
      const tasks = parseMarkdownTasks(content);
      expect(tasks.length).toBe(1);
      expect(tasks[0].isDone).toBe(true);
    });

    it('handles multiple sub-items', () => {
      const content = `- [ ] Parent task\n\t- sub 1\n\t- sub 2\n\t- sub 3`;
      const tasks = parseMarkdownTasks(content);
      expect(tasks.length).toBe(1);
      expect(tasks[0].subItems).toEqual(['- sub 1', '- sub 2', '- sub 3']);
    });

    it('handles tasks interleaved with paragraphs', () => {
      const content = `- [ ] Task A\n\nSome paragraph\n\n- [ ] Task B\n\nAnother paragraph`;
      const tasks = parseMarkdownTasks(content);
      expect(tasks.length).toBe(2);
      expect(tasks[0].title).toBe('Task A');
      expect(tasks[1].title).toBe('Task B');
    });

    it('preserves correct line numbers', () => {
      const content = `---\ntags: x\n---\n\n\n- [ ] Task on line 6`;
      const tasks = parseMarkdownTasks(content);
      expect(tasks.length).toBe(1);
      expect(tasks[0].lineNumber).toBe(6);
    });

    it('does not match YAML list items as tasks', () => {
      const content = `---\ntags:\n  - property\n  - spain\n---\n- [ ] Real task`;
      const tasks = parseMarkdownTasks(content);
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Real task');
    });
  });
});

describe('computeFingerprint', () => {
  it('returns 8-char hex string', () => {
    const fp = computeFingerprint('some task', 'board1', 0);
    expect(fp).toMatch(/^[a-f0-9]{8}$/);
  });

  it('same input produces same fingerprint', () => {
    const a = computeFingerprint('Task Title', 'vs', 3);
    const b = computeFingerprint('Task Title', 'vs', 3);
    expect(a).toBe(b);
  });

  it('different occurrence index produces different fingerprint', () => {
    const a = computeFingerprint('Same Title', 'vs', 0);
    const b = computeFingerprint('Same Title', 'vs', 1);
    expect(a).not.toBe(b);
  });

  it('different board produces different fingerprint', () => {
    const a = computeFingerprint('Same Title', 'vs', 0);
    const b = computeFingerprint('Same Title', 'private', 0);
    expect(a).not.toBe(b);
  });

  it('normalizes whitespace and case', () => {
    const a = computeFingerprint('  Task  Title  ', 'vs', 0);
    const b = computeFingerprint('task title', 'vs', 0);
    expect(a).toBe(b);
  });
});
