const $ = (sel) => document.querySelector(sel);

const state = {
  currentCustomer: null,
  referrer: null,
  amountCents: 0,
  pointsUsed: 0,
  qrType: 'wechat',
  voidOrderId: null,
  toastTimer: null
};

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function fmtYuan(cents) {
  return (cents / 100).toFixed(2);
}

function maskPhone(phone) {
  if (phone.length >= 11) return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  return phone;
}

function showToast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

function setView(view) {
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
  $(`#view-${view}`).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  if (view === 'home') loadHome();
  if (view === 'today') loadToday();
}

function badgeFor(customer) {
  return customer.isNew
    ? '<span class="badge badge-new">新客</span>'
    : '<span class="badge badge-old">老客</span>';
}

function renderVisitList(container, visits) {
  if (!visits.length) {
    container.innerHTML = '<div class="empty-tip">今天还没有客人扫码登记</div>';
    return;
  }
  container.innerHTML = visits.map((visit) => {
    const c = visit.customer;
    const time = visit.scannedAt ? visit.scannedAt.slice(11) : '';
    return `
      <button class="customer-row" data-customer-id="${c.id}">
        <div class="row-main">
          <div class="row-title">${c.phone} ${badgeFor(c)}</div>
          <div class="row-sub">${time} · 可用 ${c.available} 积分</div>
        </div>
      </button>
    `;
  }).join('');
  container.querySelectorAll('[data-customer-id]').forEach((btn) => {
    btn.addEventListener('click', () => openCustomer(Number(btn.dataset.customerId)));
  });
}

async function loadHome() {
  try {
    const [settings, today, qr] = await Promise.all([api('/api/settings'), api('/api/today'), api('/api/qr')]);
    $('#storeName').textContent = settings.storeName;
    $('#todayLabel').textContent = `${today.date} · 今日已登记 ${today.visits.length} 位客人`;
    $('#qrImg').src = qr.dataUrl;
    $('#qrUrl').textContent = qr.url;
    renderVisitList($('#homeVisits'), today.visits);
  } catch (err) {
    showToast(err.message);
  }
}

async function loadToday() {
  try {
    const data = await api('/api/today');
    $('#todayDateLabel').textContent = data.date;
    $('#todayStats').innerHTML = `
      <div class="stat-cell"><span>今日实收</span><strong>¥${fmtYuan(data.totals.paidCents)}</strong></div>
      <div class="stat-cell"><span>发放积分</span><strong>${data.totals.pointsEarned}</strong></div>
      <div class="stat-cell"><span>抵扣积分</span><strong>${data.totals.pointsUsed}</strong></div>
    `;
    const box = $('#todayOrders');
    if (!data.orders.length) {
      box.innerHTML = '<div class="empty-tip">今天还没有订单</div>';
      return;
    }
    box.innerHTML = data.orders.map((order) => `
      <div class="order-row">
        <div class="order-top">
          <span class="order-main">
            ${order.customerPhone}
            ${order.status === 'void' ? '<span class="badge badge-void">已撤销</span>' : ''}
          </span>
          <span class="order-time">${order.createdAt.slice(11)}</span>
        </div>
        <div class="order-detail">
          <span>金额 ¥${fmtYuan(order.amountCents)}</span>
          <span>实付 ¥${fmtYuan(order.paidCents)}</span>
          <span>用 ${order.pointsUsed} 分</span>
          <span>得 ${order.pointsEarned} 分</span>
        </div>
        <div class="order-actions">
          <button class="ghost-btn" data-view-customer="${order.customerId}">查看客人</button>
        </div>
      </div>
    `).join('');
    box.querySelectorAll('[data-view-customer]').forEach((btn) => {
      btn.addEventListener('click', () => openCustomer(Number(btn.dataset.viewCustomer)));
    });
  } catch (err) {
    showToast(err.message);
  }
}

async function searchCustomers() {
  const q = $('#customerSearchInput').value.trim();
  const box = $('#customerResults');
  if (!q) {
    box.innerHTML = '<div class="empty-tip">请输入手机号</div>';
    return;
  }
  try {
    const data = await api(`/api/customers/search?q=${encodeURIComponent(q)}`);
    if (!data.customers.length) {
      box.innerHTML = '<div class="empty-tip">没有找到该手机号</div>';
      return;
    }
    box.innerHTML = data.customers.map((c) => `
      <button class="customer-row" data-customer-id="${c.id}">
        <div class="row-main">
          <div class="row-title">${c.phone} ${badgeFor(c)}</div>
          <div class="row-sub">可用 ${c.available} 积分 · 累计消费 ¥${fmtYuan(c.totalPaidCents)}</div>
        </div>
      </button>
    `).join('');
    box.querySelectorAll('[data-customer-id]').forEach((btn) => {
      btn.addEventListener('click', () => openCustomer(Number(btn.dataset.customerId)));
    });
  } catch (err) {
    showToast(err.message);
  }
}

function renderWorkbench(data) {
  const c = data.customer;
  state.currentCustomer = c;
  state.referrer = null;
  $('#wbPhone').textContent = c.phone;
  $('#wbMeta').innerHTML = `${badgeFor(c)} · 累计消费 ¥${fmtYuan(c.totalPaidCents)}`;
  $('#wbStats').innerHTML = `
    <div class="stat-cell"><span>可用积分</span><strong>${c.available}</strong></div>
    <div class="stat-cell"><span>今日已得</span><strong>${c.todayEarned}</strong></div>
    <div class="stat-cell"><span>累计积分</span><strong>${c.totalPointsEarned}</strong></div>
  `;
  const refSection = $('#referralSection');
  if (c.isNew) {
    refSection.classList.remove('hidden');
    if (c.referrerPhone) {
      $('#refSelectedText').textContent = `已绑定老客：${c.referrerPhone}`;
      $('#refSelected').classList.remove('hidden');
      $('#refSearchBtn').classList.add('hidden');
      $('#refResults').classList.add('hidden');
    } else {
      $('#refSelected').classList.add('hidden');
      $('#refSearchBtn').classList.remove('hidden');
    }
  } else {
    refSection.classList.add('hidden');
  }
  $('#amountInput').value = '';
  $('#pointsInput').value = '';
  $('#payableText').textContent = '0.00 元';
  $('#payBtn').disabled = true;
  recalcPay();
  renderHistory(data.history);
}

function renderHistory(history) {
  const box = $('#historyList');
  if (!history.length) {
    box.innerHTML = '<div class="empty-tip">暂无消费记录</div>';
    return;
  }
  box.innerHTML = history.map((order) => {
    const title = order.type === 'referral' ? '老客带新人奖励' : '消费';
    const statusBadge = order.status === 'void'
      ? '<span class="badge badge-void">已撤销</span>'
      : (order.type === 'referral' ? '<span class="badge badge-referral">带人奖励</span>' : '');
    const voidBtn = order.type === 'sale' && order.status === 'active'
      ? `<div class="order-actions"><button class="ghost-btn" data-void-order="${order.id}">撤销</button></div>`
      : '';
    return `
      <div class="order-row">
        <div class="order-top">
          <span class="order-main">${title} ${statusBadge}</span>
          <span class="order-time">${order.createdAt}</span>
        </div>
        <div class="order-detail">
          ${order.type === 'sale' ? `
            <span>金额 ¥${fmtYuan(order.amountCents)}</span>
            <span>实付 ¥${fmtYuan(order.paidCents)}</span>
            <span>用 ${order.pointsUsed} 分</span>
            <span>得 ${order.pointsEarned} 分</span>
          ` : `<span>赠送积分 ${order.pointsEarned} 分</span>`}
        </div>
        ${voidBtn}
      </div>
    `;
  }).join('');
  box.querySelectorAll('[data-void-order]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = history.find((o) => o.id === Number(btn.dataset.voidOrder));
      openVoidModal(order);
    });
  });
}

async function openCustomer(id) {
  try {
    const data = await api(`/api/customers/${id}`);
    renderWorkbench(data);
    $('#workbench').classList.remove('hidden');
  } catch (err) {
    showToast(err.message);
  }
}

function closeWorkbench() {
  $('#workbench').classList.add('hidden');
  loadHome();
}

function recalcPay() {
  const amountCents = Math.max(0, Math.round(parseFloat($('#amountInput').value || '0') * 100));
  let points = Math.max(0, Math.round(parseFloat($('#pointsInput').value || '0')));
  const available = state.currentCustomer ? state.currentCustomer.available : 0;
  const maxByAmount = Math.floor(amountCents / 100);
  points = Math.min(points, available, maxByAmount);
  $('#pointsInput').value = points;
  state.amountCents = amountCents;
  state.pointsUsed = points;
  $('#payableText').textContent = `${fmtYuan(amountCents - points * 100)} 元`;
  $('#payBtn').disabled = amountCents <= 0;
}

async function searchReferrer() {
  const q = $('#refPhoneInput').value.trim();
  const box = $('#refResults');
  if (!q) return;
  try {
    const data = await api(`/api/customers/search?q=${encodeURIComponent(q)}`);
    if (!data.customers.length) {
      box.innerHTML = '<div class="empty-tip">没有找到该手机号</div>';
      return;
    }
    box.innerHTML = data.customers.map((c) => `
      <button class="customer-row" data-ref-id="${c.id}" data-ref-phone="${c.phone}">
        <div class="row-main">
          <div class="row-title">${c.phone} ${badgeFor(c)}</div>
          <div class="row-sub">可用 ${c.available} 积分</div>
        </div>
      </button>
    `).join('');
    box.querySelectorAll('[data-ref-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.referrer = { id: Number(btn.dataset.refId), phone: btn.dataset.refPhone };
        $('#refSelectedText').textContent = `已绑定老客：${btn.dataset.refPhone}`;
        $('#refSelected').classList.remove('hidden');
        $('#refResults').classList.add('hidden');
        $('#refPhoneInput').value = '';
      });
    });
  } catch (err) {
    showToast(err.message);
  }
}

function openPayment() {
  if (state.amountCents <= 0) return;
  const payableCents = state.amountCents - state.pointsUsed * 100;
  $('#payAmountText').textContent = `¥${fmtYuan(payableCents)}`;
  switchQr(state.qrType);
  $('#paymentModal').classList.remove('hidden');
}

function switchQr(type) {
  state.qrType = type;
  document.querySelectorAll('.qr-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.qrtype === type);
  });
  const img = $('#payQrImg');
  img.onerror = () => {
    img.src = '/qr-placeholder.svg';
  };
  img.src = `/uploads/${type}.png`;
}

async function confirmPayment() {
  try {
    const res = await api('/api/orders', {
      method: 'POST',
      body: {
        customerId: state.currentCustomer.id,
        amountCents: state.amountCents,
        pointsUsed: state.pointsUsed,
        referrerPhone: state.referrer ? state.referrer.phone : ''
      }
    });
    $('#paymentModal').classList.add('hidden');
    $('#successPaid').textContent = `¥${fmtYuan(state.amountCents - state.pointsUsed * 100)}`;
    $('#successPoints').textContent = `${res.pointsEarned} 积分`;
    $('#successRemaining').textContent = `${res.availableAfter} 积分`;
    $('#successModal').classList.remove('hidden');
    state.amountCents = 0;
    state.pointsUsed = 0;
    const data = await api(`/api/customers/${state.currentCustomer.id}`);
    renderWorkbench(data);
  } catch (err) {
    showToast(err.message);
  }
}

function openVoidModal(order) {
  state.voidOrderId = order.id;
  $('#voidHint').textContent = `金额 ¥${fmtYuan(order.amountCents)}，实付 ¥${fmtYuan(order.paidCents)}，本次得 ${order.pointsEarned} 分、用 ${order.pointsUsed} 分。撤销后积分会自动调整。`;
  $('#voidModal').classList.remove('hidden');
}

async function confirmVoid() {
  try {
    await api(`/api/orders/${state.voidOrderId}/void`, { method: 'POST' });
    $('#voidModal').classList.add('hidden');
    showToast('订单已撤销，积分已调整');
    const data = await api(`/api/customers/${state.currentCustomer.id}`);
    renderWorkbench(data);
  } catch (err) {
    showToast(err.message);
  }
}

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    $('#storeNameInput').value = data.storeName;
  } catch (err) {
    showToast(err.message);
  }
  ['wechat', 'alipay'].forEach((type) => {
    const preview = $(`#${type}Preview`);
    const test = new Image();
    test.onload = () => { preview.src = `/uploads/${type}.png`; };
    test.src = `/uploads/${type}.png`;
  });
}

async function saveStoreName() {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: { storeName: $('#storeNameInput').value }
    });
    showToast('店铺名称已保存');
    loadHome();
  } catch (err) {
    showToast(err.message);
  }
}

async function uploadQr(type, file) {
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
    const res = await api('/api/upload', { method: 'POST', body: { type, dataUrl } });
    $(`#${type}Preview`).src = res.url;
    showToast(type === 'wechat' ? '微信收款码已更新' : '支付宝收款码已更新');
  } catch (err) {
    showToast(err.message);
  }
}

function bindEvents() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
  $('#homeRefreshBtn').addEventListener('click', loadHome);
  $('#todayRefreshBtn').addEventListener('click', loadToday);
  $('#customerSearchBtn').addEventListener('click', searchCustomers);
  $('#customerSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchCustomers();
  });
  $('#workbenchBackBtn').addEventListener('click', closeWorkbench);
  $('#refSearchBtn').addEventListener('click', searchReferrer);
  $('#refPhoneInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchReferrer();
  });
  $('#refChangeBtn').addEventListener('click', () => {
    state.referrer = null;
    $('#refSelected').classList.add('hidden');
    $('#refResults').classList.remove('hidden');
  });
  $('#amountInput').addEventListener('input', recalcPay);
  $('#pointsInput').addEventListener('input', recalcPay);
  $('#payBtn').addEventListener('click', openPayment);
  document.querySelectorAll('.qr-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchQr(tab.dataset.qrtype));
  });
  $('#cancelPayBtn').addEventListener('click', () => $('#paymentModal').classList.add('hidden'));
  $('#confirmPayBtn').addEventListener('click', confirmPayment);
  $('#successCloseBtn').addEventListener('click', () => $('#successModal').classList.add('hidden'));
  $('#cancelVoidBtn').addEventListener('click', () => $('#voidModal').classList.add('hidden'));
  $('#confirmVoidBtn').addEventListener('click', confirmVoid);
  $('#settingsBtn').addEventListener('click', () => {
    loadSettings();
    $('#settingsModal').classList.remove('hidden');
  });
  $('#settingsCloseBtn').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
  $('#saveStoreNameBtn').addEventListener('click', saveStoreName);
  document.querySelectorAll('input[type="file"]').forEach((input) => {
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (file) uploadQr(input.dataset.qrtype, file);
    });
  });
}

setInterval(() => {
  if ($('#view-home').classList.contains('active') && $('#workbench').classList.contains('hidden')) loadHome();
}, 8000);

bindEvents();
loadHome();
