# 기상청 예보 연결 방법

웹사이트는 누구나 코드를 볼 수 있어서 기상청 인증키를 직접 넣으면 안 됩니다.
그래서 키를 숨겨 두는 작은 무료 서버(Cloudflare Worker)를 하나 만들고, 사이트는 그 서버를 거쳐 기상청 예보를 가져옵니다.

```
내 사이트 → Cloudflare Worker (인증키 보관) → 기상청 API
```

컴퓨터에서 하는 걸 추천합니다. 전체 15분 정도 걸립니다.

## 1. 기상청 인증키 받기 (공공데이터포털)

1. https://www.data.go.kr 에 가입/로그인합니다.
2. 검색창에 **기상청_단기예보** 를 검색하고 **「기상청_단기예보 ((구)_동네예보) 조회서비스」** 에서 **활용신청** 을 누릅니다.
   - 활용목적: 웹 사이트 개발 / 내용: 개인 날씨 웹사이트
3. **마이페이지 → 데이터 활용 → Open API → 활용신청 현황** 에서 신청한 서비스를 누르고
   **일반 인증키 (Decoding)** 를 복사해 둡니다.
   - 신청 직후에는 키가 작동하기까지 1시간 정도 걸릴 수 있습니다.

## 2. Cloudflare Worker 만들기

1. https://dash.cloudflare.com/sign-up 에서 무료로 가입합니다. (카드 등록 필요 없음)
2. 왼쪽 메뉴에서 **Workers & Pages** (또는 **Compute → Workers & Pages**) 로 갑니다.
3. **Create** (만들기) → **Hello World** 로 시작 → 이름을 `kma-proxy` 로 적고 **Deploy** 를 누릅니다.
4. 만들어지면 **Edit code** (코드 편집) 를 누릅니다.
5. 왼쪽 코드 편집기의 내용을 **전부 지우고**, 아래 파일 내용을 전부 복사해서 붙여넣습니다.
   - https://raw.githubusercontent.com/MJ97328/weather/master/worker/kma-proxy.js
6. 오른쪽 위 **Deploy** 를 누릅니다.

## 3. 인증키를 비밀값으로 넣기

1. 방금 만든 `kma-proxy` 의 **Settings** (설정) → **Variables and Secrets** (변수 및 비밀) 로 갑니다.
2. **Add** (추가) 를 누르고
   - Type: **Secret** (비밀)
   - Variable name: `KMA_KEY`
   - Value: 1번에서 복사한 **일반 인증키 (Decoding)**
3. **Deploy** (또는 Save) 를 누릅니다.

## 4. 동작 확인

Worker 주소(예: `https://kma-proxy.아이디.workers.dev`) 뒤에 `?lat=37.56&lon=126.97` 를 붙여 브라우저로 열어 봅니다.

- `"days":[{"date":...` 처럼 숫자가 잔뜩 나오면 성공입니다.
- `SERVICE_KEY_IS_NOT_REGISTERED_ERROR` 가 나오면 키가 아직 활성화되지 않은 것입니다. 1시간 정도 뒤에 다시 해 보세요.
- `KMA_KEY 비밀값이 설정되지 않았습니다` 가 나오면 3번을 다시 확인하세요.

## 5. 사이트에 연결

Worker 주소를 알려 주면 `app.js` 의 `KMA_PROXY_URL` 에 넣어 배포합니다.
(Worker 주소는 공개돼도 괜찮습니다. 인증키는 Cloudflare 안에만 있습니다.)

## 동작 방식

- 한국 안의 장소만 기상청 예보를 씁니다. 해외는 기존처럼 Open-Meteo를 씁니다.
- **오늘 ~ 약 3일 뒤**: 기상청 단기예보 (기온, 하늘상태, 비/눈, 강수확률, 강수량)와 초단기실황(지금 기온·습도·바람)
- 그 이후: 기존과 같습니다 (15일까지 Open-Meteo 예보, 이후 장기 예측).
- 기상청 호출이 실패하면 자동으로 Open-Meteo 값으로 보여주고, 화면에 그 사실을 표시합니다.
- 사이트에서 부를 수 있는 주소는 `https://mj97328.github.io` 로 제한되어 있습니다 (`ALLOWED_ORIGINS`).
