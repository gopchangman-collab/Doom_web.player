#!/usr/bin/env bash
# Builds the browser version of DOOM into dist/.
# Needs the Emscripten SDK (emcc) on PATH:  source <emsdk>/emsdk_env.sh
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p dist/wads
SRC=$(ls src/*.c)

${EMCC:-emcc} $SRC -o dist/doom.js \
  -O2 -std=gnu89 -DNORMALUNIX -fno-strict-aliasing \
  -Wno-everything \
  -sMODULARIZE=1 -sEXPORT_NAME=createDoom \
  -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=65536 \
  -sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1MB \
  -sENVIRONMENT=web -sFORCE_FILESYSTEM=1 -lidbfs.js \
  -sEXPORTED_RUNTIME_METHODS=FS,IDBFS,ENV,HEAPU8,HEAP32,addRunDependency,removeRunDependency,UTF8ToString \
  -sEXPORTED_FUNCTIONS=_main,_web_menu_state

cp web/index.html web/doom-shell.js dist/
echo "Built dist/ — put an IWAD (doom1.wad, doom.wad, doom2.wad, freedoom1.wad...) in dist/wads/ or pick one in the page."
