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

모드/그림자 상태에 따른 임의 광량 배율은 사용하지 않습니다. v0.5.0부터 반구 보조광은 주변광 lux 입력으로 별도 제어하며 기본값은 2 lux, 0이면 비활성입니다. 방향광 조도에는 영향을 주지 않습니다. Toon은 같은 lux 입력과 `/π` 단위를 사용하지만 입사각 명암을 두 단계로 바꾸는 스타일화된 모델입니다.

주변광은 `viewport.ambientIntensity`와 로컬 환경설정에 저장합니다. 해당 항목이 없는 기존 작업은 0 lux로 복원합니다. 저장 형식은 버전 2이며 버전 1 읽기를 지원합니다. 이전 앱은 버전 2를 지원하지 않는 형식으로 거부합니다.

워크스페이스는 `viewport.lightUnit: "lux"`와 `lightIntensity`를 함께 저장합니다. 이전 단위 없는 0–3 배율은 `이전 값 × 6 lux`로 한 번만 마이그레이션합니다. 이는 기본값 100%를 6 lux로 대응시키는 것으로, 이전의 비물리적 화면 밝기를 그대로 복제하지는 않습니다. 로컬 조명 환경설정에도 같은 규칙을 적용합니다.

## EV100 수동 노출

뷰포트 왼쪽의 **EV100**과 **보정 EV**로 조절합니다. 기본값과 초기화 값은 각각 **0 / 0**입니다. EV100 범위는 -10–24, 보정 범위는 -10–10 EV입니다. EV100을 1 높이면 밝기가 절반이 되고, 보정을 +1 EV 높이면 두 배가 됩니다. lux와 재질의 물리 휘도는 바꾸지 않습니다.

```text
exposure = 2^(compensation - EV100)
B = framebufferRGB × 100 × exposure
display = sRGB(GT7(B))
```

HDR 버퍼는 `L / 100`을 저장하므로, 노출 패스에서 100을 곱해 물리 휘도를 복원합니다. 이어서 언리얼의 수동 노출 관계식 `B = Exposure × L`을 적용합니다. 보정은 양수가 밝아지는 방향입니다. [Epic의 수동 노출 설명](https://dev.epicgames.com/documentation/en-us/unreal-engine/auto-exposure-in-unreal-engine).

GT7은 투명도·그림자·발광 합성 이후의 노출된 RGB에 한 번만 적용합니다. DX12 출력 컴퓨트 셰이더의 노출 상수로 제어합니다. 자동 노출·눈 적응은 사용하지 않습니다. 배경·그리드·기즈모·본은 편집용 색을 그대로 표시하고, 아웃라인에는 노출·톤매핑의 역변환을 적용합니다. 극단적인 노출 조합에서는 half-float 저장 범위에 제한됩니다.

설정은 로컬 환경설정과 `.canvas`의 `viewport.exposure: { ev100, compensation }`에 저장합니다. 노출 항목이 없는 기존 작업 파일에는 EV100 `log2(100) ≈ 6.643856`, 보정 0을 적용해 이전의 노출 배율 1을 유지합니다. 신규 작업은 EV100 0에서 시작합니다.

## 발광의 cd/m² 단위

머티리얼 패널의 **발광 기준 휘도**는 흰색 발광에 대한 기준값이며 0–1,000,000 cd/m² 범위입니다. 실제 픽셀은 선형 발광 색상과 디코딩된 발광 텍스처를 곱합니다. 검은색 발광은 기준 휘도를 높여도 빛나지 않습니다.

```text
emissiveRGB_nits = emissiveColor_linear × emissiveMap_linear × emissiveReferenceNits
L_emissive = dot(emissiveRGB_nits, Rec.709 luminance coefficients)
```

발광은 `/100`으로 직접광과 같은 HDR 저장 단위에 맞춘 뒤 합성합니다. 노출과 GT7은 그 합계에 적용합니다. Lambert/Toon 전환이나 그림자 유무는 발광 자체의 휘도를 바꾸지 않습니다. 발광이 주변 물체를 비추는 GI나 블룸 효과는 추가하지 않았습니다.

모델 형식들의 원본 발광 배율에는 공통된 절대 단위가 없습니다. 가져온 값은 기존 뷰포트 해석을 유지하도록 **원본 흰색 발광 값 1 = 100 cd/m²**로 환산합니다. 이 값은 측정된 물리 휘도라는 뜻이 아닙니다. 실제 값을 알고 있다면 패널에서 지정하세요. 원본 발광 배율은 별도로 표시하며, ↺ 버튼으로 기본 환산값을 복원합니다.

뷰포트는 별도 재질 인스턴스로 물리 발광을 적용하므로 원본 재질과 내보내기 값은 보존합니다. `.canvas`는 재질별 `emissiveNits`에 사용자 지정 값을 저장하고, `null`은 원본 환산값 사용을 뜻합니다. 사용자 정의 GLSL ShaderMaterial은 지원하지 않으며 오류를 표시합니다.

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

GT7 연산은 DX12의 마지막 출력 패스에서 수행합니다. 개별 재질의 `toneMapped` 속성과 관계없이 최종 뷰포트에 적용됩니다. Toon 명암과 부드러운 그림자 경계는 유지합니다.

GT7 참조 구현의 [MIT 고지](../licenses/GT7-MIT.txt)는 앱 패키지에도 포함합니다. HLSL은 [gt7.hlsl](../native/dx12/gt7.hlsl), 선형 버퍼와 출력 패스는 [renderer.h](../native/dx12/renderer.h)와 [viewport.hlsl](../native/dx12/viewport.hlsl)에 있습니다.

## CORTAO

Windows 11의 [DX12 네이티브 경로](native-dx12.md)에서 전체 해상도 깊이·법선 프리패스와 CORTAO HLSL을 사용합니다. `renderer/cortao.js`는 편집 설정만 관리하며 GPU 패스를 만들지 않습니다.

Daniel Isheden의 [CORTAO 1.0.3](https://github.com/theagentd/CORTAO/tree/420b168d88dd6f9276077ba62f3711cac9d7b46c) 원본 헤더를 직접 컴파일합니다. 픽셀당 32개 샘플, 32개 cosine-weighted 광선과 정수 3D 룩업 테이블을 사용합니다. 깊이·법선은 R32_UINT로 묶고 최대 8개 밉 단계를 사용합니다. 원본 헤더·LUT와 [MIT 고지](../licenses/CORTAO-MIT.txt)를 보관합니다.

Lambert/Toon 셰이더의 간접 확산광 항에 가시성을 적용한 뒤 선형 HDR 버퍼에 기록합니다. EV100, GT7 톤매핑, sRGB 출력은 그 이후입니다. 깊이·법선에 대한 CORTAO 계산 자체는 조명 전에 별도 패스로 수행하며, 완성된 화면에 AO를 곱하지 않습니다. 재질 AO 텍스처와 화면 공간 AO는 `min(materialAO, CORTAO)`로 결합해 같은 틈을 중복으로 어둡게 만드는 문제를 피합니다. 직접광·발광·헐 아웃라인·그리드·기즈모·배경은 변경하지 않습니다. 현재 뷰포트의 주변광이 0 lux이면 효과가 없습니다.

이 구성은 [CORTAO의 입력·패스 계약](https://github.com/theagentd/CORTAO#integration-instructions)과 [Filament의 간접 조명 AO 결합](https://github.com/google/filament/blob/main/shaders/src/surface_light_indirect.fs)을 따릅니다. 방향광의 차폐는 광원 방향으로 계산한 그림자 가시성이 담당합니다. 스칼라 AO는 반구 전체의 가시성이므로 방향광 그림자를 대신하지 않습니다. PBR 반사를 추가할 때는 거칠기·시선·bent normal을 고려한 specular occlusion을 별도로 다뤄야 합니다. Lumen처럼 간접광 추적에 차폐가 포함되는 GI를 도입하면 같은 거리 범위의 AO를 다시 곱하지 않아야 합니다. [Lumen의 간접 조명과 sky shadowing](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine).

탐색 반경은 프레이밍 시 모델 AABB 대각선 대비 백분율입니다. 가까이 확대하면 참조 구현의 화면 높이 20% 반경 제한이 적용됩니다. 고정 난수 시드, 5×5 깊이·법선 기반 공간 필터로 노이즈와 실루엣 번짐을 줄입니다. AO 전용 시간 누적은 없으며, DLAA/DLSS 모드에서는 합성된 색상을 시간 복원합니다. 화면 밖·가려진 형상과 다중 투명 레이어는 표현하지 못합니다.

CORTAO의 bent normal을 가시율과 함께 RGBA16F에 저장하고 간접광에 사용합니다. 차폐는 실제 기하 법선과 FP32 선형 깊이로 계산하여 조명 법선의 기울기·깊이 양자화에 따른 자기차폐를 방지합니다. 필터는 기하 법선에서 벗어난 방향을 가시율로 가중 평균합니다. 그 차이만 월드 공간으로 변환해 조명 법선에 더하므로 스무딩·노멀맵은 유지됩니다. `하늘 방향성`(0–1, 기본 0.5)은 태양 방향의 넓은 환경광 로브를 조절합니다. 주변광 조도는 독립적이며, 실제 반사광이나 대기를 추적하지 않습니다. [필터·합성식](native-dx12.md#cortao-합성식).

설정은 `viewportCortao` 및 `.canvas`의 `viewport.cortao`로 저장합니다. 기존 `viewportGtao`/`viewport.gtao` 값은 CORTAO로 읽어 들이며, 새 키를 우선합니다. AO 필드가 전혀 없는 이전 작업은 꺼진 상태로 복원합니다. 동일한 강도·반경이라도 알고리즘 차이로 기존 GTAO와 음영이 달라질 수 있습니다.

하늘 방향성은 로컬 설정 `skyDirectionality`, 작업 파일 `viewport.skyDirectionality`에 저장하며, 필드가 없는 작업에는 기본값 0.5를 사용합니다. 기존 작업의 주변광 lux는 유지합니다. 기존 CORTAO가 켜진 작업은 bent normal과 하늘 방향성으로 간접광 표현이 달라질 수 있습니다.

Debug View는 일반 색상 패스를 대체합니다. `AO만 보기`는 공간 필터 및 사용자 강도 적용 후, `필터 전 AO`는 두 처리 전의 가시성입니다. 두 뷰 모두 전체 해상도 AO 버퍼를 표시합니다. 배경은 회색, 개방은 흰색, 완전 차폐는 검정이고 GT7·노출·조명은 거치지 않습니다. `Bent Normal`은 필터링한 월드 X·Y·Z 방향을 RGB로 표시합니다. CORTAO를 끄면 AO 뷰는 흰색, Bent Normal 뷰는 원래 표면 법선을 표시합니다. 디버그 선택은 저장하지 않으며, 작업 복원과 기본값 복원 시 일반 렌더링으로 돌아갑니다.

기하 법선·깊이 패스는 각 재질의 map/alphaMap, UV 변환, 면 방향, 스키닝·모프를 반영합니다. 노멀·범프 맵은 색상 패스의 조명에만 사용하고 AO 형상에는 사용하지 않습니다. 블렌딩 재질은 최소 알파 0.5로 차폐를 근사하며, 불투명도가 0.5 미만인 재질·숨긴 재질·사용자 정의 셰이더·에디터 보조 형상은 차폐에서 제외합니다. 법선과 색상 패스는 같은 네이티브 재질 데이터를 사용합니다. 변위 맵과 사용자 GLSL 셰이더는 지원하지 않습니다.

## 검증

`npm test`, `npm run test:dx12`, `npm run test:ui`, `npm run test:workspace`로 검증합니다. GPU/UI 테스트에는 Windows 11과 DX12 Ultimate GPU가 필요합니다.

- DXR 그림자·반그림자, 알파 컷아웃과 얇은 면, DDS 압축 텍스처 업로드를 실제 GPU 픽셀로 비교합니다.
- CORTAO의 간접광 차폐, 직접광·발광 보존, Debug View의 노출 독립성을 확인합니다.
- 일반 화면과 AO 화면을 반복 전환하고 창 캡처를 검사해 공유 텍스처의 표시 갱신을 확인합니다.
- Lambert/Toon, 아웃라인, PMX 모프, FBX 및 스키닝 애니메이션, 리사이즈·빈 장면과 오류 후 재시작을 검사합니다.
- 재질·노출·발광·AO의 워크스페이스 저장/복원과 네 언어·영어 폴백을 검증합니다.
