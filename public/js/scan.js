const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function loadStoreName() {
  try {
    const data = await api('/api/settings');
    $('#scanStoreName').textContent = data.storeName;
    document.title = data.storeName;
  } catch {
    // 保留默认店铺名
  }
}

$('#scanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = $('#scanPhone').value.trim();
  if (!/^\d{6,15}$/.test(phone)) {
    $('#scanPhone').focus();
    alert('请输入正确的手机号');
    return;
  }
  try {
    const data = await api('/api/scan', { method: 'POST', body: { phone } });
    $('#scanMessage').textContent = data.message;
    $('#scanPhoneText').textContent = `手机号 ${data.customer.phone}`;
    $('#scanForm').classList.add('hidden');
    $('#scanSuccess').classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
});

$('#scanAgainBtn').addEventListener('click', () => {
  $('#scanPhone').value = '';
  $('#scanForm').classList.remove('hidden');
  $('#scanSuccess').classList.add('hidden');
  $('#scanPhone').focus();
});

loadStoreName();
