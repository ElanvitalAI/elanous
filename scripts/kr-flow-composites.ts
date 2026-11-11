import { readFileSync } from 'node:fs';

const disclaimer = '정보 제공·판단 보조이며 투자 권유 아님';
type Data = Record<string, unknown>;
const object = (value: unknown): Data => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_object');
  return value as Data;
};
const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid_number');
  return value;
};
const result = (outputs: Data, id: string): Data => {
  const envelope = object(outputs[id]);
  if (envelope.outcome !== 'ok') throw new Error(`missing_${id}`);
  return object(envelope.result);
};
const stock = (outputs: Data, prefix: string, symbol: string) => {
  const quote = result(outputs, `${prefix}-quote`);
  const flow = result(outputs, `${prefix}-flow`);
  if (quote.symbol !== symbol || flow.symbol !== symbol || quote.market !== 'KR' || flow.market !== 'KR' ||
    quote.currency !== 'KRW' || typeof quote.asOf !== 'string' || typeof flow.asOf !== 'string' ||
    quote.asOf.slice(0, 10) !== flow.asOf.slice(0, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(flow.asOf.slice(0, 10)))
    throw new Error('inconsistent_stock');
  return { symbol, price: number(quote.price), foreignNetVolume: number(flow.foreignNetVolume),
    institutionNetVolume: number(flow.institutionNetVolume), asOf: flow.asOf.slice(0, 10),
    quoteSource: String(quote.source), flowSource: String(flow.source) };
};

function compose(command: string, outputs: Data): Data {
  if (command === 'sector-flow') {
    const sectors = [
      { name: '반도체 대표', ...stock(outputs, 'semi', '005930') },
      { name: '배터리 대표', ...stock(outputs, 'battery', '373220') },
    ].map((item) => ({ ...item, netVolume: item.foreignNetVolume + item.institutionNetVolume }));
    if (sectors[0].asOf !== sectors[1].asOf) throw new Error('inconsistent_date');
    return { command, asOf: sectors[0].asOf, sectors: sectors.sort((a, b) => b.netVolume - a.netVolume),
      limits: '대표 종목 각 1개·하루치 순매수량의 비교이며 업종 전체 자금 흐름이나 rolling z-score가 아니다.', disclaimer };
  }
  if (command === 'battery-signal') {
    const basket = [
      { name: 'LG에너지솔루션', weight: 0.50, ...stock(outputs, 'lg', '373220') },
      { name: '삼성SDI', weight: 0.35, ...stock(outputs, 'sdi', '006400') },
      { name: '에코프로', weight: 0.15, ...stock(outputs, 'eco', '086520') },
    ];
    if (new Set(basket.map((item) => item.asOf)).size !== 1) throw new Error('inconsistent_date');
    const weightedNetVolume = basket.reduce((sum, item) => sum + item.weight * (item.foreignNetVolume + item.institutionNetVolume), 0);
    return { command, asOf: basket[0].asOf, basket, weightedNetVolume,
      signal: weightedNetVolume > 0 ? '순매수 우세 관측' : weightedNetVolume < 0 ? '순매도 우세 관측' : '중립 관측',
      limits: '하루치 계약 수급의 가중 합성이다. 원본 kr-flow의 5일 누계와 같지 않다.', disclaimer };
  }
  if (command === 'etf-price') {
    const response = result(outputs, 'etf-bars');
    if (response.market !== 'KR' || response.symbol !== '471990' || !Array.isArray(response.bars) || response.bars.length < 6)
      throw new Error('insufficient_etf_bars');
    const bars = response.bars.map(object);
    const dates = bars.map((bar) => {
      if (typeof bar.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(bar.date)) throw new Error('invalid_etf_date');
      const date = new Date(`${bar.date}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== bar.date ||
        date.getUTCDay() === 0 || date.getUTCDay() === 6) throw new Error('invalid_etf_date');
      return bar.date;
    });
    if (new Set(dates).size !== dates.length) throw new Error('duplicate_etf_date');
    bars.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const last = bars.at(-1)!; const previous = bars.at(-2)!; const weekStart = bars.at(-6)!;
    const close = number(last.close); const prevClose = number(previous.close); const weekClose = number(weekStart.close);
    if (close <= 0 || prevClose <= 0 || weekClose <= 0 || typeof last.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(last.date)) throw new Error('invalid_etf_bars');
    return { command, symbol: '471990', asOf: last.date, source: response.source, close,
      oneDayPct: Number((((close / prevClose) - 1) * 100).toFixed(2)),
      oneWeekPct: Number((((close / weekClose) - 1) * 100).toFixed(2)),
      limits: '고정 일봉 6개로 계산한 ETF 가격 변화다. 구성종목 수익 기여도는 이 계약에 없어 산출하지 않는다.', disclaimer };
  }
  throw new Error('unsupported_composition');
}

try {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextPath) throw new Error('missing_graph_context');
  const context = object(JSON.parse(readFileSync(contextPath, 'utf8')));
  const output = compose(process.argv[2] ?? '', object(context.outputs));
  console.log(JSON.stringify({ outcome: 'ok', ...output }));
} catch (error) {
  console.log(JSON.stringify({ outcome: 'fail', error: error instanceof Error ? error.message : 'composition_failed' }));
}
