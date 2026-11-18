# 셰이더 스택 에디터

**보기 메뉴 → 셰이더 스택 편집기…**(Ctrl+Shift+K)로 여는 **별도의 창**에서 사용자가 작성한 HLSL 함수를 스택으로 쌓아 PMX 캐릭터의 표면 셰이딩을 확장합니다. 언리얼 머티리얼 에디터 스타일의 **작업 캔버스** layout으로, **가운데는 머티리얼 구체 프리뷰**(오빗 카메라), **우측은 스택 레이어 패널**입니다. 노드 그래프가 아닌 **코드 편집 기반**이며, 함수가 선언한 프로퍼티는 스택 내용에 따라 UI에 **자동 생성**됩니다. 후처리가 아니라 캐릭터 표면 셰이딩(`colorMain`) 위주입니다. 적용 결과는 프리뷰와 **메인 창 뷰포트** 양쪽에 반영됩니다.

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

별도 창(`renderer/shader-stack.html` + `shader-stack-window.js`)은 그리드 layout입니다: **중앙 컬럼**에 머티리얼 프리뷰 캔버스(위) + CodeMirror 코드 에디터(아래), **우측 컬럼**에 스택 레이어 패널 + 프로퍼티. `renderer/shader-stack-panel.js`(CodeMirror 5 벤더링, `renderer/vendor/codemirror/`)가 스택/코드/프로퍼티를 담당합니다.

- **머티리얼 프리뷰**: 중앙 캔버스에 중립 머티리얼 **구체**를 렌더링하고 오빗 카메라(드래그 회전·휠 줌)로 관찰합니다. 스택을 적용하면 구체에 즉시 반영됩니다.
- **함수 스택(우측)**: 레이어를 **드래그앤드롭**으로 재정렬. 레이어 **경계 사이의 + 아이콘** 클릭 → 함수 카탈로그 **팝업** → 선택 시 그 사이에 삽입(함수 이름은 중복되지 않게 자동 부여). **제거**는 레이어 선택 후 **Del/Backspace** 또는 **우클릭 → 삭제** 메뉴. 활성 토글 체크박스.
- **코드**: 선택 레이어의 HLSL을 CodeMirror로 편집, 적용 버튼(또는 Ctrl+S)으로 컴파일.
- **프로퍼티**: `//@property` 선언에서 슬라이더/컬러픽커/체크박스 자동 생성. 변경 시 재컴파일 없이 값만 업로드.
- 예제 레이어: RimLight, Fresnel, ColorGrade, ToonRamp (+ 빈 함수).

**프리뷰 렌더링 아키텍처**: 프리뷰는 메인 호스트와 **독립된 두 번째 `Dx12Host`**(`previewDx12`, 별도 네이티브 자식 프로세스)가 편집 창에 presenting합니다. `Dx12Host`/네이티브는 per-instance라 단일 인스턴스 가정이 없습니다. main은 `dx12:*` IPC를 **sender 기반**으로 디스패치(편집 창 발신 → previewDx12, 그 외 → dx12)하고, `dx12:presented` ack도 sender로 양 호스트에 라우팅합니다. 셰이더 스택은 **컴파일 1회 → 양 호스트 fan-out**(`loadShaderStack`). 편집 창은 `Viewer`/`Dx12Viewport`/`nativeModel`을 재사용해 구체를 렌더링하며, 프리뷰는 MSAA(AA mode 0)로 DLSS feature 생성을 피합니다. 창을 닫으면 `previewDx12.stop()`으로 자식 프로세스를 정리합니다.

**상태는 main 프로세스가 단일 출처로 소유**합니다(`shaderStack`). 편집 창은 `shader-stack:get/apply/params` IPC로 조회·갱신하고, main이 컴파일·핫스왑·파라미터 업로드 후 양 창에 재렌더를 알립니다. 각 호스트의 mutex(`Dx12Host.serial`)가 셰이더 로드를 자기 렌더와 직렬화합니다. 셰이더 핫스왑 시 네이티브가 시간 이력을 리셋해 DLAA가 새 결과로 수렴합니다.

## 영속화

워크스페이스 `.canvas`의 `viewport.shaderStack`에 `{id,name,code,enabled,params}` 목록으로 저장됩니다. 저장 시 메인 창이 `shader-stack:get`으로 main 상태에서 직렬화하고, 복원 시 `shader-stack:apply`로 main 상태에 반영합니다. `validateWorkspace`는 strict allowlist로 코드≤32768자·params 키≤256개로 제한합니다. 창을 닫아도 상태는 main에 유지되어 재열기 시 복원됩니다.

## 검증

- `npm test`: 파서 단위 테스트(`tests/shader-stack-tests.js`) + 워크스페이스 왕복.
- `npm run test:shader-stack`: 실제 GPU에서 런타임 컴파일→핫스왑→픽셀 변화→프로퍼티 변조→기본 복원(비트 동일)→컴파일 오류 생존.
- `npm run test:shader-ui`: 메뉴로 창 열기·머티리얼 프리뷰 렌더·+ 팝업 삽입·드래그 재정렬·우클릭/Del 삭제·자동 프로퍼티·메인 뷰포트 픽셀 변화·복원·영속화 왕복.
- `npm run test:dx12`/`test:dlss`: 베이스 분리 후 기존 셰이딩 불변 회귀.

## 제한과 주의

- 사용자 무한 루프 등은 기존 10초 GPU 펜스 타임아웃이 프로세스를 종료시키며 호스트가 복구합니다.
- DXC는 Windows SDK 라이선스 재배포 조건을 따릅니다(`licenses/DXC-SDK.txt`). CodeMirror는 MIT(`licenses/CodeMirror-MIT.txt`).
- 이 기능은 네이티브 DX12 전용 경로입니다. Three.js `ShaderMaterial`은 여전히 지원하지 않습니다(`renderer/dx12.js`).
- 런타임 컴파일은 수 초 걸릴 수 있어 비동기 처리 + 상태 표시를 사용합니다.
