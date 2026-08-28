const http = require('node:http');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const pages = await getJson(`${CDP_URL}/json`);
  const page = pages.find((p) => p.type === 'page');
  if (!page) throw new Error('没有找到可调试的页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const consoleErrors = [];
  let nextId = 1;

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.text);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evalJs(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  await send('Runtime.enable');
  await sleep(2500);

  const home = await evalJs(`({
    store: document.querySelector('#storeName').textContent,
    qrReady: document.querySelector('#qrImg').src.startsWith('data:image/png;base64,'),
    visits: document.querySelectorAll('#homeVisits .customer-row').length,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    hasNav: !!document.querySelector('.bottom-nav')
  })`);

  await evalJs(`document.querySelector('#homeVisits .customer-row').click()`);
  await sleep(800);
  const workbench = await evalJs(`({
    visible: !document.querySelector('#workbench').classList.contains('hidden'),
    phone: document.querySelector('#wbPhone').textContent,
    historyRows: document.querySelectorAll('#historyList .order-row').length,
    payDisabled: document.querySelector('#payBtn').disabled
  })`);

  await evalJs(`(() => {
    const input = document.querySelector('#amountInput');
    input.value = '100';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  const calc = await evalJs(`({
    payable: document.querySelector('#payableText').textContent,
    payDisabled: document.querySelector('#payBtn').disabled
  })`);

  await evalJs(`document.querySelector('#payBtn').click()`);
  await sleep(200);
  const payment = await evalJs(`({
    visible: !document.querySelector('#paymentModal').classList.contains('hidden'),
    amount: document.querySelector('#payAmountText').textContent,
    qrSrc: document.querySelector('#payQrImg').src
  })`);
  await evalJs(`document.querySelector('#cancelPayBtn').click()`);
  await evalJs(`document.querySelector('#workbenchBackBtn').click()`);
  await sleep(400);
  await evalJs(`document.querySelector('.nav-btn[data-view="today"]').click()`);
  await sleep(600);
  const today = await evalJs(`({
    active: document.querySelector('#view-today').classList.contains('active'),
    orderRows: document.querySelectorAll('#todayOrders .order-row').length,
    hasStats: document.querySelector('#todayStats').innerText.length > 0
  })`);

  console.log(JSON.stringify({ home, workbench, calc, payment, today, consoleErrors }, null, 2));
  ws.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
