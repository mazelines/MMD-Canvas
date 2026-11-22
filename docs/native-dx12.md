# Windows 11 / DirectX 12 Ultimate 뷰포트

지원 대상은 Windows 11 x64입니다. 네이티브 뷰포트는 feature level 12_2와 DXR 1.1 이상을 요구합니다. 실제 장치의 DXR·Mesh Shader·VRS·Sampler Feedback 지원을 조회합니다. 현재 사용하는 Ultimate 기능은 DXR이며 나머지 기능은 아직 렌더링에 사용하지 않습니다.

렌더러는 DX12 하나뿐입니다. Electron은 편집 UI, Three.js Core는 모델 로더·씬 데이터·카메라 제어를 담당하며 브라우저 3D 컨텍스트는 비활성화합니다. C++ 프로세스가 모든 모델 렌더링을 수행합니다. 출력 RGBA 텍스처를 NT handle과 Electron `sharedTexture`로 전달합니다. 화면 전체를 CPU로 읽어 매 프레임 전송하지 않습니다. 출력 표면 3개 이상을 순환하며 소비가 끝난 텍스처만 재사용해 화면 합성기의 이전 프레임 잔류를 방지합니다.

DDS의 BC1/BC2/BC3/BC6H/BC7 블록과 밉맵은 그대로 DX12에 업로드합니다. 일반 이미지의 RGBA 변환에는 Canvas2D만 사용합니다. 네이티브 실행 파일이나 요구 GPU 기능이 없으면 오류와 재시도 버튼을 표시하며, 다른 렌더러로 전환하지 않습니다.

화면 전송 시 외부 DX12 텍스처를 Chromium이 소유하는 별도 표면으로 GPU 복사하고, 복사 완료를 확인한 뒤 원본 VideoFrame을 닫습니다. Canvas2D에는 복사본을 전달하므로 지연된 화면 합성이 DX12 표면을 계속 붙잡지 않습니다. 이 복사에는 WebGPU의 `copyExternalImageToTexture`와 `onSubmittedWorkDone`을 사용합니다. WebGPU 씬 렌더러·재질 셰이더는 없으며 모델·그림자·AO·톤매핑은 C++ DX12에서 수행합니다. CPU 픽셀 읽기나 매 프레임 이미지 전송은 없습니다.

수신 측의 복사·그리기 완료를 확인한 뒤 프레임 요청을 완료하며, 반환 대기 중인 원본 표면이 3개면 새 렌더 요청을 잠시 대기시킵니다. 앱이 발급하는 프레임 ID는 화면 새로 고침 때도 중복되지 않습니다. Electron GPU 컨텍스트가 일시적으로 없거나 재시작 중이면 같은 DX12 출력 텍스처를 유지하며 최대 5초 동안 다시 전달합니다. 가져오기 실패 때도 표면을 반환하고, Canvas2D 컨텍스트 복원 시 정지된 장면을 다시 그립니다. 실패·복구 및 GPU 프로세스 종료 원인은 사용자 데이터 폴더의 `logs/dx12-presentation.log`에 기록합니다.

## 프레임 순서

1. 현재 포즈·모프를 정점 버퍼에 반영하고 BLAS/TLAS를 갱신합니다. 포즈 변경 시 텍스처를 다시 전송하지 않습니다.
2. 내부 해상도에서 깊이·법선·표면 위치·이전 포즈 위치 프리패스를 만듭니다. DLSS Quality·Balanced에서는 출력보다 작고 DLAA·MSAA에서는 출력과 같습니다.
3. DXR 그림자를 저광선 패스에서 계산하고 모션 재투영·시간 누적·공간 필터로 복원합니다. 별도로 packed mip chain과 CORTAO 1.0.3 원본 HLSL/32-ray LUT로 AO를 계산합니다.
4. Lambert·Toon 셰이더에서 방향광에는 DXR 그림자, 간접 확산광에는 `min(materialAO, CORTAO)`를 적용합니다. 발광은 보존합니다. 이 고정 베이스 위에 사용자가 작성한 void 함수 스택을 쌓을 수 있습니다. [셰이더 스택 에디터](shader-stack.md).
5. RGBA16F에서 투명도와 Toon 헐을 합성합니다. DLAA·DLSS에서는 단일 샘플 색상·깊이·모션 벡터를 NGX로 복원하고, MSAA에서는 4배 샘플을 resolve합니다. [DLAA·DLSS 구조와 제한](dlss.md).
6. EV100 → GT7 SDR → sRGB 순으로 출력합니다. AO Debug View는 노출·톤매핑을 우회합니다. 샤픈이 켜져 있으면 sRGB 합성본을 중간 텍스처에 기록한 뒤 NIS NVSharpen 패스가 최종 출력을 만듭니다. [샤픈 구조와 제한](dlss.md).

DXR 그림자는 표면에서 방향광의 각반경에 해당하는 원판을 샘플링합니다. 부드러움은 광원 크기이며 실시간 품질은 1 / 2 / 4 rays, 기본 4입니다. 비교용 128-ray 참조 모드는 시간 누적 없이 직접 계산합니다. PCSS blocker 검색이나 shadow-map 해상도에 의존하지 않습니다. 화면 밖의 모델도 그림자를 드리울 수 있습니다. 알파 마스크를 검사하고 완전 투명 재질은 제외하며, 유리의 색 투과·굴절 그림자는 지원하지 않습니다.

### 모션 벡터와 시간 누적 그림자

`shadowTraceMain`은 프리패스에서 보이는 표면마다 1·2·4광선을 발사합니다. 샘플 위치를 프레임마다 바꾸고 가시율·2차 모멘트·차폐물 거리 기반의 반그림자 크기를 저장합니다. 광원 각반경이 0인 하드 섀도는 1광선으로 계산하며 누적·블러를 우회합니다.

이전 프레임에 실제 렌더링한 정점 버퍼와 카메라 행렬을 보존합니다. 현재 삼각형에 이전 포즈 위치를 보간하고 이전 화면으로 투영해 **현재→이전 픽셀 모션 벡터**와 예상 깊이를 만듭니다. 따라서 카메라 이동뿐 아니라 CPU에서 평가한 스키닝·모프도 재투영에 반영됩니다.

`shadowTemporalMain`은 재투영한 네 이웃을 위치·기하 법선·재질로 검증합니다. 새로 드러난 표면은 이력을 버리고, 현재 이웃의 가시율 범위로 이전 값을 제한합니다. 정지 상태는 최대 32프레임, 포즈가 바뀐 프레임은 최대 4프레임의 가중치로 누적해 움직이는 차폐물의 잔상을 줄입니다. 조명 방향·크기, 그림자 품질, 모델/재질 교체, 해상도·투영 변경과 큰 카메라 회전에서는 이력을 초기화합니다. EV100 변경은 그림자 이력을 초기화하지 않습니다.

두 공간 필터 패스는 표면 위치·기하 법선·분산·반그림자 크기를 사용해 경계를 보존합니다. **최종 그림자 가시율은 Lambert·Toon의 재질 조명 단계에서 읽으며 EV100·GT7 이전에 합성합니다.** 정지 화면도 최대 32프레임까지 추가 렌더링한 뒤 멈춥니다. 표시용 바닥도 동일한 그림자 복원을 사용합니다.

이는 이 프로젝트의 DX12 시간 누적·공간 필터 구현이며 NVIDIA NRD/SIGMA 연동은 아닙니다. 단일 표면 프리패스와 일치하지 않는 MSAA 경계 및 뒤쪽 투명 레이어는 해당 재질에서 저광선으로 직접 평가하므로 미세한 노이즈가 남을 수 있습니다. 128-ray 참조 모드와 비교해 품질을 확인할 수 있습니다.

### DXR 자기 교차 방지

Lambert·Toon의 그림자 광선 시작점은 노멀맵·범프맵의 조명 법선과 분리합니다. `SV_PrimitiveID`와 재질 드로의 시작 삼각형 번호로 실제 정점 세 개를 읽어 기하 법선을 계산합니다. 래스터화와 BLAS는 동일한 월드 좌표 정점 버퍼를 사용하고 TLAS 인스턴스 변환은 단위 행렬입니다. 따라서 스키닝·모프·비균일 스케일이 반영된 현재 삼각형을 기준으로 보정합니다.

MSAA 경계에서는 별도의 centroid 보간 위치를 사용하고, 그 위치를 삼각형 평면에 다시 투영합니다. 기존 조명·노멀맵 계산의 보간 방식은 유지합니다. 광선 시작점의 보정 거리는 모델 전체 크기가 아니라 좌표 크기와 해당 삼각형의 extent에 따라 정합니다.

```text
u = 2^-24                         // float32 unit roundoff
E = 2 * max(abs(v1-v0), abs(v2-v0)) // 모든 성분 중 최대값
error = 4*u*(abs(v0)+abs(P)+abs(P-v0)) + 3*u*E
distance = dot(error, abs(Ng))     // Ng: 정규화한 기하 법선
Pplane = P - dot(P-v0, Ng)*Ng
Origin = outwardRound(Pplane + distance*Ng)
TMin = 0
```

`outwardRound`는 기하 법선 방향으로 float 표현값을 한 단계 더 이동시켜, 작은 오프셋이 덧셈 반올림으로 사라지는 것을 방지합니다. 불투명 표면을 통과하는 방향의 광선은 차폐로 처리합니다. 삼각형이나 메시 전체를 교차 검사에서 제외하지 않으므로 인접 면·얇은 의상의 실제 그림자는 유지됩니다. 표시용 바닥은 해석적 평면 높이에 맞춰 별도로 처리합니다.

이 방식은 [NVIDIA의 DXR 자기 교차 오차 분석](https://developer.nvidia.com/blog/solving-self-intersection-artifacts-in-directx-raytracing/)을 참고하되, 레이 히트 재구성 대신 래스터 보간·평면 투영에 대한 보수적 오차 추정을 사용합니다. 모든 GPU에 대한 수학적 보장을 뜻하지 않으며, 서로 다른 제조사의 GPU와 극단적인 좌표·얇은 형상은 추가 검증 대상입니다. 부드러운 조명 법선과 거친 실제 형상 사이에서 생기는 shadow terminator 문제는 별개입니다.

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

`occlusionAt`는 5×5 이웃을 사용합니다. 위치 가중치 `exp(-0.5 * (x*x + y*y))`에 법선 가중치 `saturate(dot(Ncenter, Ni))^8`와 깊이 가중치 `saturate(1 - abs(Zcenter - Zi) / max(radius * 0.1, Zcenter * 0.001))`를 곱합니다. 배경 이웃의 가중치는 0이며, 가중치 합이 0이거나 AO가 비활성화된 경우 가시율은 1입니다.

AO 버퍼는 RGBA16F이며 X에 가시율, YZW에 뷰 공간 bent normal을 저장합니다(기존 R32F보다 픽셀당 4바이트 증가). Bent normal은 가려지지 않은 cosine-weighted 광선들의 평균 방향입니다. 같은 공간 필터에서 `bentNormal - geometricNormal`을 가시율로 가중 평균한 뒤 중심 기하 법선에 더하고 정규화합니다. 완전 개방·완전 차폐·유효하지 않은 방향에는 원래 기하 법선을 사용합니다. AO 강도 0 또는 비활성 상태에서는 방향 보정도 끕니다. 색상 패스에서는 **기하 법선에서 벗어난 방향만** 월드 공간으로 변환해 조명 법선에 더합니다. 프리패스의 삼각형·면 방향이 일치하는 표면에만 사용하므로, 열린 표면에서는 기존 스무딩·노멀맵·범프 조명이 유지됩니다.

AO 입력은 실제 표면의 화면 미분으로 계산한 **기하 법선**과 **32비트 선형 깊이**입니다. 조명용 보간·노멀맵 법선으로 차폐 원판과 탐색 반구를 만들면 평평한 면 자체가 차폐물로 들어올 수 있습니다. 또한 FP16 깊이는 확대/고해상도에서 경사진 면을 계단으로 만들어 acne를 발생시킵니다. 따라서 프리패스 법선·깊이는 RGBA32F로 보관하며, 기존 RGBA16F 대비 픽셀당 8바이트가 증가합니다. 이후 CORTAO의 R32_UINT 압축·밉 체인은 유지합니다. 바이어스를 크게 올리거나 메시 전체를 차폐에서 제외하지 않습니다.

- Lambert의 `direct`는 `max(dot(N, L), 0) * DXRVisibility`입니다.
- Toon의 `direct`는 `lerp(64/255, band, DXRVisibility)`이며, `band`는 `dot(N, L) < 0`이면 `64/255`, 그 외에는 1입니다.
- `fill = lerp(groundRGB, skyRGB, t) * ambientLux * (1 + 2/3 * skyDirectionality * dot(B, sunDir))`입니다. `B`는 필터링한 월드 공간 bent normal이며 AO가 꺼져 있으면 표면 법선입니다. `t`는 Lambert에서 `B.y * 0.5 + 0.5`, 기본 Toon에서 0.5입니다.
- `하늘 방향성`은 0–1, 기본값 0.5입니다. 태양 방향과 연동되는 넓은 1차 로브로 환경광을 근사합니다. 로브의 구면 평균 배율은 1이고 최솟값은 1/3입니다. 태양의 **방향**만 공유하며 주변광 lux와 직접광 lux는 독립적입니다. 0은 태양 방향에 무관한 하늘·지면 필이며, bent normal에 따른 하늘·지면 색 선택은 유지됩니다. 실제 대기 산란이나 물체 간 반사광을 계산하는 GI는 아닙니다.
- `min`은 현재 앱의 재질 AO 결합 정책입니다. 예를 들어 재질 AO 0.8과 화면 AO 0.6은 0.6으로 결합합니다. 재질 AO가 이미 더 어두우면 CORTAO 변화가 화면에 드러나지 않을 수 있습니다.
- CORTAO 가시율과 bent normal은 간접 확산광에만 적용합니다. 직접광의 DXR 그림자·발광에는 곱하지 않습니다. Specular occlusion은 아직 사용하지 않습니다.

이 RGB를 HDR 버퍼에 합성하고 DLAA·DLSS 복원 또는 MSAA resolve 후 `outputMain`에서 노출 배율과 GT7, sRGB 변환을 적용합니다. Debug View는 노출·톤매핑을 우회하며 `Bent Normal`은 월드 방향을 `B * 0.5 + 0.5`의 RGB로 표시합니다. 번들 `Zhuang Fangyi.canvas`에는 AO 설정이 없어 이전 파일 호환 규칙에 따라 CORTAO가 꺼진 상태로 복원됩니다.

`npm run test:dx12`는 직접광 0 lux에서 태양 회전에 따른 환경광 변화, 기존 scalar AO와의 비교, 카메라 회전 시 bent normal의 월드 방향, 직접광·발광 보존, DLAA/DLSS를 검증합니다. 비교 PNG는 `tests/out/directional-ambient/`에 저장합니다. `npm run test:shader-stack`은 실제 예제 캐릭터의 Standard·기본 Toon 비교 이미지도 생성합니다.

`npm run test:cortao`는 기울어진/보간된 조명 법선과 노멀맵을 가진 단독 평면, 경사면, 볼록 메시, 0.001–100배 스케일, 2048 해상도를 검사합니다. 원본 AO에는 32광선·압축·밉 샘플링의 미세 노이즈를 허용하되 필터 결과의 acne와 실제 얇은 접촉부 차폐 소실을 검사합니다. 실제 캐릭터의 원본/필터 AO와 결과 수치는 `tests/out/cortao/current/`에 저장됩니다.

## 뷰포트 선택(픽킹)과 선택 아우트라인

언리얼/블렌더 에디터처럼 뷰포트에서 **개별 메시를 클릭하면 해당 메시만 선택**되고, 화면공간에서 계산한 옅은 오렌지색(`#ff9a3d`) **바깥쪽 실루엣 링**이 그 메시 둘레에만 표시됩니다. 인스펙터에서 머티리얼 행을 선택해도 같은 메시가 선택 겸 편집 대상으로 동기화됩니다. 빈 곳 클릭/Esc는 선택을 해제하고, 모델 재로드 시 초기화됩니다.

- **선택/ID 마스크**: 네이티브가 매 프레임 비-지터 `maskVertex`로 전용 마스크 깊이(`maskDepth`)를 먼저 쓰고, `maskMain`이 그 깊이에 테스트해 R32_UINT 마스크(`selectionMask`, t150)에 커버리지(값=nativeId+1, 0=배경)를 기록합니다. 알파 정책은 **색상 패스와 동일**(`max(alphaTest,0.001)`)이라 알파 0 구멍·숨김 노드는 제외되고 보이는 반투명(opacity>0)은 선택 가능합니다. 마스크는 자체 깊이를 쓰므로 반투명 앞면이 뒤면을 가리는 판정도 일관됩니다. 비-지터 커버리지라 AA 위상과 무관하게 안정적입니다.
- **픽킹**: 클릭 좌표의 마스크 픽셀을 GPU→CPU readback(opcode 10)으로 읽어 nativeId를 얻고, `panelIndices[nativeId]`로 전역 패널 인덱스를 구합니다(일반 포맷의 다중 메시도 identity dedupe 매핑으로 정확). CPU 레이캐스트를 쓰지 않아 텍스처 알파/alphaTest/계층 가시성이 색상 패스 가시성과 일치합니다. 늦은 응답은 요청/모델 세대 검증으로 무효화됩니다(Esc/clear/reload가 미완료 픽킹 취소).
- **화면공간 외곽선**: `outputMain`(temporal reconstruction **이후**)에서 비-지터 마스크를 **출력 픽셀 기준**으로 dilation해, 선택된 메시 영역(마스크 값=선택 nativeId+1)에 인접한 바깥쪽 링만 오렌지로 합성합니다(MSAA/DLSS 모드와 무관한 일정 폭). 선택 메시 둘레만 표시되고 나머지 메시는 아웃라인되지 않습니다. 카툰 inverted-hull과 분리되어 평면·열린 표면에서도 표시되고, AA 히스토리에 섞이지 않아 정지 화면에서 링이 깜빡이지 않습니다. 선택 메시 식별자는 `f[73]`(sharpening.y, nativeId+1, 0=미선택).
- **제스처 latch**: pointerdown에서 기즈모 axis/dragging을 래치하고 pointermove로 최대 이동량을 누적해, 기즈모 해제 순서·긴 드래그 후 시작점 복귀·pointercancel이 클릭으로 누출되지 않습니다.

## 지원 범위와 제한

- 색상·알파·발광·AO·tangent-space normal·bump 텍스처, DDS, 재질별 depth write, MSAA, 밉맵, Toon 헐, 그리드·바닥 그림자·와이어프레임을 지원합니다.
- 스키닝·모프는 편집기에서 평가한 정점을 전달합니다. GPU 스키닝과 BLAS refit 최적화는 아직 적용하지 않았습니다. 본·광원 도구는 별도의 편집 UI 오버레이입니다.
- 변위 텍스처, object-space normal, Instanced/Batched Mesh, 선·포인트 모델, 사용자 GLSL 셰이더는 아직 지원하지 않습니다. 사유를 표시하며 렌더러를 전환하지 않습니다. 지원되는 모델을 열거나 재질을 수정한 뒤 다시 시도할 수 있습니다.
- CORTAO는 화면 공간 AO이므로 화면 밖의 AO는 계산하지 않습니다. CORTAO 자체는 고정 샘플과 공간 필터를 사용하며, DXR 그림자의 시간 누적과 독립적입니다. 화면 전체 TAA와 NRD는 적용하지 않습니다.
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
npm run test:zoom
npm run pack
```

`pack`/`dist`는 네이티브 실행 파일과 HLSL을 먼저 빌드합니다. 패키지 검증은 실행 파일·DXIL·LUT의 존재와 원본 바이트 일치를 검사합니다. `test:dx12`는 실제 GPU가 필요하므로 일반 CI에서 자동 실행하지 않습니다. CI는 Windows에서 컴파일·코어 테스트·패키징을 검증합니다.

GPU 테스트는 그림자 on/off, 광원 크기에 따른 반그림자 변화, 알파 마스크와 얇은 면의 그림자, AO의 간접광 차폐와 직접광·발광 보존, Debug View의 EV100 독립성, Toon 아웃라인, 포즈·가시성 변경, 반복 resize와 공유 텍스처 수명을 검사합니다. 일반 화면과 AO 화면을 반복 전환하며 실제 창 캡처의 흑백 픽셀도 검사합니다.

`test:dx12`의 자기 교차 회귀 장면은 강한 노멀맵, Lambert·Toon, 0.001~1,000배 크기, 양·음의 원거리 좌표, 앞·뒷면, 여러 재질 드로, 투명 패스, indexed/non-indexed 메시, 포즈 변경을 검사합니다. 독립된 평면의 그림자 on/off 픽셀을 비교하고, 0.00005 간격의 얇은 차폐물이 모델 전체 크기와 무관하게 그림자를 유지하는지도 검사합니다.

같은 자기 교차 테스트를 시간 누적 경로에서도 실행합니다. 추가로 128-ray 기준과 정지 수렴·카메라 이동·차폐물 이동 결과를 비교하고, 가림 해제 잔상, 조명/리사이즈 초기화, 노출 독립성을 검사합니다. `test:zoom`은 실제 예제를 전신·상반신·극근접으로 36프레임 예열 후 12프레임 측정하고 `tests/out/dx12-zoom-profile.json`과 비교 이미지를 저장합니다. 프레임 시간은 GPU·해상도·디스플레이 대기에 따라 달라집니다.

`test:presentation`은 초기 GPU 연결 지연, 600개 연속 프레임, 반환이 지연되는 소비자에 대한 대기, 반복 가져오기 실패 후 표면 반환, 복구 시간 제한과 수동 재시도를 검증합니다. 테스트 앱의 GPU 프로세스만 종료한 뒤 추가 프레임을 처리하고 실제 창의 픽셀을 확인합니다. `test:lifetime`은 실제 예제 모델의 카메라를 움직이며 세 가지 창 크기에서 총 1,200프레임을 처리합니다. 루프 안에서 픽셀을 읽지 않고 GPU 종료 횟수·프레임 반환 수·지연 시간을 검사합니다.

참고: [Microsoft DXR 사양](https://microsoft.github.io/DirectX-Specs/d3d/Raytracing.html), [Electron sharedTexture](https://www.electronjs.org/docs/latest/api/shared-texture), [CORTAO 통합 지침](https://github.com/theagentd/CORTAO#integration-instructions), [Filament 간접광 합성](https://github.com/google/filament/blob/main/shaders/src/surface_light_indirect.fs).
