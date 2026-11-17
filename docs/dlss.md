# DLAA와 DLSS Super Resolution

**v0.5.5부터 제공하는 기능입니다.** 뷰포트에서 DLAA(기본값), DLSS Quality, DLSS Balanced, MSAA 4×를 선택합니다. 선택은 PC의 편집기 설정으로 저장합니다.

DLAA와 Super Resolution은 GeForce RTX 20·30·40·50 시리즈에서 지원합니다. 앱의 Windows 11 x64, DirectX 12 Ultimate / feature level 12_2, DXR 1.1 요구 조건도 충족해야 합니다. 실제 사용 가능 여부는 선택된 GPU와 드라이버에 대해 NGX로 조회합니다. 지원하지 않거나 런타임 DLL이 없으면 DX12 MSAA 4×로 동작하고 DLSS 선택을 비활성화합니다. DLSS 5 Neural Rendering, Frame Generation, Ray Reconstruction은 포함하지 않습니다. [NVIDIA 기능 안내](https://www.nvidia.com/en-us/geforce/technologies/dlss/).

| 모드 | 내부 해상도 | 용도 |
|---|---|---|
| DLAA | 출력과 동일 | 원본 해상도에서 시간 정보를 사용해 화질 개선 |
| DLSS Quality | 가로·세로 약 2/3 | 화질을 우선하는 업스케일링 |
| DLSS Balanced | 가로·세로 약 58% | 더 낮은 내부 해상도로 렌더링 부하 감소 |
| MSAA 4× | 출력과 동일, 4개 커버리지 샘플 | 시간 이력을 사용하지 않는 기존 AA |

정확한 크기는 `NGX_DLSS_GET_OPTIMAL_SETTINGS`로 받습니다. 1280×900 출력의 Quality는 853×600, Balanced는 742×522입니다. 복원 비용이 있으므로 가벼운 장면이나 낮은 해상도에서는 MSAA보다 빠르지 않을 수 있습니다. 상태 표시의 시간은 네이티브 명령 기록과 GPU 완료 대기이며, 화면 전송·전체 앱 FPS는 포함하지 않습니다.

## 렌더링 순서

1. 내부 해상도에서 Halton(2,3) 지터를 적용해 깊이·법선·표면 위치를 렌더링합니다. 주기는 `ceil(8 × 출력 픽셀 수 / 내부 픽셀 수)`입니다.
2. 기존 DXR 그림자 시간 누적·필터링과 CORTAO를 계산합니다. 그림자는 재질 직접광에, `min(materialAO, CORTAO)`는 간접광에 적용합니다.
3. Lambert·Toon 색상, 투명 재질과 헐 윤곽선을 단일 샘플 RGBA16F에 그립니다. 같은 픽셀 패스에서 RG16F 모션 벡터와 R32F 깊이를 기록합니다.
4. NGX에 premultiplied HDR RGBA, 깊이, 지터를 제거한 현재→이전 모션 벡터(내부 해상도 픽셀 단위), 지터와 1×1 노출 텍스처를 전달합니다. 이전 프레임의 실제 포즈 정점을 사용해 스키닝·모프도 반영합니다.
5. 출력 크기로 복원한 뒤 알파를 분리하고 EV100 → GT7 → 배경·그리드 합성 → sRGB 출력을 수행합니다. 배경색은 노출에 영향을 받지 않습니다.
6. 기존 공유 텍스처 반환과 화면 전송 제한을 유지합니다. 정지 화면은 최대 32프레임 추가 렌더링 후 멈춥니다.

셰이더의 지터는 샘플 위치 오프셋이며 NGX에는 반대 부호인 화면상 이동량을 전달합니다. 모션 벡터에는 지터를 포함하지 않습니다. 그림자 재투영과 CORTAO 투영·역투영에도 지터를 반영합니다. 텍스처 mip bias는 `log2(내부 너비 / 출력 너비)`입니다.

모드·크기·모델·재질·조명·노출·투영 변경과 큰 카메라 이동은 AA 이력을 초기화합니다. 일반적인 카메라·포즈 이동은 재투영합니다. CORTAO Debug View와 와이어프레임에서는 MSAA를 사용하며 일반 화면으로 돌아올 때 AA를 초기화합니다. DXR 그림자 이력과 DLSS 이력은 별도로 관리합니다.

## SDK와 제한

공개 [NVIDIA DLSS SDK](https://github.com/NVIDIA/DLSS/releases) v310.9.16의 NGX D3D12 API와 Transformer Preset K를 사용합니다. 앱에 네이티브 DXGI swapchain이 없어 Streamline present 후킹은 사용하지 않습니다. NVIDIA 앱/드라이버의 사용자 재정의는 별도입니다.

배경색을 정확히 보존하기 위해 SDK의 `AlphaUpscaling`을 사용합니다. NVIDIA가 실험적 기능으로 분류하며 공식 가이드는 RGB 전용 대비 DLSS 실행 비용이 약 15–25% 증가할 수 있다고 안내합니다. 아주 가는 형상과 투명 레이어 경계에는 흔들림이나 잔상이 남을 수 있고, 특히 Balanced에서 더 두드러집니다. 한 픽셀의 여러 투명 레이어가 서로 다르게 움직이는 경우 단일 깊이·모션 벡터로 모두 표현할 수 없습니다. 편집기 그리드와 배경은 출력 해상도에서 별도로 합성합니다. [공식 통합 가이드](https://github.com/NVIDIA/DLSS/blob/9981c6350dc58c0ce21f024fd65e31e851c31689/doc/DLSS_Programming_Guide_Release.pdf).

## 검증

RTX 4090에서 다음을 검증했습니다. 다른 GPU 세대의 실행·화질 검증은 아직 수행하지 않았습니다.

- 실제 번들 모델의 기본 DLAA 시작, 네 가지 AA 모드, 출력/내부 해상도와 정지 수렴.
- 4배 해상도의 별도 참조 이미지와 가는 형상 비교, 카메라·포즈 이동 및 가림 해제. 참조 평균 오차는 MSAA 1.86, DLAA 1.13, Quality 1.30, Balanced 1.76/255였습니다. 특정 장면의 측정이며 모든 장면의 화질 순위를 뜻하지 않습니다.
- 6개 배경색 × 노출 배율 1·100·10000에서 기존 배경 픽셀과 일치. 모드·리사이즈·노출 초기화 및 AO 디버그/와이어프레임 우회.
- DLAA의 Lambert·Toon에서 CORTAO가 간접광에만 작용함을 확인했습니다. 시간 누적 DXR 그림자와 128광선 참조의 평균 차이는 각각 0.20·0.10/255였습니다.
- 1,200프레임 카메라 이동·리사이즈·AA 전환에서 GPU 종료 0회, 공유 프레임 1,232개 전부 반환.
- DX12 디버그 계층에서 오류 없음. 기존 버퍼 초기 상태 관련 경고는 남아 있습니다. DLL이 없는 별도 실행 폴더에서도 MSAA로 렌더링했습니다.
- 개발 패키지의 런타임 파일 521개, Example 파일 56개, 네이티브 DLL·셰이더를 검사했습니다. 새 사용자 설정으로 실행했을 때 번들 캔버스가 자동으로 열리고 DLAA 32프레임 수렴 후 오류 없이 표시됐습니다.

`npm run test:dlss`는 실제 NVIDIA RTX GPU가 필요합니다. `npm run test:dlss -- --validation`은 DX12 디버그 계층도 켭니다. 수치·이미지는 `tests/out/dlss/`에 기록하며 코어 테스트를 다시 실행하면 이 폴더는 정리됩니다.

## 빌드와 라이선스

`scripts/setup-dlss.ps1`은 고정 커밋 `9981c6350dc58c0ce21f024fd65e31e851c31689`의 필요한 파일을 `.cache/dlss/310.9.16/`으로 가져옵니다. `scripts/dlss-sdk.json`의 SHA-256을 검사하고 유효한 캐시는 재다운로드하지 않습니다. 빌드와 실행 시 DLL 서명을 확인합니다. 패키지에는 배포 DLL과 라이선스를 포함하며 DLL 고정 해시와 셰이더 원본 일치를 검사합니다.

프로젝트 MIT 라이선스와 NVIDIA SDK 라이선스는 별개입니다. **NVIDIA RTX™ DLSS / NVIDIA NGX SDK — Copyright © NVIDIA Corporation. All rights reserved.** 전체 조건은 [SDK 라이선스](../licenses/NVIDIA-DLSS.txt)를 참고하십시오. RTX 보충 조항에는 상용 출시 전 NVIDIA 통지와 SDK/상표 표기 요건이 있습니다. SDK가 포함된 수정본을 배포할 때도 해당 조건을 확인하십시오.
