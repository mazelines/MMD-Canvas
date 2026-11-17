# Windows 11 / DirectX 12 Ultimate 뷰포트

지원 대상은 Windows 11 x64입니다. 네이티브 뷰포트는 feature level 12_2와 DXR 1.1 이상을 요구합니다. 실제 장치의 DXR·Mesh Shader·VRS·Sampler Feedback 지원을 조회합니다. 현재 사용하는 Ultimate 기능은 DXR이며 나머지 기능은 아직 렌더링에 사용하지 않습니다.

렌더러는 DX12 하나뿐입니다. Electron은 편집 UI, Three.js Core는 모델 로더·씬 데이터·카메라 제어를 담당하며 브라우저 3D 컨텍스트는 비활성화합니다. C++ 프로세스가 모든 모델 렌더링을 수행합니다. 출력 RGBA 텍스처를 NT handle과 Electron `sharedTexture`로 전달합니다. 화면 전체를 CPU로 읽어 매 프레임 전송하지 않습니다. 출력 표면 3개 이상을 순환하며 소비가 끝난 텍스처만 재사용해 화면 합성기의 이전 프레임 잔류를 방지합니다.

DDS의 BC1/BC2/BC3/BC6H/BC7 블록과 밉맵은 그대로 DX12에 업로드합니다. 일반 이미지의 RGBA 변환에는 Canvas2D만 사용합니다. 네이티브 실행 파일이나 요구 GPU 기능이 없으면 오류와 재시도 버튼을 표시하며, 다른 렌더러로 전환하지 않습니다.

화면 전송 시 외부 DX12 텍스처를 Chromium이 소유하는 별도 표면으로 GPU 복사하고, 복사 완료를 확인한 뒤 원본 VideoFrame을 닫습니다. Canvas2D에는 복사본을 전달하므로 지연된 화면 합성이 DX12 표면을 계속 붙잡지 않습니다. 이 복사에는 WebGPU의 `copyExternalImageToTexture`와 `onSubmittedWorkDone`을 사용합니다. WebGPU 씬 렌더러·재질 셰이더는 없으며 모델·그림자·AO·톤매핑은 C++ DX12에서 수행합니다. CPU 픽셀 읽기나 매 프레임 이미지 전송은 없습니다.

수신 측의 복사·그리기 완료를 확인한 뒤 프레임 요청을 완료하며, 반환 대기 중인 원본 표면이 3개면 새 렌더 요청을 잠시 대기시킵니다. 앱이 발급하는 프레임 ID는 화면 새로 고침 때도 중복되지 않습니다. Electron GPU 컨텍스트가 일시적으로 없거나 재시작 중이면 같은 DX12 출력 텍스처를 유지하며 최대 5초 동안 다시 전달합니다. 가져오기 실패 때도 표면을 반환하고, Canvas2D 컨텍스트 복원 시 정지된 장면을 다시 그립니다. 실패·복구 및 GPU 프로세스 종료 원인은 사용자 데이터 폴더의 `logs/dx12-presentation.log`에 기록합니다.

## 프레임 순서

1. 현재 포즈·모프를 정점 버퍼에 반영하고 BLAS/TLAS를 갱신합니다. 포즈 변경 시 텍스처를 다시 전송하지 않습니다.
2. 전체 해상도 깊이·법선 프리패스와 packed mip chain을 만듭니다.
3. CORTAO 1.0.3 원본 HLSL 메인 패스와 32-ray LUT로 차폐율을 계산하고 공간 필터를 적용합니다.
4. Lambert·Toon 셰이더에서 방향광에는 DXR 그림자, 간접 확산광에는 `min(materialAO, CORTAO)`를 적용합니다. 발광은 보존합니다.
5. RGBA16F에서 투명도와 Toon 헐을 합성하고 MSAA 4배를 resolve합니다.
6. EV100 → GT7 SDR → sRGB 순으로 출력합니다. AO Debug View는 노출·톤매핑을 우회합니다.

DXR 그림자는 표면에서 방향광의 각반경에 해당하는 원판을 샘플링합니다. 부드러움은 광원 크기이며 품질은 16 / 64 / 128 rays, 기본 64입니다. PCSS blocker 검색이나 shadow-map 해상도에 의존하지 않습니다. 화면 밖의 모델도 그림자를 드리울 수 있습니다. 알파 마스크를 검사하고 완전 투명 재질은 제외하며, 유리의 색 투과·굴절 그림자는 지원하지 않습니다.

## CORTAO 합성식

차폐율 계산은 `cortaoMain` 컴퓨트 패스, 조명에 적용하는 합성은 캐릭터의 `colorMain` 픽셀 셰이더에서 수행합니다. 두 단계 모두 EV100·GT7 이전입니다. [HLSL 구현](../native/dx12/viewport.hlsl).

원본 CORTAO 값은 차폐된 방향 비트 수를 이용한 가시율입니다. 1은 차폐 없음, 0은 완전 차폐입니다.

```text
Vraw = 1 - popcount(rayBits) / 32
Vfiltered = sum(weight_i * Vraw_i) / sum(weight_i)
screenAO = saturate(1 - intensity * (1 - Vfiltered))
materialAO = saturate(1 + materialAOIntensity * (AOTexture.r - 1))
combinedAO = min(materialAO, screenAO)

L = albedo / PI * (direct * sunLux + fill * combinedAO) + emission
colorMain.rgb = L / 100
```

`visibilityAt`는 5×5 이웃을 사용합니다. 위치 가중치 `exp(-0.5 * (x*x + y*y))`에 법선 가중치 `saturate(dot(Ncenter, Ni))^8`와 깊이 가중치 `saturate(1 - abs(Zcenter - Zi) / max(radius * 0.1, Zcenter * 0.001))`를 곱합니다. 배경 이웃의 가중치는 0이며, 가중치 합이 0이거나 AO가 비활성화된 경우 가시율은 1입니다.

- Lambert의 `direct`는 `max(dot(N, L), 0) * DXRVisibility`입니다.
- Toon의 `direct`는 `lerp(64/255, band, DXRVisibility)`이며, `band`는 `dot(N, L) < 0`이면 `64/255`, 그 외에는 1입니다.
- `fill = lerp(groundRGB, skyRGB, t) * ambientLux`이며 `t`는 Lambert에서 `N.y * 0.5 + 0.5`, Toon에서 0.5입니다.
- `min`은 현재 앱의 재질 AO 결합 정책입니다. 예를 들어 재질 AO 0.8과 화면 AO 0.6은 0.6으로 결합합니다. 재질 AO가 이미 더 어두우면 CORTAO 변화가 화면에 드러나지 않을 수 있습니다.
- CORTAO는 간접 확산광에만 적용합니다. 직접광의 DXR 그림자·발광에는 곱하지 않습니다. 현재 bent normal과 specular occlusion은 사용하지 않습니다.

이 RGB를 HDR 버퍼에 합성하고 MSAA를 resolve한 뒤 `outputMain`에서 노출 배율과 GT7, sRGB 변환을 적용합니다. AO Debug View만 `outputMain`에서 가시율을 직접 표시하며 노출·톤매핑을 우회합니다. 번들 `Zhuang Fangyi.canvas`에는 AO 설정이 없어 이전 파일 호환 규칙에 따라 CORTAO가 꺼진 상태로 복원됩니다.

## 지원 범위와 제한

- 색상·알파·발광·AO·tangent-space normal·bump 텍스처, DDS, 재질별 depth write, MSAA, 밉맵, Toon 헐, 그리드·바닥 그림자·와이어프레임을 지원합니다.
- 스키닝·모프는 편집기에서 평가한 정점을 전달합니다. GPU 스키닝과 BLAS refit 최적화는 아직 적용하지 않았습니다. 본·광원 도구는 별도의 편집 UI 오버레이입니다.
- 변위 텍스처, object-space normal, Instanced/Batched Mesh, 선·포인트 모델, 사용자 GLSL 셰이더는 아직 지원하지 않습니다. 사유를 표시하며 렌더러를 전환하지 않습니다. 지원되는 모델을 열거나 재질을 수정한 뒤 다시 시도할 수 있습니다.
- CORTAO는 화면 공간 AO이므로 화면 밖의 AO는 계산하지 않습니다. TAA/NRD/시간 누적은 없으며 고정 샘플과 공간 필터를 사용합니다.
- 출력은 긴 변 최대 2048 pixels, 텍스처는 최대 128개입니다. 투명 재질은 불투명 재질 다음에 원래 그룹 순서로 렌더링합니다.
- `renderMs`는 네이티브 명령 기록과 GPU 완료 대기 시간입니다. 모델 업로드와 UI 표시를 포함한 전체 프레임 시간은 아닙니다.

## 빌드와 검증

Node.js 24+, Visual Studio C++ x64 도구와 Windows SDK DXC가 필요합니다.

```powershell
npm ci
npm run build:dx12
npm start
npm run test:dx12
npm run test:presentation
npm run test:lifetime
npm run pack
```

`pack`/`dist`는 네이티브 실행 파일과 HLSL을 먼저 빌드합니다. 패키지 검증은 실행 파일·DXIL·LUT의 존재와 원본 바이트 일치를 검사합니다. `test:dx12`는 실제 GPU가 필요하므로 일반 CI에서 자동 실행하지 않습니다. CI는 Windows에서 컴파일·코어 테스트·패키징을 검증합니다.

GPU 테스트는 그림자 on/off, 광원 크기에 따른 반그림자 변화, 알파 마스크와 얇은 면의 그림자, AO의 간접광 차폐와 직접광·발광 보존, Debug View의 EV100 독립성, Toon 아웃라인, 포즈·가시성 변경, 반복 resize와 공유 텍스처 수명을 검사합니다. 일반 화면과 AO 화면을 반복 전환하며 실제 창 캡처의 흑백 픽셀도 검사합니다.

`test:presentation`은 초기 GPU 연결 지연, 600개 연속 프레임, 반환이 지연되는 소비자에 대한 대기, 반복 가져오기 실패 후 표면 반환, 복구 시간 제한과 수동 재시도를 검증합니다. 테스트 앱의 GPU 프로세스만 종료한 뒤 추가 프레임을 처리하고 실제 창의 픽셀을 확인합니다. `test:lifetime`은 실제 예제 모델의 카메라를 움직이며 세 가지 창 크기에서 총 1,200프레임을 처리합니다. 루프 안에서 픽셀을 읽지 않고 GPU 종료 횟수·프레임 반환 수·지연 시간을 검사합니다.

참고: [Microsoft DXR 사양](https://microsoft.github.io/DirectX-Specs/d3d/Raytracing.html), [Electron sharedTexture](https://www.electronjs.org/docs/latest/api/shared-texture), [CORTAO 통합 지침](https://github.com/theagentd/CORTAO#integration-instructions), [Filament 간접광 합성](https://github.com/google/filament/blob/main/shaders/src/surface_light_indirect.fs).
