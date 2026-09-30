// 오늘 날씨 + 한 달 달력 — Open-Meteo API (API 키 불필요)
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"; // 한글 지명 검색 대체용
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
// 기상청 프록시(Cloudflare Worker) 주소. 비어 있으면 기상청 예보 없이 동작한다. (worker/README.md 참고)
const KMA_PROXY_URL = "";
const SEASONAL_URL = "https://seasonal-api.open-meteo.com/v1/seasonal";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

const DAILY_VARS = ["temperature_2m_max", "temperature_2m_min", "precipitation_sum"];
const TOTAL_DAYS = 31; // 오늘 포함 30일 뒤까지
const SHORT_DAYS = 16; // 일반 예보가 제공하는 최대 일수
const CLIMATE_YEARS = 10;
const RAIN_MM = 1; // 이 이상이면 "비 온 날"로 계산

const $ = (id) => document.getElementById(id);

// ---- 날짜 유틸 (UTC 기준 "YYYY-MM-DD" 문자열로 다룸) ----
function toISO(d) { return d.toISOString().slice(0, 10); }
function parseISO(s) { return new Date(s + "T00:00:00Z"); }
function addDays(s, n) { const d = parseISO(s); d.setUTCDate(d.getUTCDate() + n); return toISO(d); }
function diffDays(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
function todayISO() {
  const now = new Date();
  return toISO(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}
function formatShort(s) {
  const d = parseISO(s);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${"일월화수목금토"[d.getUTCDay()]})`;
}
function formatKo(s) {
  const d = parseISO(s);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}

async function getJSON(url, params) {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.reason || `HTTP ${res.status}`);
  return body;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ---- 1) 장소 검색 ----
// Open-Meteo 지오코딩은 한글 이름을 정확히 일치하는 작은 마을부터 찾는 경우가 많아서
// ("부산" → 부산광역시 대신 같은 이름의 마을 4곳), 한글 검색은 OpenStreetMap Nominatim을
// 먼저 쓰고(큰 도시가 먼저 나옴), 결과가 없을 때 다른 쪽으로 다시 검색한다.
const hasHangul = (s) => /[\u3131-\u318e\uac00-\ud7a3]/.test(s);

async function searchPlaces(name) {
  const order = hasHangul(name) ? [searchNominatim, searchOpenMeteo] : [searchOpenMeteo, searchNominatim];
  let lastError;
  for (const search of order) {
    try {
      const results = await search(name);
      if (results.length) return results;
    } catch (e) {
      console.warn("장소 검색 실패:", e);
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return [];
}

async function searchOpenMeteo(name) {
  const data = await getJSON(GEOCODING_URL, { name, count: 8, language: "ko", format: "json" });
  // 인구가 많은 곳(큰 도시)부터
  return (data.results || []).sort((a, b) => (b.population || 0) - (a.population || 0));
}

async function searchNominatim(q) {
  const res = await fetch(`${NOMINATIM_URL}?${new URLSearchParams({
    q, format: "jsonv2", addressdetails: 1, limit: 8, "accept-language": "ko",
  })}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  // 순위: ① 이름이 검색어와 같은 결과 > 검색어가 들어간 결과 ② 중요도(큰 도시일수록 높음) + 지명(행정구역·마을)이면 가산점
  //  - "무주" → 인도네시아 Muja muju보다 무주읍이 먼저
  //  - "도쿄" → 두바이의 작은 섬(지명)보다 도쿄역(중요도 높음)이 먼저
  const score = (r) => (r.importance || 0) + (r.category === "boundary" || r.category === "place" ? 0.1 : 0);
  const matches = (r) => ((r.name || "") === q ? 2 : (r.name || "").includes(q) ? 1 : 0); // 정확히 같으면 우선
  rows.sort((a, b) => (matches(b) - matches(a)) || (score(b) - score(a)));

  const out = [];
  for (const r of rows) {
    const a = r.address || {};
    const p = {
      name: r.name || r.display_name.split(",")[0],
      latitude: Number(r.lat),
      longitude: Number(r.lon),
      admin1: a.state || a.province || a.city || "",
      country: a.country || "",
    };
    // 20km 안에 이미 더 앞선 결과가 있으면 같은 곳으로 보고 뺌 (역·식당·극장 등 중복)
    if (out.some((o) => distanceKm(o, p) < 20)) continue;
    out.push(p);
  }
  return out;
}

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}


// ---- 2) 단기 예보 (오늘 ~ 15일 뒤) + 현재 날씨 + 시간별 ----
async function shortForecast(place) {
  const data = await getJSON(FORECAST_URL, {
    latitude: place.latitude,
    longitude: place.longitude,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
    hourly: "temperature_2m,weather_code,precipitation_probability",
    daily: ["weather_code", ...DAILY_VARS, "precipitation_probability_max",
      "wind_speed_10m_max", "uv_index_max", "sunrise", "sunset"].join(","),
    forecast_days: SHORT_DAYS,
    wind_speed_unit: "ms",
    timezone: "auto",
  });
  const d = data.daily;
  const h = data.hourly;
  const hourly = h.time.map((time, i) => ({
    time,
    temp: h.temperature_2m[i],
    code: h.weather_code[i],
    rain: h.precipitation_probability[i],
  })).filter((x) => x.temp != null);

  const days = d.time.map((date, i) => ({
    date,
    kind: "short",
    code: d.weather_code[i],
    tmax: d.temperature_2m_max[i],
    tmin: d.temperature_2m_min[i],
    precip: d.precipitation_sum[i],
    rainChance: d.precipitation_probability_max[i] == null ? null : d.precipitation_probability_max[i] / 100,
    wind: d.wind_speed_10m_max[i],
    uv: d.uv_index_max[i],
    sunrise: d.sunrise[i],
    sunset: d.sunset[i],
    hourly: hourly.filter((x) => x.time.startsWith(date)),
  })).filter((x) => x.tmax != null && x.tmin != null);

  return { days, current: data.current, hourly };
}

// ---- 2-1) 기상청 단기예보 (한국, 약 3일) — 프록시가 설정된 경우에만 ----
const isKorea = (p) => p.latitude >= 33 && p.latitude <= 38.7 && p.longitude >= 124.5 && p.longitude <= 131;

async function kmaForecast(place) {
  if (!KMA_PROXY_URL || !isKorea(place)) return null;
  return getJSON(KMA_PROXY_URL, { lat: place.latitude, lon: place.longitude });
}

// 기상청 하늘상태(SKY)·강수형태(PTY) → [아이콘, 설명]
function kmaLabel(sky, pty) {
  if (pty === 1) return ["🌧️", "비"];
  if (pty === 2) return ["🌨️", "비/눈"];
  if (pty === 3) return ["❄️", "눈"];
  if (pty === 4) return ["🌦️", "소나기"];
  if (sky === 1) return ["☀️", "맑음"];
  if (sky === 3) return ["⛅", "구름많음"];
  if (sky === 4) return ["☁️", "흐림"];
  return null;
}

// 기상청 값이 있는 날짜는 기온·하늘·강수를 기상청 값으로 바꾸고,
// 바람·자외선·일출/일몰 등 기상청 단기예보에 없는 값은 Open-Meteo 값을 그대로 둔다.
function applyKMA(short, kma) {
  if (!kma || !kma.days) return false;
  const kmaDays = new Map(kma.days.map((d) => [d.date, d]));
  let used = false;
  for (const day of short.days) {
    const k = kmaDays.get(day.date);
    if (!k || k.tmin == null || k.tmax == null) continue; // 하루치가 다 없는 날은 Open-Meteo 유지
    used = true;
    Object.assign(day, {
      src: "kma",
      tmin: k.tmin,
      tmax: k.tmax,
      rainChance: k.pop == null ? day.rainChance : k.pop / 100,
      precip: k.pcp,
      label: kmaLabel(k.sky, k.pty) || undefined,
      hourly: kma.hourly
        .filter((h) => h.time.startsWith(day.date))
        .map((h) => ({ time: h.time, temp: h.temp, rain: h.pop, label: kmaLabel(h.sky, h.pty) })),
    });
  }
  if (!used) return false;

  // 시간별(오늘 탭): 기상청 시간대는 기상청 값으로, 그 뒤는 Open-Meteo 값으로
  const kmaHours = new Map(kma.hourly.map((h) => [h.time, h]));
  short.hourly = short.hourly.map((x) => {
    const h = kmaHours.get(x.time);
    return h ? { time: x.time, temp: h.temp, rain: h.pop, label: kmaLabel(h.sky, h.pty) } : x;
  });

  // 현재 날씨: 기상청 실황 관측값
  const c = kma.current;
  if (c && short.current && c.temp != null) {
    const nowHour = kma.hourly.find((h) => h.time.slice(0, 13) >= c.time.slice(0, 13));
    Object.assign(short.current, {
      temperature_2m: c.temp,
      apparent_temperature: null, // 기상청 실황에는 체감온도가 없어 섞어 보여주지 않음
      relative_humidity_2m: c.reh ?? short.current.relative_humidity_2m,
      wind_speed_10m: c.wsd ?? short.current.wind_speed_10m,
      label: kmaLabel(nowHour?.sky, c.pty) || undefined,
    });
  }
  return true;
}

// ---- 3) 장기 예측: 계절 예측(앙상블) ----
// 응답에는 변수별로 여러 앙상블 멤버 컬럼(예: temperature_2m_max_member01)이 올 수 있어
// 해당 변수로 시작하는 모든 컬럼을 모아 평균/확률을 계산한다.
async function seasonalForecast(place, startDate, endDate) {
  const days = diffDays(todayISO(), endDate) + 1;
  const data = await getJSON(SEASONAL_URL, {
    latitude: place.latitude,
    longitude: place.longitude,
    daily: DAILY_VARS.join(","),
    forecast_days: Math.min(Math.max(days, 1), 274),
    timezone: "auto",
  });
  const daily = data.daily;
  if (!daily || !daily.time) throw new Error("계절 예측 데이터 없음");

  const members = (v) => Object.keys(daily).filter((k) => k === v || k.startsWith(v + "_member"));
  const out = [];
  daily.time.forEach((date, i) => {
    if (date < startDate || date > endDate) return;
    const vals = (v) => members(v).map((k) => daily[k][i]).filter((x) => x != null);
    const tmax = vals("temperature_2m_max");
    const tmin = vals("temperature_2m_min");
    const prcp = vals("precipitation_sum");
    if (!tmax.length || !tmin.length) return;
    out.push({
      date,
      kind: "long",
      tmax: mean(tmax),
      tmin: mean(tmin),
      precip: prcp.length ? mean(prcp) : null,
      rainChance: prcp.length ? prcp.filter((p) => p >= RAIN_MM).length / prcp.length : null,
    });
  });
  if (!out.length) throw new Error("해당 기간 예측 없음");
  return out;
}

// ---- 4) 장기 예측 대체: 과거 10년 같은 날짜의 평년값 ----
async function climateNormals(place, startDate, endDate) {
  const thisYear = parseISO(todayISO()).getUTCFullYear();
  const data = await getJSON(ARCHIVE_URL, {
    latitude: place.latitude,
    longitude: place.longitude,
    start_date: `${thisYear - CLIMATE_YEARS}-01-01`,
    end_date: `${thisYear - 1}-12-31`,
    daily: DAILY_VARS.join(","),
    timezone: "auto",
  });
  const daily = data.daily;
  const index = new Map(daily.time.map((t, i) => [t, i]));

  const out = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    const mmdd = date.slice(5);
    const rows = [];
    for (let y = thisYear - CLIMATE_YEARS; y < thisYear; y++) {
      const i = index.get(`${y}-${mmdd}`);
      if (i != null && daily.temperature_2m_max[i] != null) rows.push(i);
    }
    if (!rows.length) continue;
    const col = (k) => rows.map((i) => daily[k][i]).filter((x) => x != null);
    const prcp = col("precipitation_sum");
    out.push({
      date,
      kind: "normal",
      tmax: mean(col("temperature_2m_max")),
      tmin: mean(col("temperature_2m_min")),
      precip: prcp.length ? mean(prcp) : null,
      rainChance: prcp.length ? prcp.filter((p) => p >= RAIN_MM).length / prcp.length : null,
    });
  }
  if (!out.length) throw new Error("과거 데이터 없음");
  return out;
}

// ---- 날씨 요약 ----
// 단기 예보는 WMO 날씨 코드, 장기 예측은 강수 확률/양으로 추정
function describeCode(code) {
  if (code === 0) return ["☀️", "맑음"];
  if (code === 1) return ["🌤️", "대체로 맑음"];
  if (code === 2) return ["⛅", "구름 조금"];
  if (code === 3) return ["☁️", "흐림"];
  if (code === 45 || code === 48) return ["🌫️", "안개"];
  if (code >= 51 && code <= 57) return ["🌦️", "이슬비"];
  if (code >= 61 && code <= 67) return ["🌧️", "비"];
  if (code >= 71 && code <= 77) return ["🌨️", "눈"];
  if (code >= 80 && code <= 82) return ["🌧️", "소나기"];
  if (code === 85 || code === 86) return ["🌨️", "눈 소나기"];
  if (code >= 95) return ["⛈️", "뇌우"];
  return null;
}

// 모델의 날씨 코드는 0.1mm 정도의 아주 약한 비에도 비/눈 코드가 나와서,
// 하루 강수량이 적고 확률도 낮으면 흐림으로 보여준다.
const isPrecipCode = (c) => (c >= 51 && c <= 67) || (c >= 71 && c <= 77) || (c >= 80 && c <= 86);

function describe(day) {
  if (day.label) return day.label;
  if (day.code != null) {
    if (isPrecipCode(day.code) && (day.precip ?? 0) < 1 && (day.rainChance ?? 0) < 0.5) {
      return (day.precip ?? 0) > 0 ? ["☁️", "흐림, 빗방울 가능"] : ["☁️", "흐림"];
    }
    const r = describeCode(day.code);
    if (r) return r;
  }
  const chance = day.rainChance ?? 0;
  const precip = day.precip ?? 0;
  const snowy = day.tmax <= 1;
  if (chance >= 0.6 || precip >= 10) return snowy ? ["❄️", "눈 가능성 높음"] : ["🌧️", "비 가능성 높음"];
  if (chance >= 0.35 || precip >= 2) return snowy ? ["🌨️", "눈 올 수도"] : ["🌦️", "비 올 수도"];
  if (chance >= 0.15 || precip >= 0.5) return ["⛅", "구름 많음"];
  return ["☀️", "대체로 맑음"];
}

const isRainy = (d) => /비|눈|소나기|뇌우/.test(describe(d)[1]) && !/빗방울 가능/.test(describe(d)[1]);
const fmtT = (t) => (t == null ? "-" : `${Math.round(t)}°`);
const fmtPct = (c) => (c == null ? "-" : `${Math.round(c * 100)}%`);
const fmtMM = (p) => (p == null ? "-" : `${p.toFixed(1)}mm`);
const fmtClock = (iso) => (iso ? iso.slice(11, 16) : "-");
const uvLevel = (uv) => (uv == null ? "" : uv < 3 ? "낮음" : uv < 6 ? "보통" : uv < 8 ? "높음" : uv < 11 ? "매우 높음" : "위험");

// ---- 화면 공통 ----
function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

function placeLabel(p) {
  return [p.name, p.admin1, p.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showResults(places) {
  const ul = $("results");
  ul.innerHTML = "";
  places.forEach((p) => {
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.innerHTML = `${escapeHTML(p.name)} <small>${escapeHTML([p.admin1, p.country].filter(Boolean).join(", "))}</small>`;
    const pick = () => { ul.hidden = true; loadForecast(p); };
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
    ul.appendChild(li);
  });
  ul.hidden = places.length === 0;
}

// ---- 탭 ----
function selectTab(name) {
  for (const t of ["today", "month"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
}
$("tab-today").addEventListener("click", () => selectTab("today"));
$("tab-month").addEventListener("click", () => selectTab("month"));

function hourlyStrip(items) {
  return items.map((x) => `
    <div class="h">
      <div class="t">${Number(x.time.slice(11, 13))}시</div>
      <div class="i">${(x.label || describeCode(x.code) || ["·"])[0]}</div>
      <div class="v">${fmtT(x.temp)}</div>
      <div class="p">${x.rain ? `${x.rain}%` : ""}</div>
    </div>`).join("");
}

// ---- 오늘 탭 ----
function renderToday(today, current, hourly) {
  if (!today || !current) {
    $("now").innerHTML = `<div class="meta">오늘 날씨를 불러오지 못했습니다.</div>`;
    $("today-stats").innerHTML = "";
    $("hourly").innerHTML = "";
    return;
  }
  const [icon, desc] = current.label || describeCode(current.weather_code) || describe(today);
  $("now").innerHTML = `
    <div class="big-icon">${icon}</div>
    <div>
      <div class="temp">${fmtT(current.temperature_2m)}</div>
      <div class="desc">${desc}</div>
      <div class="meta">${current.apparent_temperature == null ? "" : `체감 ${fmtT(current.apparent_temperature)} · `}<span class="hi">최고 ${fmtT(today.tmax)}</span> / <span class="lo">최저 ${fmtT(today.tmin)}</span></div>
    </div>`;

  const stat = (label, value) => `<div><span class="label">${label}</span><span class="value">${value}</span></div>`;
  $("today-stats").innerHTML = [
    stat("비 올 확률", fmtPct(today.rainChance)),
    stat("습도", current.relative_humidity_2m == null ? "-" : `${current.relative_humidity_2m}%`),
    stat("바람", current.wind_speed_10m == null ? "-" : `${current.wind_speed_10m.toFixed(1)}m/s`),
    stat("자외선", today.uv == null ? "-" : `${Math.round(today.uv)} ${uvLevel(today.uv)}`),
    stat("일출", fmtClock(today.sunrise)),
    stat("일몰", fmtClock(today.sunset)),
  ].join("");

  // 현재 시각부터 24시간
  const nowHour = current.time.slice(0, 13);
  const from = Math.max(0, hourly.findIndex((x) => x.time.slice(0, 13) >= nowHour));
  $("hourly").innerHTML = hourlyStrip(hourly.slice(from, from + 24));
}

// ---- 한 달 탭 (달력) ----
let monthDays = [];

function renderMonth(days) {
  monthDays = days;
  const rainyDays = days.filter(isRainy).length;
  const box = (label, value, cls = "") => `<div><span class="label">${label}</span><span class="value ${cls}">${value}</span></div>`;
  $("summary").innerHTML = [
    box("평균 최고", fmtT(mean(days.map((d) => d.tmax))), "hi"),
    box("평균 최저", fmtT(mean(days.map((d) => d.tmin))), "lo"),
    box("가장 더운 날", fmtT(Math.max(...days.map((d) => d.tmax))), "hi"),
    box("가장 추운 날", fmtT(Math.min(...days.map((d) => d.tmin))), "lo"),
    box("비·눈 예상일", `${rainyDays}일`),
  ].join("");

  // 첫날이 속한 주의 일요일부터 마지막 날이 속한 주의 토요일까지
  const first = days[0].date;
  const last = days[days.length - 1].date;
  const gridStart = addDays(first, -parseISO(first).getUTCDay());
  const gridEnd = addDays(last, 6 - parseISO(last).getUTCDay());
  const byDate = new Map(days.map((d, i) => [d.date, i]));

  let html = "";
  for (let date = gridStart; date <= gridEnd; date = addDays(date, 1)) {
    const i = byDate.get(date);
    if (i == null) { html += `<div class="cell out"></div>`; continue; }
    const d = days[i];
    const dt = parseISO(date);
    const dom = dt.getUTCDate();
    const dow = dt.getUTCDay();
    const showMonth = i === 0 || dom === 1;
    const [ic] = describe(d);
    // 강수량이 거의 없는 날은 확률만 높게 나와도 비가 오는 것처럼 보여서, 비 아이콘인 날만 표시
    const rain = isRainy(d) ? fmtPct(d.rainChance) : "";
    html += `
      <button type="button" class="cell ${d.kind} ${i === 0 ? "today" : ""}" data-i="${i}"
        aria-label="${formatKo(date)} ${describe(d)[1]}, 최고 ${fmtT(d.tmax)} 최저 ${fmtT(d.tmin)}">
        <span class="d ${dow === 0 ? "sun" : dow === 6 ? "sat" : ""}">${showMonth ? `<span class="m">${dt.getUTCMonth() + 1}/</span>` : ""}${dom}</span>
        <span class="i">${ic}</span>
        <span class="tt"><span class="hi">${Math.round(d.tmax)}</span>/<span class="lo">${Math.round(d.tmin)}</span></span>
        <span class="rp">${rain}</span>
      </button>`;
  }
  $("calendar").innerHTML = html;
}

$("calendar").addEventListener("click", (e) => {
  const cell = e.target.closest(".cell[data-i]");
  if (cell) openDetail(monthDays[Number(cell.dataset.i)], Number(cell.dataset.i));
});

// ---- 상세 ----
const KIND_BADGE = {
  kma: `<span class="badge">기상청 단기예보</span>`,
  short: `<span class="badge">일기예보</span>`,
  long: `<span class="badge warn">장기 예측 · 정확도 낮음</span>`,
  normal: `<span class="badge warn">평년값 (과거 10년 평균)</span>`,
};
const KIND_NOTE = {
  long: "2주 이후는 ECMWF 계절 예측 여러 개의 평균이에요. 날씨 경향만 참고하세요.",
  normal: "장기 예측을 불러오지 못해 최근 10년 같은 날짜의 평균을 보여줘요.",
};

function openDetail(d, i) {
  const [icon, desc] = describe(d);
  const w = "일월화수목금토"[parseISO(d.date).getUTCDay()];
  const when = i === 0 ? "오늘" : i === 1 ? "내일" : `${i}일 뒤`;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const rows = [
    row("최고 기온", `<span class="hi">${fmtT(d.tmax)}</span>`),
    row("최저 기온", `<span class="lo">${fmtT(d.tmin)}</span>`),
    row("비 올 확률", fmtPct(d.rainChance)),
    row(d.kind === "short" ? "강수량" : "예상 강수량", fmtMM(d.precip)),
  ];
  if (d.kind === "short") {
    rows.push(
      row("최대 풍속", d.wind == null ? "-" : `${d.wind.toFixed(1)}m/s`),
      row("자외선", d.uv == null ? "-" : `${Math.round(d.uv)} ${uvLevel(d.uv)}`),
      row("일출 / 일몰", `${fmtClock(d.sunrise)} / ${fmtClock(d.sunset)}`),
    );
  }
  const threeHourly = (d.hourly || []).filter((x) => Number(x.time.slice(11, 13)) % 3 === 0);

  $("detail-body").innerHTML = `
    <h3>${formatKo(d.date)} (${w})</h3>
    <div>${KIND_BADGE[d.src || d.kind]} <span class="source">${when}</span></div>
    <div class="hero"><span class="big-icon">${icon}</span><span class="desc">${desc}</span></div>
    <dl>${rows.join("")}</dl>
    ${threeHourly.length ? `<h3 style="margin-top:16px;font-size:1rem">시간별</h3><div class="hourly">${hourlyStrip(threeHourly)}</div>` : ""}
    ${KIND_NOTE[d.kind] ? `<p class="note">${KIND_NOTE[d.kind]}</p>` : ""}`;
  $("detail").showModal();
}

$("detail-close").addEventListener("click", () => $("detail").close());
// 바깥(배경) 누르면 닫기
$("detail").addEventListener("click", (e) => { if (e.target === $("detail")) $("detail").close(); });

// ---- 불러오기 ----
async function loadForecast(place) {
  $("forecast").hidden = true;
  setStatus(`${placeLabel(place)}의 날씨를 불러오는 중…`);

  let short = { days: [], current: null, hourly: [] };
  const [om, kma] = await Promise.allSettled([shortForecast(place), kmaForecast(place)]);
  if (om.status === "fulfilled") short = om.value;
  else console.warn("단기 예보 실패:", om.reason);
  if (kma.status === "rejected") console.warn("기상청 예보 실패:", kma.reason);
  const usedKMA = kma.status === "fulfilled" && applyKMA(short, kma.value);
  const kmaFailed = !!KMA_PROXY_URL && isKorea(place) && !usedKMA;
  const sd = short.days;
  const start = sd.length ? sd[0].date : todayISO();
  const end = addDays(start, TOTAL_DAYS - 1);
  const longStart = sd.length ? addDays(sd[sd.length - 1].date, 1) : start;

  let long = [];
  try {
    long = await seasonalForecast(place, longStart, end);
  } catch (e) {
    console.warn("계절 예측 실패, 평년값으로 대체:", e);
    try {
      long = await climateNormals(place, longStart, end);
    } catch (e2) {
      console.warn("평년값 실패:", e2);
    }
  }

  const days = [...sd, ...long];
  if (!days.length) {
    setStatus("날씨 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", true);
    return;
  }

  $("place-name").textContent = placeLabel(place);
  $("source").textContent = `${formatKo(days[0].date)} ~ ${formatKo(days[days.length - 1].date)}`
    + (usedKMA ? " · 3일까지 기상청 단기예보" : "")
    + (kmaFailed ? " · 기상청 예보를 불러오지 못해 Open-Meteo로 표시" : "");
  renderToday(sd[0], short.current, short.hourly);
  renderMonth(days);
  selectTab(short.current ? "today" : "month");
  $("forecast").hidden = false;
  setStatus(long.length ? "" : "16일 이후 장기 예측은 불러오지 못했습니다.", !long.length);
}

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("query").value.trim();
  if (!q) return;
  $("forecast").hidden = true;
  setStatus("장소를 찾는 중…");
  try {
    const places = await searchPlaces(q);
    if (!places.length) { showResults([]); setStatus("검색 결과가 없습니다. 다른 이름으로 검색해 보세요.", true); return; }
    if (places.length === 1) { showResults([]); loadForecast(places[0]); return; }
    showResults(places);
    setStatus("장소를 선택하세요.");
  } catch (err) {
    setStatus(`장소 검색 실패: ${err.message}`, true);
  }
});
