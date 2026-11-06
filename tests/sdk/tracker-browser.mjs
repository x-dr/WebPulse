import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

export async function startTrackerBrowser(options) {
  let virtualDisplay;
  try {
    if (options.xvfb) virtualDisplay = await startVirtualDisplay();
    const headed = options.headed || options.xvfb;
    const browser = await chromium.launch({
      headless: !headed,
      ...(virtualDisplay ? { env: { ...process.env, DISPLAY: virtualDisplay.display } } : {}),
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    return {
      browser,
      headed,
      async close() {
        try {
          await browser.close();
        } finally {
          await virtualDisplay?.stop();
        }
      },
    };
  } catch (error) {
    await virtualDisplay?.stop();
    throw error;
  }
}

export async function openTrackerPage(runtime, options) {
  const { endpoint, origin, siteId, mock } = options;
  const context = await runtime.browser.newContext();
  try {
    if (
      !mock &&
      new URL(origin).protocol === 'https:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)
    ) {
      await context.grantPermissions(['local-network-access'], { origin });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const requests = [];
    const records = new Map();
    const errors = [];
    const configPath = `/api/v1/tracker-config/${siteId}`;
    const paths = new Set(['/tracker.js', configPath, '/api/v1/collect', '/api/v1/heartbeat']);
    page.on('pageerror', () => errors.push('页面脚本异常'));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== endpoint || !paths.has(url.pathname)) return;
      const record = {
        path: url.pathname,
        body: request.method() === 'POST' ? request.postDataJSON() : undefined,
      };
      requests.push(record);
      records.set(request, record);
    });
    page.on('response', (response) => {
      const record = records.get(response.request());
      if (record) record.status = response.status();
    });
    page.on('requestfailed', (request) => {
      const record = records.get(request);
      if (record) record.failed = true;
    });
    await page.addInitScript(() => {
      globalThis.webpulseStorageAccess = [];
      for (const method of ['getItem', 'setItem', 'removeItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...args) {
          if (String(key).startsWith('webpulse:')) globalThis.webpulseStorageAccess.push(method);
          return original.call(this, key, ...args);
        };
      }
    });
    // Only the generated test document is supplied here; live SDK/API requests pass through.
    await page.route(`${origin}/__webpulse_test__/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>WebPulse 访问测试</title><button id="interact">测试真实点击</button>
<script defer src="${endpoint}/tracker.js" data-site-id="${siteId}" data-consent="required"></script>
<script>window.webpulseQueue = window.webpulseQueue || [];</script></html>`,
      }),
    );
    if (mock) {
      const bundle = await readFile(
        new URL('../../packages/tracker/dist/tracker.js', import.meta.url),
      );
      const { defaultRules } = await import('../../packages/shared/dist/index.js');
      await page.route(`${endpoint}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/tracker.js')
          return route.fulfill({ contentType: 'application/javascript', body: bundle });
        const headers = { 'access-control-allow-origin': origin };
        if (path === configPath)
          return route.fulfill({
            headers,
            json: {
              data: {
                rules: { ...defaultRules, exclude_bots: false, ...options.mockRules },
                rule_version: 1,
              },
            },
          });
        if (path === '/api/v1/collect' || path === '/api/v1/heartbeat')
          return route.fulfill({ status: 204, headers });
        return route.abort();
      });
    }
    await page.goto(
      `${origin}${options.initialPath}`,
      options.referrer ? { referer: options.referrer } : {},
    );
    await page.waitForFunction(() => Boolean(globalThis.webpulse));
    return {
      page,
      context,
      requests,
      errors,
      async grant() {
        const [response] = await Promise.all([
          page.waitForResponse((item) => item.url() === `${endpoint}${configPath}`),
          page.evaluate(() => globalThis.webpulse.consent(true)),
        ]);
        assert.equal(response.status(), 200, '配置请求失败：检查站点 ID、启用状态及 Origin 白名单');
        const { data } = await response.json();
        if (!runtime.headed && data.rules.exclude_bots)
          throw new Error('站点启用了机器人过滤；无桌面请使用 --xvfb，有桌面请使用 --headed');
        return data.rules;
      },
      events(type) {
        const events = requests
          .filter((request) => request.path === '/api/v1/collect' && request.status === 204)
          .flatMap((request) => request.body.events ?? [])
          .filter((event) => event.type === type);
        return [...new Map(events.map((event) => [event.event_id, event])).values()];
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export const waitFor = (check, message) => expect.poll(check, { timeout: 20_000, message });

async function startVirtualDisplay() {
  const child = spawn(
    'Xvfb',
    ['-displayfd', '3', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    },
  );
  const closed = new Promise((resolve) => child.once('close', resolve));
  const kill = () => child.kill('SIGTERM');
  process.once('exit', kill);
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) kill();
    await closed;
    process.removeListener('exit', kill);
  }
  try {
    const display = await new Promise((resolve, reject) => {
      const fail = (message) => {
        clearTimeout(timeout);
        reject(new Error(message));
      };
      const timeout = setTimeout(() => fail('Xvfb 启动超时'), 5000);
      child.once('error', () =>
        fail('无法启动 Xvfb；Debian/Ubuntu 可运行 apt-get install -y xvfb'),
      );
      child.once('exit', (code) => fail(`Xvfb 提前退出（${code}）`));
      let output = '';
      child.stdio[3].on('data', (chunk) => {
        output += chunk.toString();
        const match = /^(\d+)\n/.exec(output);
        if (!match) return;
        clearTimeout(timeout);
        resolve(`:${match[1]}`);
      });
    });
    console.log(`已启动 Xvfb 虚拟显示 ${display}，无需桌面环境`);
    return { display, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
