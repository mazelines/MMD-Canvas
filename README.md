# MMD Converter

PMX(MMD) 모델을 **FBX / USD**로 변환하는 기능을 갖춘 3D 파일 뷰어 · 브라우저 · 컨버터.

## 실행

```bash
npm install
npm start                 # 뷰어 / 브라우저 / 변환 GUI
npm start -- model.pmx    # 파일을 지정해 바로 열기
npm test                  # 코어 테스트 (node tests/run-tests.js --blender 로 Blender 임포트 검증 추가)
```

## 명령줄 변환

```bash
node cli.js model.pmx                      # model.fbx
node cli.js model.pmx -o out/model.usda    # 확장자로 형식 결정 (.fbx / .usda / .usd / .usdz)
node cli.js models/ -o out/ -f usdz -r     # 폴더 일괄 변환 (하위 폴더 포함)
node cli.js model.pmx -n english -s 8      # 영어 이름, 스케일 8 (기본)
node cli.js info model.pmx                 # 모델 정보
```

## 변환 내용

| 항목 | FBX (binary 7.4) | USD (.usda / .usdz) |
| --- | --- | --- |
| 메시 · 노멀 · UV | ✔ | ✔ |
| 재질 · 디퓨즈 텍스처 | ✔ (phong) | ✔ (UsdPreviewSurface, GeomSubset) |
| 본 · 스킨 가중치 | ✔ (Skin / Cluster / BindPose) | ✔ (UsdSkel) |
| 정점 모프 (+ 정점 모프로만 된 그룹 모프) | ✔ (BlendShape) | ✔ (BlendShape) |
| 물리 · IK · 본/UV/재질 모프 · 스피어/툰 | ✘ | ✘ |

- 좌표계: 왼손 → 오른손 Y-up (Z 반전, 면 방향 반전), UV V 반전.
- 스케일: 기본 8 (1 MMD 단위 = 8cm, 출력 단위 cm).
- SDEF / QDEF 정점은 선형 스키닝(BDEF2 / BDEF4)으로 변환.
- 텍스처는 `<출력이름>_textures/` 로 복사 (USDZ는 패키지에 포함). 실제로 투명 픽셀이 있는 텍스처만 알파 재질로 연결.
- PMD(구버전)는 지원하지 않음 — PMX Editor에서 PMX로 저장 후 사용.

## 뷰어

PMX · FBX · glTF/GLB · OBJ · STL · PLY · DAE · 3MF · USD(usdz/usda/usdc) 표시.
파일 목록에서 ↑/↓ 로 연속 미리보기, Enter 폴더 진입, Backspace 상위 폴더, F 맞춰 보기, Ctrl+O 열기, Ctrl+E 변환, F12 개발자 도구.

## 구조

```
src/core/   pmx-parser · scene(정규화) · fbx-writer · usd-writer · convert(파일 파이프라인)
electron/   메인 프로세스, preload
renderer/   UI, three.js 뷰어
cli.js      명령줄 변환기
tests/      합성 PMX 생성기 + 테스트
```
