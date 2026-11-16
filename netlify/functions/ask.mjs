// Netlify Function: /.netlify/functions/ask
// Принимает вопрос и текущее состояние калькулятора, спрашивает модель на OpenRouter, при ошибке/таймауте — Groq.
// Ключи только в переменных окружения Netlify: OPENROUTER_API_KEY, GROQ_API_KEY. Модели: MODEL, GROQ_MODEL.

const METHOD = `Методика калькулятора (учебная модель):
- Банк размещает выпуск облигаций (не организатор). Каналы: a) институционалы на размещении (≤ спроса), b) частные на размещении (≤ спроса), q) баланс «на перепродажу», h) баланс «до погашения»; q+h ≤ свободного лимита, a+b+q+h ≤ объёма выпуска. Остаток «не распределено» допустим.
- Расчёт помесячный от остатка на начало месяца. Купон = КС + спред (фикс — просто ставка). Фондирование = КС + 0,2 п.п. Ожидаемые потери = PD × LGD 45%.
- Перепродажа: 1-й месяц держим, со 2-го продаём частным по темпу, доход 0,54% с продажи; проданное не требует капитала.
- Капитал = позиция × риск-вес × 12% (120% для перепродажи, риск-вес заёмщика для «до погашения»).
- Налог 25% с положительной прибыли сделки.
- ROE = годовая прибыль после налога / средний капитал. IRR — годовая ставка по помесячным потокам на капитал после налога: −капитал на входе, + прибыль месяца после налога, + высвобожденный капитал.
- Подбор: перебор q и h с шагом 0,1 млрд; a и b добираются до спроса; выбирается максимум прибыли после налога среди вариантов, проходящих оба порога (IRR ≥ 30%, ROE ≥ 26,5%).
Допущения (спорные места условия, у каждого переключатель):
- Комиссия (подтвердил работодатель): банк получает 50% комиссии организатора со всего объёма, проходящего через него, включая объём на баланс; институционалам отдаёт 90% от доли банка (банку остаётся 5% всей комиссии).
- «Капитал × фондирование» — расход, стоимость капитала (подтвердил работодатель).
- IRR — наш выбор (работодатель оставил на усмотрение): по всей сделке, по потокам после налога, та же база, что у ROE; до налога IRR был бы завышен примерно на треть.
- Сценарии меняют спрос, темп продаж и лимит не меняются. Продажа с баланса по номиналу.`;

const SYSTEM = `Ты помощник в учебном калькуляторе размещения облигаций. Отвечай по-русски, коротко (3–4 предложения), простым языком. Не описывай причинно-следственные связи, которых нет в расчёте (например, не говори, что рост позиции снижает капитал: он его увеличивает).
Правила:
1. Числа бери только из переданного JSON текущего расчёта. Сам ничего не вычисляй, не оценивай и не придумывай. Если нужного числа нет в расчёте, скажи, где его посмотреть в калькуляторе (вкладки: Результат, Сценарии, Сравнение сделок, Проверка, Методика).
2. Опирайся на методику и допущения ниже. Если ответа там нет, так и скажи.
3. Комиссию и стоимость капитала подтвердил работодатель. Базу IRR называй нашим выбором и объясняй его.
4. Не давай инвестиционных рекомендаций: данные учебные и вымышленные.
5. Поле binding: di/dr — упёрлись в спрос институционалов/частных, lim — в лимит, V — в объём выпуска, roe/irr — в порог.
${METHOD}`;

const hits = new Map(); // мягкий лимит на экземпляр функции: 10/мин и 50/день с одного IP
function limited(ip) {
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  let h = hits.get(ip);
  if (!h || h.day !== day) h = { day, n: 0, t: [] };
  h.t = h.t.filter(x => now - x < 60000);
  if (h.t.length >= 10 || h.n >= 50) { hits.set(ip, h); return true; }
  h.t.push(now); h.n++; hits.set(ip, h); return false;
}

async function callModel(url, key, model, messages, ms, extra = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 500, ...extra })
    });
    if (!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty');
    return text;
  } finally { clearTimeout(timer); }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body; try { body = await req.json(); } catch { return json({ answer: 'Не удалось прочитать вопрос.' }, 400); }
  const q = String(body.question || '').trim().slice(0, 500);
  if (!q) return json({ answer: 'Напишите вопрос.' }, 400);
  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'anon';
  if (limited(ip)) return json({ answer: 'Слишком много вопросов. Не больше 10 в минуту и 50 в день.' }, 429);

  const state = JSON.stringify(body.state || {}).slice(0, 12000);
  const history = (Array.isArray(body.history) ? body.history : []).slice(-6)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant')).map(m => ({ role: m.role, content: String(m.content).slice(0, 1500) }));
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: 'Текущий расчёт на экране (JSON):\n' + state },
    ...history,
    { role: 'user', content: q }
  ];

  const env = k => (globalThis.Netlify?.env?.get?.(k)) ?? process.env[k];
  const orKey = env('OPENROUTER_API_KEY'), grKey = env('GROQ_API_KEY');
  const orModel = env('MODEL') || 'google/gemma-4-31b-it:free';
  const grModel = env('GROQ_MODEL') || 'openai/gpt-oss-120b';

  if (orKey) {
    try { return json({ answer: await callModel('https://openrouter.ai/api/v1/chat/completions', orKey, orModel, messages, 6000, { reasoning: { enabled: false } }), via: 'openrouter' }); }
    catch (e) { console.log('openrouter failed:', e.message); }
  }
  if (grKey) {
    try { return json({ answer: await callModel('https://api.groq.com/openai/v1/chat/completions', grKey, grModel, messages, 3500, grModel.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}), via: 'groq' }); }
    catch (e) { console.log('groq failed:', e.message); }
  }
  return json({ answer: 'Ассистент сейчас занят, попробуйте через минуту.' });
};
