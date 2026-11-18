# 셰이더 스택 에디터

인스펙터의 **셰이더 스택** 탭에서 사용자가 작성한 HLSL 함수를 스택으로 쌓아 PMX 캐릭터의 표면 셰이딩을 확장합니다. 노드 그래프가 아닌 **코드 편집 기반**이며, 함수가 선언한 프로퍼티는 스택 내용에 따라 UI에 **자동 생성**됩니다. 후처리가 아니라 캐릭터 표면 셰이딩(`colorMain`) 위주입니다.

## 구조

고정 베이스 + 사용자 레이어 모델입니다. 내장 라이팅(Lambert/Toon·DXR 그림자·CORTAO·발광·합성)은 고정 베이스로 유지되고, 사용자는 그 결과를 변형하는 `void` 함수를 순서대로 추가합니다.

```hlsl
// native/dx12/viewport.hlsl
float4 colorMain(...) : SV_Target {
    ShadingContext ctx;
    baseShading(v, front, primitive, ctx);  // 고정 베이스가 ctx를 채움
    runUserStack(ctx);                      // 사용자 레이어 순차 실행 (기본=無)
    return float4(ctx.color / 100.0, ctx.alpha);
}
```

`ShadingContext`(`native/dx12/shading-context.hlsl`)는 표면(worldPos·normal·uv·viewDir·depth), 재질(albedo·emission·alpha), 라이팅 중간값(ndl·direct·shade·fill·ao), 결과(color·alpha)를 담습니다. 사용자 함수는 이 ctx를 in-place로 변형합니다.

## 문법

각 레이어는 `void 이름(inout ShadingContext ctx)` 함수이며, `//@property` 주석으로 파라미터를 선언합니다:

```hlsl
//@property float strength = 0.5 [0,1] "림 강도"
//@property float3 rimColor = (1,1,1) "림 색상"
void RimLight(inout ShadingContext ctx) {
    float rim = pow(1 - saturate(dot(ctx.normal, ctx.viewDir)), 3);
    ctx.color += rimColor * rim * strength;
}
```

타입: `float`, `float2`, `float3`, `float4`, `int`, `bool`, `color`. `[min,max]`는 선택(슬라이더 범위), `"라벨"`은 선택(프로퍼티 이름). 각 프로퍼티는 `userParams` 구조화 버퍼(t149)의 float4 슬롯 하나를 차지하며, 생성된 셰이더가 함수 본문 상단에 지역 변수 선언을 주입해 코드에서 이름으로 바로 참조합니다.

## 런타임 컴파일

- **컴파일 주체 = Electron main** (`electron/shader-compiler.js`). asar 인식 fs로 `viewport.hlsl`과 인클루드를 수집하고, 사용자 함수 + `runUserStack` 호출부를 삽입한 소스를 생성해 **동봉 DXC**(`dxc.exe`/`dxcompiler.dll`/`dxil.dll`, Windows SDK 재배포 파일)로 컴파일합니다.
- 결과 DXIL 블롭(colorMain·aaColorMain)은 IPC opcode 6으로 네이티브에 전달되어 color PSO를 **핫스왑**합니다(`renderer.h`의 `loadShader`/`graphicsFromBlobs`). 정점 셰이더와 비color 패스는 불변. 빈 스택은 기본 `.cso` PSO로 복원.
- 프로퍼티 값은 opcode 7로 `userParams` 버퍼에 업로드되며, **재컴파일 없이** 변조 가능합니다.
- 컴파일 오류는 JSON ack로 에디터에 표시되고 렌더러는 이전 PSO를 유지합니다. 잘못된 셰이더가 프로세스를 종료시키지 않습니다.
- 기본(스택 없음)은 빌드타임 컴파일 `.cso`를 그대로 사용하므로 기존 결과와 비트 동일합니다.

## 에디터 UI

`renderer/shader-stack-panel.js` (CodeMirror 5 벤더링, `renderer/vendor/codemirror/`):
- **함수 스택**: 추가(예제 카탈로그 순환)·제거·활성 토글·↑↓ 재정렬.
- **코드**: 선택 레이어의 HLSL을 CodeMirror로 편집, 적용 버튼(또는 Ctrl+S)으로 컴파일.
- **프로퍼티**: `//@property` 선언에서 슬라이더/컬러픽커/체크박스 자동 생성. 변경 시 재컴파일 없이 값만 업로드.
- 예제 레이어: RimLight, Fresnel, ColorGrade, ToonRamp.

## 영속화

워크스페이스 `.canvas`의 `viewport.shaderStack`에 `{id,name,code,enabled,params}` 목록으로 저장됩니다. `captureWorkspace`/`restoreWorkspaceState`/`validateWorkspace` 3곳 모두 관여하며, 검증자는 strict allowlist로 코드≤32768자·params 키≤256개로 제한합니다.

## 검증

- `npm test`: 파서 단위 테스트(`tests/shader-stack-tests.js`) + 워크스페이스 왕복.
- `npm run test:shader-stack`: 실제 GPU에서 런타임 컴파일→핫스왑→픽셀 변화→프로퍼티 변조→기본 복원(비트 동일)→컴파일 오류 생존.
- `npm run test:shader-ui`: 실제 DOM에서 탭·함수 추가·CodeMirror·자동 프로퍼티·영속화 왕복.
- `npm run test:dx12`/`test:dlss`: 베이스 분리 후 기존 셰이딩 불변 회귀.

## 제한과 주의

- 사용자 무한 루프 등은 기존 10초 GPU 펜스 타임아웃이 프로세스를 종료시키며 호스트가 복구합니다.
- DXC는 Windows SDK 라이선스 재배포 조건을 따릅니다(`licenses/DXC-SDK.txt`). CodeMirror는 MIT(`licenses/CodeMirror-MIT.txt`).
- 이 기능은 네이티브 DX12 전용 경로입니다. Three.js `ShaderMaterial`은 여전히 지원하지 않습니다(`renderer/dx12.js`).
- 런타임 컴파일은 수 초 걸릴 수 있어 비동기 처리 + 상태 표시를 사용합니다.
