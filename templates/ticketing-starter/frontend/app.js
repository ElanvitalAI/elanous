const selected = new Set();
const userId = sessionStorage.getItem('demo-ticket-user') || 'demo-' + crypto.randomUUID();
sessionStorage.setItem('demo-ticket-user', userId);
let checkoutKey;

const grid = document.querySelector('#seat-grid');
const status = document.querySelector('#status');
const tickets = document.querySelector('#tickets');
const holdButton = document.querySelector('#hold');
const checkoutButton = document.querySelector('#checkout');

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-User-Id': userId, ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청 실패');
  return body;
}

function say(message) { status.textContent = message; }

async function refresh() {
  const [concert, seats, mine] = await Promise.all([
    api('/api/concerts/demo-concert'),
    api('/api/concerts/demo-concert/seats'),
    api('/api/my-tickets'),
  ]);
  document.querySelector('#event-title').textContent = concert.title;
  document.querySelector('#event-meta').textContent = concert.date + ' · ' + concert.venue;
  const sampleNote = document.querySelector('#sample-note');
  if (concert.sampleFields?.length) {
    sampleNote.textContent = '샘플/가상 입력값: ' + concert.sampleFields.join(', ') + '. 실제 공연 정보가 아닙니다.';
    sampleNote.hidden = false;
  } else {
    sampleNote.hidden = true;
  }
  grid.replaceChildren();
  for (const seat of seats) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'seat';
    button.textContent = seat.id;
    button.setAttribute('aria-pressed', String(selected.has(seat.id)));
    button.disabled = seat.status === 'sold' || (seat.status === 'held' && seat.held_by !== userId);
    button.addEventListener('click', () => {
      if (selected.has(seat.id)) selected.delete(seat.id); else selected.add(seat.id);
      button.setAttribute('aria-pressed', String(selected.has(seat.id)));
    });
    grid.append(button);
  }
  tickets.replaceChildren();
  for (const ticket of mine) {
    const item = document.createElement('li');
    item.textContent = ticket.seatId + ' · 티켓 ' + ticket.id.slice(0, 8);
    tickets.append(item);
  }
}

holdButton.addEventListener('click', async () => {
  if (!selected.size) { say('좌석을 먼저 선택하세요.'); return; }
  try {
    const result = await api('/api/concerts/demo-concert/hold', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seatIds: [...selected] }),
    });
    checkoutButton.disabled = false;
    checkoutKey = crypto.randomUUID();
    say(result.seatIds.length + '개 좌석을 2분 동안 홀드했습니다.');
    await refresh();
  } catch (error) { say(error.message); await refresh(); }
});

checkoutButton.addEventListener('click', async () => {
  try {
    const result = await api('/api/concerts/demo-concert/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': checkoutKey },
      body: JSON.stringify({ seatIds: [...selected] }),
    });
    say('합성 결제 완료 · 티켓 ' + result.ticketIds.length + '장 발급');
    selected.clear();
    checkoutKey = undefined;
    checkoutButton.disabled = true;
    await refresh();
  } catch (error) { say(error.message); await refresh(); }
});

refresh().then(() => say('좌석을 선택하세요.')).catch(error => say(error.message));
