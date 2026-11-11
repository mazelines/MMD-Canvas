# 빌드와 릴리스

## 자동 실행

- `main` push / PR: Windows, macOS, Linux에서 `npm ci`, 코어 테스트, Python 문법 검사, 앱 패키징 검증.
- `v*` 태그 push: 버전 일치 검사와 테스트 후 Windows x64 NSIS 설치 파일, macOS arm64/x64 ZIP, Linux x64 AppImage 생성.
- 모든 빌드가 성공하면 GitHub Release에 배포 파일과 `SHA256SUMS.txt` 등록. 실패한 빌드는 릴리스를 게시하지 않는다.
- Actions → Release → Run workflow: 선택한 브랜치의 빌드만 수행하며, 결과는 14일간 Actions artifacts에 보관. 태그를 선택하면 해당 버전의 릴리스도 게시한다.
- Dependabot: npm 의존성과 GitHub Actions 업데이트를 매주 확인한다.

## 다음 버전 배포

깨끗한 `main`에서 변경 사항을 커밋하고 다음 명령을 실행한다.

```sh
npm version patch
git push origin main --follow-tags
```

`npm version minor` / `npm version major`도 사용할 수 있다. 태그는 반드시 `v` + `package.json`의 버전과 같아야 한다. `-beta.1` 같은 사전 버전 태그는 prerelease로 등록한다.

실패하면 Actions에서 실패한 작업을 재실행한다. 게시 단계는 같은 태그의 기존 릴리스를 재사용한다. 이미 배포한 버전을 수정할 때는 새 버전을 사용한다.

## 로컬 빌드

Node.js 24 이상과 npm을 사용한다.

```sh
npm ci
npm test
npm run pack
npm run dist
```

결과는 `dist/`에 생성된다. 각 OS 배포 파일은 해당 OS의 GitHub 호스팅 러너에서 빌드한다. Blender 설치가 필요한 실제 Blender import 검사는 기본 CI에 포함하지 않는다.

## 서명과 업데이트

현재 배포물은 인증서 없는 빌드이다. Windows 코드 서명과 Apple Developer ID 서명·공증은 별도 인증서와 계정 설정이 필요하다. macOS는 서명 ID를 명시적으로 비활성화했으므로 추후 서명 도입 시 `electron-builder.yml`도 변경해야 한다. OS 보안 정책에 따라 실행이 제한될 수 있다.

앱 내 자동 업데이트 기능은 구현되어 있지 않다. 새 버전은 GitHub Releases에서 다운로드해 설치한다. 릴리스 게시에는 작업에 한정된 `GITHUB_TOKEN`을 사용하므로 별도 개인 토큰은 필요 없다.

참고: [electron-builder 설정](https://www.electron.build/docs/configuration/), [GitHub Actions 아티팩트](https://github.com/actions/upload-artifact).
