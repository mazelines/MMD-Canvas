# 빌드와 릴리스

## 자동 실행

- `main` push / PR: Windows 러너에서 `npm ci`, 코어 테스트, Python 문법 검사, DX12 컴파일, 앱 패키징과 패키지의 파일 열기 검증.
- `v*` 태그 push: 버전 일치 검사와 테스트 후 Windows x64 NSIS 설치 파일 생성. 앱 실행에는 Windows 11과 DX12 Ultimate GPU가 필요하다.
- 모든 빌드가 성공하면 GitHub Release에 배포 파일과 `SHA256SUMS.txt` 등록. 실패한 빌드는 릴리스를 게시하지 않는다.
- `docs/release-notes/vX.Y.Z.md`가 있으면 해당 내용을 릴리스 본문으로 사용한다.
- Actions → Release → Run workflow: 선택한 브랜치의 빌드만 수행하며, 결과는 14일간 Actions artifacts에 보관. 태그를 선택하면 해당 버전의 릴리스도 게시한다.
- Dependabot: npm 의존성과 GitHub Actions 업데이트를 매주 확인한다.

## 다음 버전 배포

최신 `main`에서 릴리스 브랜치를 만들고 버전을 올린다.

```sh
git switch -c release/next
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "Bump release version"
git push -u origin release/next
```

PR을 생성하고 CI 통과 후 `main`에 병합한다. 로컬 `main`을 동기화한 뒤 병합 커밋에 버전 태그를 생성·푸시한다. 아래 `vX.Y.Z`는 실제 패키지 버전으로 바꾼다.

```sh
git switch main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "MMD Canvas vX.Y.Z"
git push origin vX.Y.Z
```

버전 변경에는 `npm version minor --no-git-tag-version` / `npm version major --no-git-tag-version`도 사용할 수 있다. 태그는 반드시 `v` + `package.json`의 버전과 같아야 한다. `-beta.1` 같은 사전 버전 태그는 prerelease로 등록한다.

실패하면 Actions에서 실패한 작업을 재실행한다. 게시 단계는 같은 태그의 기존 릴리스를 재사용한다. 이미 배포한 버전을 수정할 때는 새 버전을 사용한다.

## 로컬 빌드

Windows 11 x64, Node.js 24 이상, Visual Studio C++ x64 도구와 Windows SDK DXC를 사용한다.

```sh
npm ci
npm test
npm run build:dx12
npm run test:dx12
npm run test:presentation
npm run test:lifetime
npm run test:dlss
npm run test:grid
npm run pack
npm run dist
```

결과는 `dist/`에 생성된다. `pack`과 `dist`는 DX12 실행 파일·HLSL을 먼저 빌드하고, 런타임 파일 및 `Example` 전체 파일의 원본 일치를 검사한다. GPU 통합 테스트는 DX12 Ultimate GPU가 있는 로컬 PC에서 수행한다. GitHub 호스팅 러너의 기본 CI는 하드웨어 GPU 테스트와 Blender import 검사를 실행하지 않는다.

## 서명과 업데이트

v0.5.6에는 NVIDIA NIS NVSharpen의 고정 소스와 MIT 라이선스(`licenses/NVIDIA-NIS.txt`)를 포함한다. 빌드 시 `nis-sharpen.cso`를 생성하고 패키지 검증에 포함한다. 그리드와 샤픈 변경은 로컬 RTX GPU에서 함께 검증한다.

v0.5.5부터 첫 네이티브 빌드에서 고정된 NVIDIA NGX SDK 파일을 다운로드한다. 이후에는 SHA-256이 일치하는 캐시를 사용한다. 패키지에는 배포용 `nvngx_dlss.dll`과 `licenses/NVIDIA-DLSS.txt`를 포함하고 DLL 해시도 검사한다. RTX GPU가 없는 CI에서는 DLSS 실행 검증을 수행하지 않는다. [구현과 로컬 검증](dlss.md).

NVIDIA SDK는 프로젝트 MIT 라이선스와 별도 조건을 따른다. SDK 라이선스 RTX 보충 조항 4·7의 상용 출시 전 통지 및 SDK/상표 표기 요건을 DLSS 포함 배포 전에 확인한다. v0.5.4에는 NVIDIA SDK가 포함되어 있지 않다.

현재 배포물은 인증서 없는 Windows 빌드이다. Windows 코드 서명은 별도 인증서와 계정 설정이 필요하다. OS 보안 정책에 따라 실행이 제한될 수 있다.

v0.8.2부터 시작 시와 실행 중 6시간마다 GitHub의 최신 정식 릴리스를 확인한다. 설치된 버전보다 높으면 다운로드 알림을 표시하며, 닫은 버전은 PC에 기억한다. 네트워크 오류·시간 초과·API 제한은 조용히 처리한다. 다운로드 버튼으로 공식 GitHub Release를 열어 직접 설치하며 자동 다운로드·설치는 하지 않는다. 릴리스 게시에는 작업에 한정된 `GITHUB_TOKEN`을 사용하므로 별도 개인 토큰은 필요 없다.

참고: [electron-builder 설정](https://www.electron.build/docs/configuration/), [GitHub Actions 아티팩트](https://github.com/actions/upload-artifact).
