# DOOM Web

id Software의 `linuxdoom-1.10` 소스를 Emscripten으로 WebAssembly로 컴파일한 브라우저용 DOOM이에요.

## 실행

```
cd doom-web/dist
python -m http.server 8123 --bind 0.0.0.0
```

- PC: http://localhost:8123
- iPad / 다른 기기: 같은 네트워크에서 `http://<이 PC의 IP>:8123`
  (Windows 방화벽이 Python 접속을 막으면 허용해야 해요.)

`index.html`을 더블클릭해서 바로 열면 동작하지 않아요. 브라우저가 `file://`로 wasm과 WAD를 불러오는 걸 막기 때문에 반드시 웹 서버로 열어야 해요.

## WAD (게임 데이터)

- 기본: `dist/wads/freedoom1.wad` (Freedoom, 무료 · BSD 라이선스)
- `DOOM.WAD`, `DOOM2.WAD`, `DOOM1.WAD`(셰어웨어)를 갖고 있다면 `dist/wads/`에 넣거나 시작 화면에서 직접 선택하세요.
  `doom2.wad` → `doomu.wad` → `doom.wad` → `doom1.wad` → `freedoom1.wad` 순서로 먼저 찾은 파일을 써요.

## 빌드

```
export EMSDK=/c/Users/OWNER/emsdk
export PATH="$EMSDK/upstream/emscripten:$EMSDK/node/24.19.0_64bit:$EMSDK/python/3.13.3_64bit:$PATH"
export EM_CONFIG="C:/Users/OWNER/emsdk/.emscripten"
EMCC=emcc.exe bash build.sh
```

## 구조

- `src/`: linuxdoom-1.10 복사본 (원본 `DOOM-master/`는 수정하지 않음)
  - `i_web.c`: 새로 작성한 브라우저 플랫폼 계층 (X11 화면, OSS 사운드, UDP 네트워크 대체)
  - 수정한 파일: `d_main.c`, `d_net.c` (브라우저에 제어권 양보), `g_game.c` (WASD, 무기 순환, 마우스 Y축 이동 끔),
    `m_misc.c` (기본 키 설정), `m_menu.c` (마우스로 메뉴가 움직이지 않게), `r_*.c/h` (렌더링 한계치 확장), `w_wad.c` (`strupr` 이름 충돌)
- `web/`: 페이지와 JS 셸 (입력, 게임패드, 효과음, MUS 음악 신시사이저, 세이브 저장)
- `dist/`: 빌드 결과물 (이 폴더만 웹에 올리면 됨)
