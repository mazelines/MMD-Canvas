# 셰이더 스택 에디터 — 머티리얼별 셰이더 시스템

MMD Canvas는 **유니티식 머티리얼 시스템**을 따릅니다. PMX 모델의 각 머티리얼에 **서로 다른 셰이더(스택)를 지정**하고, 같은 스택을 공유하더라도 **프로퍼티 값은 머티리얼마다 독립적**입니다(머티리얼 인스턴스). 뷰포트 전역 Lambert/Toon 셰이딩 모드는 제거되었으며, 셰이딩은 머티리얼별 스택 할당으로 결정됩니다.

**관심사 분리**: 셰이더 **제작/관리**와 머티리얼별 **지정**은 서로 다른 곳에서 합니다.

- **셰이더 스택 편집기**(**보기 메뉴 → 셰이더 스택 편집기…**, Ctrl+Shift+K)는 **순수 셰이더 저작 도구**입니다. 빌트인 + 사용자 셰이더를 HLSL 함수 스택으로 수정·확장·저장·관리합니다. 특정 모델 머티리얼에 종속되지 않으며, 머티리얼 선택·할당 기능이 **없습니다**. 언리얼 머티리얼 에디터 스타일 캔버스: **가운데는 선택한 셰이더의 구체 프리뷰**(오빗 카메라), **우측은 라이브러리 + 함수 스택 + 코드 + 프리뷰 프로퍼티**. 노드 그래프가 아닌 **코드 편집 기반**이며, 함수가 선언한 프로퍼티는 스택 내용에 따라 UI에 **자동 생성**됩니다.
- **머티리얼 인스펙터**(메인 창 머티리얼 탭)에서 각 머티리얼에 **어떤 셰이더를 지정**할지 선택하고, 할당된 셰이더의 프로퍼티를 **그 머티리얼만의 독립 값**으로 편집합니다(유니티 머티리얼 인스펙터 방식).

셰이더는 **`.shader` 데이터 컨테이너**(메타데이터 + 함수 스택 레이어) 파일로 디스크에서 관리되며, `.canvas`는 어떤 `.shader`가 어떤 머티리얼에 쓰였는지 **상대경로 참조**만 저장합니다(아래 [영속화](#영속화)). 후처리가 아니라 캐릭터 표면 셰이딩(`colorMain`) 위주입니다.

## 빌트인 스택 — 조립 구조와 저장 정책

빌트인 셰이더는 **메모리 기본 템플릿**(읽기 전용 baseline)으로 제공되며, 단일 덩어리 코드가 아니라 **분리된 Function Stack들의 조립**입니다("Stack with Layerable" 철학). 사용자가 레이어를 재정렬·제거·확장할 수 있습니다:

- **Default Toon** (id 1, **아웃라인 포함**): MMD 표준 툰 look. **ToonBand**(2밴드 하드 스텝 `ndl<0`, `shadowFloor` 기본 64/255≈0.251) + **ToonFill**(플랫 환경광 필) 두 레이어의 조립. 기본 할당 스택.
- **Standard** (id 2, 아웃라인 없음): 빈 스택. 중립 Lambert 베이스를 그대로 사용.

새 머티리얼은 기본적으로 Default Toon이 할당됩니다.

**빌트인 수정 저장 정책**: 빌트인은 디스크 파일이 아니므로 수정본을 빌트인 자체에 덮어쓰지 않습니다. 편집기에서 빌트인을 수정하면 **더티(●)** 상태가 되고, **저장** 시 사용자가 지정한 경로에 **새 `.shader` 파일로 내보내집니다**(빌트인 baseline은 복원). 프로젝트 종료(다른 canvas 열기 등) 시 저장되지 않은 더티 셰이더가 있으면 **저장 알림 대화상자**가 뜨고, 유저가 저장 경로를 지정합니다(저장 또는 폐기).

## 구조

고정 베이스 + 사용자 레이어 모델입니다. 내장 라이팅(**중립 Lambert 베이스**·DXR 그림자·CORTAO·발광·합성)은 고정 베이스로 유지되고, 사용자는 그 결과를 변형하는 `void` 함수를 순서대로 추가합니다. 베이스의 Toon 분기는 제거되었으며, 툰 look은 Default Toon 스택이 ctx 필드로 재현합니다.

```hlsl
// native/dx12/viewport.hlsl
float4 colorMain(...) : SV_Target {
    ShadingContext ctx;
    baseShading(v, front, primitive, ctx);  // 고정 Lambert 베이스가 ctx를 채움
    runUserStack(ctx);                      // 머티리얼에 할당된 스택의 레이어 순차 실행
    return float4(ctx.color / 100.0, ctx.alpha);
}
```

`ShadingContext`(`native/dx12/shading-context.hlsl`)는 표면(worldPos·normal·uv·viewDir·depth·pixel), 재질(albedo·emission·alpha·materialColor), 라이팅 중간값(ndl·direct·shade·fill·ao·sunDir·sunLux·**ambientLux**·skyColor·groundColor), 화면공간(viewportSize·lightDirScreen), **materialId**, 결과(color·alpha)를 담습니다. 사용자 함수는 이 ctx를 in-place로 변형합니다. `ambientLux`(sky.w)와 `materialId`는 Default Toon 재현과 per-material 프로퍼티 인덱싱에 쓰입니다.

`ctx.bentNormal`은 CORTAO의 기하 법선 대비 비차폐 방향 변화를 월드 공간 조명 법선에 더한 방향입니다(AO 꺼짐/강도 0은 조명 법선). 따라서 열린 표면에서 스무딩·노멀맵을 보존합니다. `ctx.fill`은 방향성 하늘 조명을 반영한 AO 적용 전 간접광입니다. 기본 `ToonFill`은 `evaluateAmbient(ctx.bentNormal, 0.5)`로 하늘·지면 색을 절반씩 혼합하면서 방향성을 유지합니다. 직접 조명을 재계산하는 사용자 레이어에서는 `ctx.normal`을 사용합니다. 간접광을 재계산할 때는 `evaluateAmbient(direction, skyBlend)`의 결과에 `ctx.ao`를 한 번 적용하면 됩니다.

작업 복원 시 `Default Toon`의 이전 기본 `ToonFill`·단일 `DefaultToon` 코드와 정확히 일치하는 레이어만 새 환경광 헬퍼로 갱신합니다. 레이어 ID·프로퍼티 값·활성 상태는 유지합니다. 편집된 레이어는 덮어쓰지 않으므로, 자체적으로 `ctx.fill`을 교체하는 사용자 코드는 필요에 따라 헬퍼를 사용해야 합니다.

**화면공간 depth 샘플링**: `sampleSceneDepth(pixel)` 헬퍼로 프리패스 깊이(`normalDepth`, t4)를 이웃 픽셀에서 읽을 수 있습니다(뷰공간 깊이, 배경=0). 이를 이용해 깊이 기반 림/엣지 효과를 만들 수 있습니다. `ctx.lightDirScreen`은 광원 방향을 화면 XY로 투영한 값(y 반전)입니다.

## 머티리얼별 셰이더 아키텍처

스택별로 **공유 DXIL**(color PSO)을 컴파일하되, 프로퍼티 값은 **런타임에 머티리얼별로 인덱싱**합니다. 오프셋 버퍼 없이 고정 stride로 머티리얼 인스턴스를 분리합니다:

```hlsl
// 생성된 셰이더가 각 프로퍼티에 주입하는 선언
float strength = userParams[materialId*STRIDE + localSlot].x;
```

- **STRIDE** = 라이브러리 스택 중 최대 프로퍼티 슬롯 수(`libraryStride`). 컴파일 시 상수로 bake되며, 라이브러리가 바뀌면 STRIDE가 변해 전체 재컴파일합니다.
- 각 네이티브 머티리얼은 `userParams` 구조화 버퍼(t149)에서 `materialId*STRIDE`부터 STRIDE개의 연속 float4 슬롯을 소유합니다. `materialId`는 b1 Draw cbuffer에서 읽습니다.
- `userParams` 버퍼는 **4096 슬롯(65536바이트)**입니다. `materialCount*STRIDE ≤ 4096` 제한이 있습니다.
- **per-material PSO 선택**: 네이티브 `stackPsos`(stackId→PsoSet)와 `materialStackIds`(머티리얼별 스택 id)로 `draw()`가 머티리얼별로 배치하며 해당 스택의 color PSO를 선택합니다. 스택 미할당(0)은 베이스 PSO로 폴백.
- **per-material 아웃라인**: 스택 메타데이터의 `outline` 불리언이 네이티브 `stackOutline` 맵으로 전달됩니다. 아웃라인 패스는 `outlineWidth>0 && !wireframe`일 때, 머티리얼별 `stackOutline[materialStackIds[mat]]`가 true인 경우만 헐(hull)을 그립니다. 아웃라인 두께/색상은 전역 렌더러 설정입니다.
- **파라미터 패킹은 렌더러**에서 수행합니다(`packMaterialParams`). `nativeModel`이 panel→native 머티리얼 id 매핑을 보유하므로, 머티리얼 인스턴스 params로 `userParams[nativeId*STRIDE + localSlot]`을 패킹해 opcode 7로 업로드합니다. 값 변경 시 모델 재익스포트 없이 재패킹만 합니다(`paramKey` 비교).

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

타입: `float`, `float2`, `float3`, `float4`, `int`, `bool`, `color`. `[min,max]`는 선택(슬라이더 범위), `"라벨"`은 선택(프로퍼티 이름). 각 프로퍼티는 `userParams`의 float4 슬롯 하나를 차지하며, 생성된 셰이더가 함수 본문 상단에 `userParams[materialId*STRIDE + localSlot]` 지역 변수 선언을 주입해 코드에서 이름으로 바로 참조합니다. **프로퍼티의 기본값은 스택(라이브러리)에 속하고, 실제 값은 머티리얼 인스턴스에 속합니다.** 같은 스택을 여러 머티리얼이 공유해도 각 머티리얼은 독립된 값을 갖습니다.

## 런타임 컴파일

- **컴파일 주체 = Electron main** (`electron/shader-compiler.js`). asar 인식 fs로 `viewport.hlsl`과 인클루드를 수집하고, 사용자 함수 + `runUserStack` 호출부를 삽입한 소스를 생성해 **동봉 DXC**(`dxc.exe`/`dxcompiler.dll`/`dxil.dll`, Windows SDK 재배포 파일)로 컴파일합니다. 라이브러리의 각 스택을 STRIDE와 함께 컴파일합니다(`compileShaderStack(layers, stride)`).
- 결과 DXIL 블롭(colorMain·aaColorMain)은 **opcode 8**(`loadShaderLibrary`)로 네이티브에 전달되어 스택별 color PSO를 빌드합니다. 페이로드는 스택별 `[stackId, outline, colorLen, color, aaLen, aa]` 인터리브입니다. 정점 셰이더와 비color 패스는 불변.
- **opcode 9**(`setMaterialStacks`)로 머티리얼별 스택 id를 전달해 per-material PSO 선택과 아웃라인 게이트를 구성합니다.
- 프로퍼티 값은 **opcode 7**로 `userParams` 버퍼에 업로드되며(렌더러가 per-material 패킹), **재컴파일 없이** 변조 가능합니다.
- 편집 창 프리뷰는 **선택한 라이브러리 셰이더**(`previewShaderId`)를 **opcode 6** 베이스 핫스왑으로 렌더링합니다(프리뷰는 단일 머티리얼 구체).
- 컴파일 오류는 JSON ack로 에디터에 표시되고 렌더러는 이전 PSO를 유지합니다. 잘못된 셰이더가 프로세스를 종료시키지 않습니다.
- 빈 스택(Standard)은 빌드타임 컴파일 `.cso` 베이스를 그대로 사용하므로 중립 Lambert 결과와 비트 동일합니다.

## 에디터 UI

별도 창(`renderer/shader-stack.html` + `shader-stack-window.js`)은 그리드 layout입니다: **중앙 컬럼**에 셰이더 프리뷰 캔버스(위) + CodeMirror 코드 에디터(아래), **우측 컬럼**에 스택 라이브러리 + 함수 스택 + 프로퍼티. `renderer/shader-stack-panel.js`(CodeMirror 5 벤더링, `renderer/vendor/codemirror/`)가 이를 담당합니다. **머티리얼 선택·할당 UI는 없습니다**(지정은 머티리얼 인스펙터에서).

- **스택 라이브러리**: 빌트인 + 사용자 `.shader` 목록. 스택 추가/삭제(빌트인 삭제 불가), **아웃라인 플래그**(◉) 토글, 더티(●)·소스 표시. **저장**/다른 이름 저장 버튼으로 선택 셰이더를 `.shader` 파일로 기록합니다(빌트인 수정본은 유저 지정 경로에 새 파일로 내보냄).
- **셰이더 프리뷰**: 중앙 캔버스에 중립 머티리얼 **구체**를 렌더링하고 오빗 카메라(드래그 회전·휠 줌)로 관찰합니다. **선택한 라이브러리 셰이더**(`selectedStack`)를 구체에 즉시 반영합니다(머티리얼 아님).
- **함수 스택(우측)**: 레이어를 **드래그앤드롭**으로 재정렬. 레이어 **경계 사이의 + 아이콘** 클릭 → 함수 카탈로그 **팝업** → 선택 시 그 사이에 삽입(함수 이름은 중복되지 않게 자동 부여). **제거**는 레이어 선택 후 **Del/Backspace** 또는 **우클릭 → 삭제** 메뉴. 활성 토글 체크박스.
- **코드**: 선택 레이어의 HLSL을 CodeMirror로 편집, 적용 버튼(또는 Ctrl+S)으로 컴파일. 빠른 연속 편집은 큐잉되어 최신 상태가 유실 없이 적용됩니다.
- **프로퍼티(프리뷰 전용)**: `//@property` 선언에서 슬라이더/컬러픽커/체크박스 자동 생성. 선택 셰이더의 **코드 기본값**으로 프리뷰하며, 임시 값 조정만 가능합니다(저장 안 함). **머티리얼별 실제 값 편집은 머티리얼 인스펙터**에서 합니다.
- 예제 레이어: RimLight, Fresnel, ColorGrade, ToonRamp, **DepthRimLight** (+ 빈 함수).

### DepthRimLight (깊이 기반 림라이트)

miHoYo 계열 서브컬처 게임의 기법을 참고한 예제입니다. 프레넬(`N·V`) 대신 **광원 방향으로 화면공간 이웃 depth를 샘플링**해 깊이 단절(실루엣)을 검출하고 림을 적용합니다. `offset = lightDirScreen/depth × (3·width)·width²`로 샘플 좌표를 만들고, `Δz = |이웃깊이 − 자기깊이|/자기깊이`를 `saturate((Δz−bias)/fade)`로 마스크화해 색에 더합니다. 배경 depth=0 규약에 맞춰 상대 차분을 쓰며, 광원 쪽 실루엣에 림이 걸립니다. 파라미터: 림 폭·깊이 임계값(bias)·전이 폭(fade)·강도·림 색상. 원신/스타레일/JTRP/MooaToon은 오프셋 방향과 임계값이 서로 다르며, 이 예제는 광원 방향(MooaToon) 방식입니다.

**프리뷰 렌더링 아키텍처**: 프리뷰는 메인 호스트와 **독립된 두 번째 `Dx12Host`**(`previewDx12`, 별도 네이티브 자식 프로세스)가 편집 창에 presenting합니다. `Dx12Host`/네이티브는 per-instance라 단일 인스턴스 가정이 없습니다. main은 `dx12:*` IPC를 **sender 기반**으로 디스패치(편집 창 발신 → previewDx12, 그 외 → dx12)하고, `dx12:presented` ack도 sender로 양 호스트에 라우팅합니다. 셰이더 라이브러리는 **컴파일 1회 → 양 호스트 fan-out**(`loadShaderLibrary`). 편집 창은 `Viewer`/`Dx12Viewport`/`nativeModel`을 재사용해 구체를 렌더링하며, 프리뷰는 MSAA(AA mode 0)로 DLSS feature 생성을 피합니다. 창을 닫으면 `previewDx12.stop()`으로 자식 프로세스를 정리합니다.

**상태는 main 프로세스가 단일 출처로 소유**합니다(`shaderLibrary` 엔트리[`source`/`ref`/`path`/`baseline`/`dirty`/`metadata`] + `materialInstances` + `materialNames` + `stride` + `previewShaderId` + `shaderDir`). 편집 창은 `shader-stack:library-get/library-set/stack-apply/save-entry/delete-entry/set-dir/preview-shader`, 인스펙터는 `instance-params/assign`, 복원은 `restore`(ref 기반) IPC를 사용합니다. main이 컴파일·핫스왑·파라미터 업로드 후 양 창에 재렌더를 알립니다. 메인 창이 백그라운드일 때 브로드캐스트를 놓칠 수 있어, 포커스 회복 시 상태를 재조회하고 인스펙터 자체 뮤테이션은 반환 상태를 즉시 적용합니다. 각 호스트의 mutex(`Dx12Host.serial`)가 셰이더 로드를 자기 렌더와 직렬화합니다. 셰이더 핫스왑 시 네이티브가 시간 이력을 리셋해 DLAA가 새 결과로 수렴합니다.

## 영속화 — `.shader` 컨테이너와 상대경로 참조

셰이더 코드는 `.canvas`에 임베드하지 않고 **외부 `.shader` 파일**로 관리합니다.

**`.shader` 파일**(`src/core/shader-file.js`, JSON 컨테이너):
```json
{ "format": "mmd-canvas-shader", "version": 1, "name": "My Toon", "outline": true,
  "metadata": { "description": "...", "author": "...", "tags": ["toon"] },
  "layers": [ { "id": "band", "name": "ToonBand", "code": " //@property ... void ToonBand(...){...}", "enabled": true } ] }
```
`validateShaderFile`은 strict allowlist(이름≤128·코드≤32768·레이어≤64·태그≤32)로 검증하고, `writeShaderFile`은 원자적(tmp+rename)으로 기록합니다. 프로퍼티 **기본값은 코드**(`//@property`)에 있고, 머티리얼별 **실제 값은 `.canvas`** 에 있습니다.

**`.canvas`(version 2)** 는 참조만 저장합니다:
- `viewport.materialInstances`: 패널 머티리얼 인덱스별 `{ref, params:{layerId:{propName:number|number[]}}}`. `ref`는 `builtin:<이름>` 또는 **상대경로 `.shader`**(예: `shaders/toon.shader`).
- `viewport.shaderFiles`: 참조된 사용자 `.shader` 상대경로 레지스트리.
- `viewport.outline`: 전역 아웃라인 `{width, color}`.

**상대경로 관리**: 모델/텍스처처럼 `.shader` 참조도 canvas 디렉토리 기준 상대경로로 저장·복원됩니다(`mapPaths`/`encodeWorkspace`/`decodeWorkspace`가 `materialInstances[].ref`·`shaderFiles[]`를 순회, `builtin:` ref는 경로 아님). 예: PMX 디렉토리에 `.canvas` 저장 + 하위 `shaders/`에 `.shader` 저장 → 그대로 상대경로로 호출. canvas를 다른 위치로 옮기면 참조도 재해석됩니다.

**복원**: `shader-stack:restore`가 `baseDir`(canvas dirname)로 `shaderDir`을 설정하고 `shaders/`를 디스커버리(`rebuildLibrary`) + 참조된 `.shader`를 로드한 뒤, 각 머티리얼 ref를 라이브러리 stackId로 매핑합니다. 런타임은 stackId(라이브러리 index+1)를 쓰고 영속화만 안정적 ref를 사용합니다. **레거시 마이그레이션은 없습니다**(임베드 `shaderLibrary`/`shaderStack` 필드 제거; 오래된 canvas는 빌트인으로 폴백). 창을 닫아도 상태는 main에 유지됩니다.

## 검증

- `npm test`: 파서 단위 테스트(`tests/shader-stack-tests.js`, per-material stride 패킹·`materialId*stride` 주입) + `.shader` 포맷 왕복/allowlist/상대경로 ref(`tests/shader-file-tests.js`) + 워크스페이스 왕복.
- `npm run test:shader-stack`: 실제 GPU에서 런타임 컴파일→핫스왑→픽셀 변화→프로퍼티 변조→DepthRimLight→기본 복원(비트 동일)→컴파일 오류 생존.
- `npm run test:shader-ui`: 편집기 저작(머티리얼 선택기 없음·아웃라인 토글·선택 셰이더 프리뷰·자동 프로퍼티) + **머티리얼 인스펙터** 할당·per-material 프로퍼티 편집(한 머티리얼 값 변경이 렌더를 바꾸고 다른 머티리얼은 불변)·deep-merge.
- `npm run test:dx12`/`test:dlss`/`test:presentation`/`test:lifetime`: 베이스 Lambert 분리 + per-material PSO/아웃라인 후 기존 셰이딩·DXR·AA·합성·수명 회귀.

## 제한과 주의

- **`materialCount*STRIDE ≤ 4096`**: 머티리얼 수×최대 스택 슬롯 수가 userParams 버퍼(4096 슬롯)를 넘을 수 없습니다. 초과 시 제한 안내가 필요합니다.
- **라이브러리 변경 → STRIDE 변경 → 전체 재컴파일**: 스택 추가/삭제/프로퍼티 변경으로 최대 슬롯 수가 바뀌면 모든 스택을 다시 컴파일합니다(비동기 + 상태 표시).
- 사용자 무한 루프 등은 기존 10초 GPU 펜스 타임아웃이 프로세스를 종료시키며 호스트가 복구합니다.
- DXC는 Windows SDK 라이선스 재배포 조건을 따릅니다(`licenses/DXC-SDK.txt`). CodeMirror는 MIT(`licenses/CodeMirror-MIT.txt`).
- 이 기능은 네이티브 DX12 전용 경로입니다. Three.js `ShaderMaterial`은 여전히 지원하지 않습니다(`renderer/dx12.js`).
- 런타임 컴파일은 수 초 걸릴 수 있어 비동기 처리 + 상태 표시를 사용합니다.
