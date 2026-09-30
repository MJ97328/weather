// 한 달 뒤 날씨 — Open-Meteo API (API 키 불필요)
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"; // 한글 지명 검색 대체용
const SEASONAL_URL = "https://seasonal-api.open-meteo.com/v1/seasonal";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

const DAILY_VARS = ["temperature_2m_max", "temperature_2m_min", "precipitation_sum"];
const WINDOW = 3; // 목표 날짜 전후로 보여줄 일수
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
function formatKo(s) {
  const d = parseISO(s);
  const w = "일월화수목금토"[d.getUTCDay()];
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${w})`;
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

// ---- 2) 계절 예측(앙상블) ----
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
      tmax: mean(tmax),
      tmin: mean(tmin),
      precip: prcp.length ? mean(prcp) : null,
      rainChance: prcp.length ? prcp.filter((p) => p >= RAIN_MM).length / prcp.length : null,
    });
  });
  if (!out.length) throw new Error("해당 기간 예측 없음");
  return out;
}

// ---- 3) 대체: 과거 10년 같은 날짜의 평년값 ----
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
function describe(day) {
  const chance = day.rainChance ?? 0;
  const precip = day.precip ?? 0;
  const snowy = day.tmax <= 1;
  if (chance >= 0.6 || precip >= 10) return snowy ? ["❄️", "눈 가능성 높음"] : ["🌧️", "비 가능성 높음"];
  if (chance >= 0.35 || precip >= 2) return snowy ? ["🌨️", "눈 올 수도 있음"] : ["🌦️", "비 올 수도 있음"];
  if (chance >= 0.15 || precip >= 0.5) return ["⛅", "구름 많음"];
  return ["☀️", "대체로 맑음"];
}

const fmtT = (t) => `${Math.round(t)}°`;
const fmtP = (p) => (p == null ? "-" : `${p.toFixed(1)}mm`);
const fmtChance = (c) => (c == null ? "" : ` · 비 올 확률 ${Math.round(c * 100)}%`);

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

function render(place, target, days, sourceText) {
  $("place-name").textContent = placeLabel(place);
  $("source").textContent = sourceText;

  const t = days.find((d) => d.date === target) || days[Math.floor(days.length / 2)];
  const [icon, desc] = describe(t);
  $("target-card").innerHTML = `
    <div class="icon">${icon}</div>
    <div>
      <div class="date">${formatKo(t.date)} · ${diffDays(todayISO(), t.date)}일 뒤</div>
      <div class="desc">${desc}</div>
      <div class="temps"><span class="hi">최고 ${fmtT(t.tmax)}</span> / <span class="lo">최저 ${fmtT(t.tmin)}</span></div>
      <div class="date">강수량 ${fmtP(t.precip)}${fmtChance(t.rainChance)}</div>
    </div>`;

  $("days").innerHTML = days.map((d) => {
    const [ic, ds] = describe(d);
    return `<tr class="${d.date === t.date ? "target" : ""}">
      <td>${formatKo(d.date)}</td><td>${ic} ${ds}</td>
      <td class="hi">${fmtT(d.tmax)}</td><td class="lo">${fmtT(d.tmin)}</td><td>${fmtP(d.precip)}</td>
    </tr>`;
  }).join("");

  $("forecast").hidden = false;
}

async function loadForecast(place) {
  const target = $("target-date").value || addDays(todayISO(), 30);
  const start = addDays(target, -WINDOW);
  const end = addDays(target, WINDOW);
  $("forecast").hidden = true;
  setStatus(`${placeLabel(place)}의 ${formatKo(target)} 날씨를 예측하는 중…`);

  try {
    const days = await seasonalForecast(place, start, end);
    render(place, target, days, "ECMWF 계절 예측 앙상블 평균 (Open-Meteo Seasonal API)");
    setStatus("");
  } catch (e) {
    console.warn("계절 예측 실패, 평년값으로 대체:", e);
    try {
      const days = await climateNormals(place, start, end);
      render(place, target, days, `최근 ${CLIMATE_YEARS}년 같은 날짜의 평균 (Open-Meteo Historical API) — 계절 예측을 불러오지 못해 평년값으로 표시`);
      setStatus("");
    } catch (e2) {
      setStatus(`날씨 정보를 불러오지 못했습니다: ${e2.message}`, true);
    }
  }
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

// 기본 날짜: 오늘부터 30일 뒤 (선택 범위: 내일 ~ 180일 뒤)
(() => {
  const input = $("target-date");
  input.min = addDays(todayISO(), 1);
  input.max = addDays(todayISO(), 180);
  input.value = addDays(todayISO(), 30);
})();
