# 웹 글꼴

화면·캔버스에 쓰는 한글 글꼴을 저장소에 넣어 외부 서버(Google Fonts)에 의존하지 않는다.

| 글꼴 | 출처 | 굵기 | 라이선스 |
|---|---|---|---|
| Noto Sans KR (가변) | npm `@fontsource-variable/noto-sans-kr` 5.3.1 (Google Fonts v40) | 100–900 | SIL Open Font License 1.1 (`OFL.txt`) |
| Noto Serif KR (가변) | npm `@fontsource-variable/noto-serif-kr` 5.3.1 | 200–900 | SIL Open Font License 1.1 (`OFL.txt`) |

- 저작권: Google Inc. (Noto 프로젝트). 글꼴 파일은 패키지의 woff2를 고치지 않고 옮겼다.
- `fonts.css`는 패키지의 `index.css`에서 family 이름을 `Noto Sans KR`·`Noto Serif KR`로 바꾸고 파일 경로만 고쳤다.
  Google Fonts와 같은 유니코드 구간 분할이라, 화면에 나오는 글자가 속한 파일만 내려받는다.
- 갱신: 새 버전 패키지를 받아 `files/*.woff2`와 `index.css`를 같은 방식으로 옮긴다.
