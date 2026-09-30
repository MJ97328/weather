// 기상청 API 프록시 (Cloudflare Worker)
// - 인증키는 Cloudflare 비밀값(KMA_KEY)에만 저장되고, 웹사이트 코드에는 들어가지 않는다.
// - GET /?lat=37.56&lon=126.97 → 현재 실황 + 단기예보(약 3일)를 정리한 JSON
//
// 사용하는 기상청 API (공공데이터포털 「기상청_단기예보 ((구)_동네예보) 조회서비스」)
// - getUltraSrtNcst: 초단기실황 (지금 기온, 습도, 바람, 강수)
// - getVilageFcst:   단기예보 (시간별 기온, 하늘, 강수형태, 강수확률, 강수량, 최저/최고)

const ALLOWED_ORIGINS = [
  "https://mj97328.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];
const API = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    if (!url.searchParams.has("lat") || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json({ ok: true, message: "기상청 프록시가 동작 중입니다. ?lat=37.56&lon=126.97 형식으로 호출하세요." }, 200, cors);
    }
    if (!env.KMA_KEY) return json({ error: "KMA_KEY 비밀값이 설정되지 않았습니다." }, 500, cors);

    try {
      const data = await getForecast(env.KMA_KEY, lat, lon);
      return json(data, 200, { ...cors, "Cache-Control": "public, max-age=600" });
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, cors);
    }
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

// ---- 위경도 → 기상청 격자(nx, ny) 변환 (기상청 제공 LCC 공식) ----
export function toGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD, slat2 = SLAT2 * DEGRAD, olon = OLON * DEGRAD, olat = OLAT * DEGRAD;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;
  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}

// ---- 발표 시각 계산 (한국 시간 기준) ----
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000); // UTC getter로 읽으면 한국 시간

// 단기예보: 02, 05, 08, 11, 14, 17, 20, 23시 발표, 약 10분 뒤부터 조회 가능
export function vilageBases(now = kstNow()) {
  const t = new Date(now.getTime() - 15 * 60 * 1000);
  const hours = [2, 5, 8, 11, 14, 17, 20, 23];
  const h = t.getUTCHours();
  let latest;
  const past = hours.filter((x) => x <= h);
  if (past.length) {
    latest = { date: ymd(t), time: `${pad(past[past.length - 1])}00` };
  } else {
    const y = new Date(t.getTime() - 24 * 3600 * 1000);
    latest = { date: ymd(y), time: "2300" };
  }
  // 오늘 최저/최고(TMN/TMX)는 이른 발표에만 들어 있어서 오늘 02시(없으면 어제 23시) 발표도 함께 조회
  // (자정 직후에는 t가 어제 날짜라, 오늘 값은 어제 23시 발표(latest)에 들어 있음)
  const early = past.length && ymd(t) === ymd(now) ? { date: ymd(t), time: "0200" } : latest;
  return { latest, early };
}

// 초단기실황: 매시 정각 기준, 약 40분 뒤부터 조회 가능
export function ncstBase(now = kstNow()) {
  const t = new Date(now.getTime() - 45 * 60 * 1000);
  return { date: ymd(t), time: `${pad(t.getUTCHours())}00` };
}

async function callKMA(key, op, params) {
  // 일반 인증키(Decoding)는 인코딩해서, Encoding 키(이미 %가 들어 있음)는 그대로 사용
  const serviceKey = key.includes("%") ? key : encodeURIComponent(key);
  const qs = new URLSearchParams({ pageNo: "1", dataType: "JSON", ...params }).toString();
  const res = await fetch(`${API}/${op}?serviceKey=${serviceKey}&${qs}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // 인증키 오류 등은 JSON을 요청해도 XML로 온다
    const msg = text.match(/<returnAuthMsg>([^<]+)</)?.[1] || text.match(/<resultMsg>([^<]+)</)?.[1] || text.slice(0, 200);
    throw new Error(`기상청 API 오류: ${msg}`);
  }
  const header = body?.response?.header;
  if (header?.resultCode !== "00") throw new Error(`기상청 API 오류: ${header?.resultMsg || "알 수 없음"}`);
  const items = body.response.body?.items?.item;
  return Array.isArray(items) ? items : [];
}

// PCP 값: "강수없음", "1mm 미만", "1.0mm", "30.0~50.0mm", "50.0mm 이상"
export function parsePcp(v) {
  if (v == null || v === "" || v === "강수없음" || v === "0") return 0;
  if (String(v).includes("미만")) return 0.5;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

export function summarize(ncstItems, fcstItemsEarly, fcstItemsLatest) {
  // 시간별 슬롯: 늦은 발표가 이른 발표를 덮어씀
  const slots = new Map();
  const minmax = new Map();
  for (const items of [fcstItemsEarly, fcstItemsLatest]) {
    for (const it of items) {
      const key = `${it.fcstDate}${it.fcstTime}`;
      if (it.category === "TMN" || it.category === "TMX") {
        const m = minmax.get(it.fcstDate) || {};
        m[it.category] = Number(it.fcstValue);
        minmax.set(it.fcstDate, m);
        continue;
      }
      const s = slots.get(key) || { date: it.fcstDate, time: it.fcstTime };
      s[it.category] = it.fcstValue;
      slots.set(key, s);
    }
  }

  const iso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const hourly = [...slots.values()]
    .filter((s) => s.TMP != null)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .map((s) => ({
      time: `${iso(s.date)}T${s.time.slice(0, 2)}:00`,
      temp: Number(s.TMP),
      pop: s.POP == null ? null : Number(s.POP),
      sky: s.SKY == null ? null : Number(s.SKY),
      pty: s.PTY == null ? 0 : Number(s.PTY),
      pcp: parsePcp(s.PCP),
      reh: s.REH == null ? null : Number(s.REH),
      wsd: s.WSD == null ? null : Number(s.WSD),
    }));

  const dates = [...new Set(hourly.map((h) => h.time.slice(0, 10)))];
  const PTY_RANK = { 0: 0, 4: 1, 1: 2, 2: 3, 3: 3 };
  const days = dates.map((date) => {
    const hs = hourly.filter((h) => h.time.startsWith(date));
    const daytime = hs.filter((h) => { const hr = Number(h.time.slice(11, 13)); return hr >= 6 && hr <= 21; });
    const pool = daytime.length ? daytime : hs;
    // 대표 강수형태: 낮 시간 중 가장 심한 것
    const pty = pool.reduce((best, h) => ((PTY_RANK[h.pty] ?? 0) > (PTY_RANK[best] ?? 0) ? h.pty : best), 0);
    // 대표 하늘상태: 낮 시간에 가장 많이 나온 값 (같으면 더 흐린 쪽)
    const counts = {};
    for (const h of pool) if (h.sky != null) counts[h.sky] = (counts[h.sky] || 0) + 1;
    const sky = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a] || b - a)[0] ?? null;
    const m = minmax.get(date.replace(/-/g, "")) || {};
    const pops = hs.map((h) => h.pop).filter((x) => x != null);
    return {
      date,
      tmin: m.TMN ?? null,
      tmax: m.TMX ?? null,
      pop: pops.length ? Math.max(...pops) : null,
      pcp: Math.round(hs.reduce((a, h) => a + h.pcp, 0) * 10) / 10,
      sky,
      pty,
      wsdMax: Math.max(...hs.map((h) => h.wsd ?? 0)),
      hours: hs.length,
    };
  });

  let current = null;
  if (ncstItems.length) {
    const c = Object.fromEntries(ncstItems.map((it) => [it.category, it.obsrValue]));
    const it = ncstItems[0];
    current = {
      time: `${iso(it.baseDate)}T${it.baseTime.slice(0, 2)}:00`,
      temp: c.T1H == null ? null : Number(c.T1H),
      reh: c.REH == null ? null : Number(c.REH),
      wsd: c.WSD == null ? null : Number(c.WSD),
      pty: c.PTY == null ? 0 : Number(c.PTY),
      rn1: c.RN1 == null ? 0 : Number(c.RN1),
    };
  }
  return { current, days, hourly };
}

async function getForecast(key, lat, lon) {
  const { nx, ny } = toGrid(lat, lon);
  const { latest, early } = vilageBases();
  const nb = ncstBase();
  const grid = { nx: String(nx), ny: String(ny) };
  const fcst = (b) => callKMA(key, "getVilageFcst", { numOfRows: "2000", base_date: b.date, base_time: b.time, ...grid });

  const [ncst, fEarly, fLatest] = await Promise.all([
    callKMA(key, "getUltraSrtNcst", { numOfRows: "20", base_date: nb.date, base_time: nb.time, ...grid }).catch(() => []),
    early.date === latest.date && early.time === latest.time ? Promise.resolve([]) : fcst(early).catch(() => []),
    fcst(latest),
  ]);
  return { grid: { nx, ny }, base: `${latest.date} ${latest.time}`, ...summarize(ncst, fEarly, fLatest) };
}
