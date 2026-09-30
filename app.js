// 오늘부터 한 달 뒤까지 날씨 — Open-Meteo API (API 키 불필요)
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"; // 한글 지명 검색 대체용
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
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
// Open-Meteo 지오코딩은 "서울" 같은 한글 이름을 잘 못 찾으므로,
// 결과가 없으면 OpenStreetMap Nominatim으로 다시 검색한다.
async function searchPlaces(name) {
  let results = [];
  try {
    const data = await getJSON(GEOCODING_URL, { name, count: 8, language: "ko", format: "json" });
    results = data.results || [];
  } catch (e) {
    console.warn("Open-Meteo 지오코딩 실패:", e);
  }
  return results.length ? results : searchNominatim(name);
}

async function searchNominatim(q) {
  const res = await fetch(`${NOMINATIM_URL}?${new URLSearchParams({
    q, format: "jsonv2", addressdetails: 1, limit: 8, "accept-language": "ko",
  })}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => {
    const a = r.address || {};
    return {
      name: r.name || r.display_name.split(",")[0],
      latitude: Number(r.lat),
      longitude: Number(r.lon),
      admin1: a.state || a.province || a.city || "",
      country: a.country || "",
    };
  });
}

// ---- 2) 단기 예보 (오늘 ~ 16일) ----
async function shortForecast(place) {
  const data = await getJSON(FORECAST_URL, {
    latitude: place.latitude,
    longitude: place.longitude,
    daily: ["weather_code", ...DAILY_VARS, "precipitation_probability_max"].join(","),
    forecast_days: SHORT_DAYS,
    timezone: "auto",
  });
  const d = data.daily;
  return d.time.map((date, i) => ({
    date,
    kind: "short",
    code: d.weather_code[i],
    tmax: d.temperature_2m_max[i],
    tmin: d.temperature_2m_min[i],
    precip: d.precipitation_sum[i],
    rainChance: d.precipitation_probability_max[i] == null ? null : d.precipitation_probability_max[i] / 100,
  })).filter((x) => x.tmax != null && x.tmin != null);
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

function describe(day) {
  if (day.code != null) {
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

const fmtT = (t) => `${Math.round(t)}°`;
const fmtRain = (d) => {
  const pct = d.rainChance == null ? "" : `${Math.round(d.rainChance * 100)}%`;
  const mm = d.precip == null || d.precip < 0.1 ? "" : `<small>${d.precip.toFixed(1)}mm</small>`;
  return [pct, mm].filter(Boolean).join(" ") || "-";
};

// ---- 화면 ----
function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

function placeLabel(p) {
  return [p.name, p.admin1, p.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
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

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const LONG_LABEL = {
  long: "여기부터 장기 예측 — ECMWF 계절 예측 앙상블 평균, 정확도 낮음",
  normal: "여기부터 평년값 — 최근 10년 같은 날짜 평균 (장기 예측을 불러오지 못함)",
};

function render(place, days) {
  $("place-name").textContent = placeLabel(place);
  $("source").textContent = `${formatKo(days[0].date)} ~ ${formatKo(days[days.length - 1].date)} · ${days.length}일`;

  const rainyDays = days.filter((d) => (d.rainChance ?? 0) >= 0.5 || (d.precip ?? 0) >= 5).length;
  $("summary").innerHTML = `
    <div><span class="label">평균 최고</span><span class="value hi">${fmtT(mean(days.map((d) => d.tmax)))}</span></div>
    <div><span class="label">평균 최저</span><span class="value lo">${fmtT(mean(days.map((d) => d.tmin)))}</span></div>
    <div><span class="label">가장 더운 날</span><span class="value hi">${fmtT(Math.max(...days.map((d) => d.tmax)))}</span></div>
    <div><span class="label">가장 추운 날</span><span class="value lo">${fmtT(Math.min(...days.map((d) => d.tmin)))}</span></div>
    <div><span class="label">비·눈 예상일</span><span class="value">${rainyDays}일</span></div>`;

  let prevKind = null;
  $("days").innerHTML = days.map((d, i) => {
    let sep = "";
    if (d.kind !== prevKind && d.kind !== "short") {
      sep = `<tr class="sep"><td colspan="4">${LONG_LABEL[d.kind]}</td></tr>`;
    }
    prevKind = d.kind;
    const [ic, ds] = describe(d);
    const label = i === 0 ? "오늘" : i === 1 ? "내일" : formatShort(d.date);
    return `${sep}<tr class="${d.kind}">
      <td>${label}</td>
      <td><span class="ic">${ic}</span> ${ds}</td>
      <td><span class="hi">${fmtT(d.tmax)}</span> / <span class="lo">${fmtT(d.tmin)}</span></td>
      <td>${fmtRain(d)}</td>
    </tr>`;
  }).join("");

  $("forecast").hidden = false;
}

async function loadForecast(place) {
  $("forecast").hidden = true;
  setStatus(`${placeLabel(place)}의 한 달 날씨를 불러오는 중…`);

  let short = [];
  try {
    short = await shortForecast(place);
  } catch (e) {
    console.warn("단기 예보 실패:", e);
  }
  const start = short.length ? short[0].date : todayISO();
  const end = addDays(start, TOTAL_DAYS - 1);
  const longStart = short.length ? addDays(short[short.length - 1].date, 1) : start;

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

  const days = [...short, ...long];
  if (!days.length) {
    setStatus("날씨 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", true);
    return;
  }
  render(place, days);
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
