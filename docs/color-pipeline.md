# 뷰포트 색 공간과 GT7 톤매핑

Lambert와 Toon은 같은 색 관리 파이프라인을 사용합니다.

```text
컬러 입력(sRGB) → Linear Rec.709 조명·재질 계산
                         ↓
                  RGBA16F 선형 버퍼
                  투명도·그림자 합성 및 MSAA
                         ↓
                  EV100 수동 노출 + 보정
                         ↓
                  GT7 SDR 색 볼륨 매핑
                         ↓
                  sRGB 출력 변환 → 화면
```

작업 공간은 Linear-sRGB(Linear Rec.709)입니다. 언리얼의 기본 sRGB/Rec.709 작업 색역과 같은 원색 및 백색점을 사용합니다. sRGB 화면 출력은 선형 조명 계산과 별개입니다. [Epic의 작업 색 공간 설명](https://dev.epicgames.com/documentation/en-us/unreal-engine/working-color-space-in-unreal-engine).

PMX 컬러 텍스처와 컬러 입력은 sRGB에서 선형으로 변환합니다. 다른 모델 형식은 해당 three.js 로더가 해석한 색 공간 정보를 유지합니다. 노멀·마스크·깊이·Toon 명암 LUT 같은 데이터는 sRGB 변환을 적용하지 않습니다. 변환용 원본 데이터와 내보내기에는 뷰포트 톤매핑을 적용하지 않습니다.

화면에 바로 그리던 경로를 RGBA16F 중간 버퍼로 변경했습니다. 조명 결과가 1을 넘더라도 최종 출력 전까지 보존하며, 투명도와 바닥 그림자를 선형 공간에서 합성합니다. 예를 들어 검은 배경 위에 50% 불투명도의 흰색을 합성하면 선형 0.5가 됩니다. MSAA는 중간 버퍼에서 최대 4샘플을 사용하고, 화면 크기와 DPI에 맞춰 버퍼 크기를 갱신합니다.

## 방향광의 물리 단위와 Lambert

방향광은 언리얼과 같은 Direct Normal Illuminance, 즉 광선에 수직인 면에 입사하는 조도를 **lux**로 입력합니다. 기본값과 슬라이더 더블클릭 초기화 값은 **10 lux**입니다. 숫자 입력은 0–200,000 lux를 지원합니다. [Epic의 물리 조명 단위 설명](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-physical-lighting-units-in-unreal-engine).

Lambert 확산항은 다음 식을 사용합니다. 이는 언리얼의 Lambert 확산 BRDF와 같은 `반사율 / π` 정규화입니다. 언리얼의 전체 Default Lit 모델에 포함되는 스페큘러·GI·노출까지 재현한다는 의미는 아닙니다.

```text
E = directionalLux × max(dot(N, L), 0) × shadowVisibility
L_o = diffuseReflectance × E / π                [cd/m²]
framebufferRGB = (L_o + L_emissive) / 100         [정규화된 선형 저장값]
```

방향광 유니폼에는 UI의 실제 lux 값이 그대로 전달됩니다. 셰이더가 BRDF와 입사각을 계산한 후, 결과 휘도를 GT7의 `1.0 = 100 cd/m²` 규약으로 변환합니다. 이 `/100`은 단위 인코딩이며 광량을 임의로 조정하는 배율이 아닙니다.

6 lux에서 정면 흰색 면의 직접광 휘도는 약 1.9099 cd/m²이고, 선형 반사율 0.18인 회색 면은 약 0.3438 cd/m²입니다. 조도를 두 배로 올리면 톤매핑 전 휘도도 두 배가 되며, 방향광에는 거리 감쇠가 없습니다. 화면 밝기는 아래의 수동 노출 설정으로 조정합니다.

기존의 반구 보조광·환경광과 모드/그림자 상태에 따른 임의 광량 배율은 제거했습니다. Toon은 같은 lux 입력과 `/π` 단위를 사용하지만 입사각 명암을 두 단계로 바꾸는 스타일화된 모델입니다.

워크스페이스는 `viewport.lightUnit: "lux"`와 `lightIntensity`를 함께 저장합니다. 이전 단위 없는 0–3 배율은 `이전 값 × 6 lux`로 한 번만 마이그레이션합니다. 이는 기본값 100%를 6 lux로 대응시키는 것으로, 이전의 비물리적 화면 밝기를 그대로 복제하지는 않습니다. 로컬 조명 환경설정에도 같은 규칙을 적용합니다.

## EV100 수동 노출

뷰포트 왼쪽의 **EV100**과 **보정 EV**로 조절합니다. 기본값과 초기화 값은 각각 **0 / 0**입니다. EV100 범위는 -10–24, 보정 범위는 -10–10 EV입니다. EV100을 1 높이면 밝기가 절반이 되고, 보정을 +1 EV 높이면 두 배가 됩니다. lux와 재질의 물리 휘도는 바꾸지 않습니다.

```text
exposure = 2^(compensation - EV100)
B = framebufferRGB × 100 × exposure
display = sRGB(GT7(B))
```

HDR 버퍼는 `L / 100`을 저장하므로, 노출 패스에서 100을 곱해 물리 휘도를 복원합니다. 이어서 언리얼의 수동 노출 관계식 `B = Exposure × L`을 적용합니다. 보정은 양수가 밝아지는 방향입니다. [Epic의 수동 노출 설명](https://dev.epicgames.com/documentation/en-us/unreal-engine/auto-exposure-in-unreal-engine).

GT7은 투명도·그림자·발광 합성 이후의 노출된 RGB에 한 번만 적용합니다. `renderer.toneMappingExposure`에 의존하지 않고 실제 출력 셰이더의 노출 유니폼으로 제어합니다. 자동 노출·눈 적응은 사용하지 않습니다. 편집용 단색 배경·그리드·기즈모·본·아웃라인에는 반대 배율을 적용해 일반적인 노출 범위에서 선택한 색을 유지합니다. 극단적인 노출 조합에서는 half-float 저장 범위에 제한됩니다.

설정은 로컬 환경설정과 `.canvas`의 `viewport.exposure: { ev100, compensation }`에 저장합니다. 노출 항목이 없는 기존 작업 파일에는 EV100 `log2(100) ≈ 6.643856`, 보정 0을 적용해 이전의 노출 배율 1을 유지합니다. 신규 작업은 EV100 0에서 시작합니다.

## 발광의 cd/m² 단위

머티리얼 패널의 **발광 기준 휘도**는 흰색 발광에 대한 기준값이며 0–1,000,000 cd/m² 범위입니다. 실제 픽셀은 선형 발광 색상과 디코딩된 발광 텍스처를 곱합니다. 검은색 발광은 기준 휘도를 높여도 빛나지 않습니다.

```text
emissiveRGB_nits = emissiveColor_linear × emissiveMap_linear × emissiveReferenceNits
L_emissive = dot(emissiveRGB_nits, Rec.709 luminance coefficients)
```

발광은 `/100`으로 직접광과 같은 HDR 저장 단위에 맞춘 뒤 합성합니다. 노출과 GT7은 그 합계에 적용합니다. Lambert/Toon 전환이나 그림자 유무는 발광 자체의 휘도를 바꾸지 않습니다. 발광이 주변 물체를 비추는 GI나 블룸 효과는 추가하지 않았습니다.

모델 형식들의 원본 발광 배율에는 공통된 절대 단위가 없습니다. 가져온 값은 기존 뷰포트 해석을 유지하도록 **원본 흰색 발광 값 1 = 100 cd/m²**로 환산합니다. 이 값은 측정된 물리 휘도라는 뜻이 아닙니다. 실제 값을 알고 있다면 패널에서 지정하세요. 원본 발광 배율은 별도로 표시하며, ↺ 버튼으로 기본 환산값을 복원합니다.

뷰포트는 별도 재질 인스턴스로 물리 발광을 적용하므로 원본 재질과 내보내기 값은 보존합니다. `.canvas`는 재질별 `emissiveNits`에 사용자 지정 값을 저장하고, `null`은 원본 환산값 사용을 뜻합니다. 사용자 정의 ShaderMaterial은 자체 셰이더 규약을 유지합니다.

## GT7 SDR 설정

[Polyphony Digital의 SIGGRAPH 2025 발표](https://www.polyphony.co.jp/publications/)와 공개 참조식에 기반한 GT7 Color Volume Mapping을 사용합니다. 이전 GT/Uchimura의 RGB별 곡선만 적용하는 방식과는 다릅니다. 참조 구현은 [Google Filament의 GT7ToneMapper](https://github.com/google/filament/blob/main/filament/src/ToneMapper.cpp)에서도 확인할 수 있습니다.

| 항목 | 값 |
| --- | --- |
| GT7 내부 선형 입력 1.0의 기준 휘도 | 100 cd/m² (카메라 노출 이후) |
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
- 6 lux에서 Lambert 흰색·18% 회색의 휘도, 광량 선형성, 입사각 코사인, 방향광의 거리 독립성, 0 lux를 확인합니다.
- EV100 1단계와 보정 1단계의 상쇄, 노출과 물리 휘도의 분리, 발광+직접광 합산, sRGB 발광 텍스처, 모드별 발광, 원본 보존, 편집 도구 색상 유지를 확인합니다.
- 네 언어와 영어 폴백에서 노출·발광 설정의 작업 저장/복원을 검증합니다.
