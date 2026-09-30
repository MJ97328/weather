# 한 달 날씨

장소를 검색하면 두 탭으로 날씨를 보여주는 웹 앱입니다.

- **오늘**: 현재 기온·날씨, 체감온도, 습도, 바람, 자외선, 일출/일몰, 24시간 시간별 날씨
- **한 달**: 오늘부터 30일 뒤까지 달력. 날짜를 누르면 그날의 상세 정보(15일 뒤까지는 3시간 간격 시간별 날씨 포함)

## 실행

빌드 과정 없이 `index.html`을 브라우저로 열면 됩니다. 로컬 서버로 띄우려면:

```sh
python3 -m http.server 8000   # http://localhost:8000
```

## 사용하는 API (모두 무료, API 키 불필요)

| 용도 | API |
| --- | --- |
| 장소 검색 → 위도/경도 | [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api), 결과가 없으면(한글 지명 등) [OpenStreetMap Nominatim](https://nominatim.org/release-docs/latest/api/Search/) |
| 오늘 ~ 15일 뒤 | [Open-Meteo Forecast API](https://open-meteo.com/en/docs) (일반 일기예보, 한국은 [기상청 KMA 모델](https://open-meteo.com/en/docs/kma-api) 우선) |
| 16일 ~ 30일 뒤 | [Open-Meteo Seasonal Forecast API](https://open-meteo.com/en/docs/seasonal-forecast-api) (ECMWF 앙상블 멤버 평균) |
| 대체(계절 예측 실패 시) | [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) — 최근 10년 같은 날짜 평균 |

비 올 확률은 앙상블 멤버(또는 과거 연도) 중 강수량 1mm 이상인 비율입니다.
한 달 뒤 예보는 불확실성이 크므로 참고용으로 사용하세요.

## 배포

`master`에 push하면 GitHub Actions(`.github/workflows/pages.yml`)가 GitHub Pages로 자동 배포합니다.
주소: https://mj97328.github.io/weather/
