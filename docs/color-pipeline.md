# 뷰포트 색 공간과 GT7 톤매핑

Lambert와 Toon은 같은 색 관리 파이프라인을 사용합니다.

```text
컬러 입력(sRGB) → Linear Rec.709 조명·재질 계산
                         ↓
                  RGBA16F 선형 버퍼
                  투명도·그림자 합성 및 MSAA
                         ↓
                  GT7 SDR 색 볼륨 매핑
                         ↓
                  sRGB 출력 변환 → 화면
```

작업 공간은 Linear-sRGB(Linear Rec.709)입니다. 언리얼의 기본 sRGB/Rec.709 작업 색역과 같은 원색 및 백색점을 사용합니다. sRGB 화면 출력은 선형 조명 계산과 별개입니다. [Epic의 작업 색 공간 설명](https://dev.epicgames.com/documentation/en-us/unreal-engine/working-color-space-in-unreal-engine).

PMX 컬러 텍스처와 컬러 입력은 sRGB에서 선형으로 변환합니다. 다른 모델 형식은 해당 three.js 로더가 해석한 색 공간 정보를 유지합니다. 노멀·마스크·깊이·Toon 명암 LUT 같은 데이터는 sRGB 변환을 적용하지 않습니다. 변환용 원본 데이터와 내보내기에는 뷰포트 톤매핑을 적용하지 않습니다.

화면에 바로 그리던 경로를 RGBA16F 중간 버퍼로 변경했습니다. 조명 결과가 1을 넘더라도 최종 출력 전까지 보존하며, 투명도와 바닥 그림자를 선형 공간에서 합성합니다. 예를 들어 검은 배경 위에 50% 불투명도의 흰색을 합성하면 선형 0.5가 됩니다. MSAA는 중간 버퍼에서 최대 4샘플을 사용하고, 화면 크기와 DPI에 맞춰 버퍼 크기를 갱신합니다.

## GT7 SDR 설정

[Polyphony Digital의 SIGGRAPH 2025 발표](https://www.polyphony.co.jp/publications/)와 공개 참조식에 기반한 GT7 Color Volume Mapping을 사용합니다. 이전 GT/Uchimura의 RGB별 곡선만 적용하는 방식과는 다릅니다. 참조 구현은 [Google Filament의 GT7ToneMapper](https://github.com/google/filament/blob/main/filament/src/ToneMapper.cpp)에서도 확인할 수 있습니다.

| 항목 | 값 |
| --- | --- |
| 선형 입력 1.0의 기준 휘도 | 100 cd/m² |
| SDR 대상 휘도 | 250 cd/m² |
| SDR 출력 보정 | 0.4 |
| Alpha / Gray point | 0.25 / 0.538 |
| Linear section / Toe strength | 0.444 / 1.280 |
| 색 복원 혼합 비율 | 0.6 |
| Chroma fade 시작 / 끝 | 0.98 / 1.16 |

입력 Linear Rec.709를 Rec.2020으로 변환하고, ICtCp에서 명도와 색도를 분리해 하이라이트 채도를 조정합니다. 결과는 SDR Rec.709 범위로 제한한 후 sRGB로 한 번만 인코딩합니다. 내부 PQ 계산은 지각 색 공간 변환용이며, HDR 디스플레이 출력 모드를 뜻하지 않습니다. 현재 출력은 SDR이며 자동 노출·블룸은 추가하지 않았습니다.

Three.js의 `renderer.toneMapping`은 `NoToneMapping`으로 두어 재질 단계의 중복 적용을 막습니다. 실제 GT7 연산은 마지막 전체 화면 패스에서 수행합니다. 따라서 개별 재질의 `toneMapped` 속성과 관계없이 최종 뷰포트에 적용됩니다. Toon의 두 명암 단계는 유지되며, 원본 텍스처 변화와 부드러운 그림자 경계는 그대로 반영합니다.

GT7 참조 구현의 [MIT 고지](../licenses/GT7-MIT.txt)는 앱 패키지에도 포함합니다. GLSL은 [gt7-tonemapping.js](../renderer/gt7-tonemapping.js), 선형 버퍼와 출력 패스는 [color-pipeline.js](../renderer/color-pipeline.js)에 있습니다.

## 검증

`npm test` 후 `npm run test:ui`를 실행합니다. 실제 WebGL에서 다음을 확인합니다.

- sRGB 128 입력이 선형 약 0.21586으로 디코딩되며, 데이터 128은 약 0.50196으로 유지됩니다.
- 투명 합성 결과가 선형 0.5이고, 불투명 선형 0.5와 같은 최종 출력을 만듭니다.
- 1을 넘는 HDR 값이 중간 버퍼에 보존됩니다.
- 흑색·중간 회색·원색·고휘도·최대 half-float 값 등 21개 샘플을 참조식으로 계산한 결과와 비교합니다. GPU 차이를 고려한 허용 오차는 최종 8비트 채널당 2입니다.
- 리사이즈·DPI, PMX/FBX, Toon 두 톤과 그림자 합성을 확인합니다.
