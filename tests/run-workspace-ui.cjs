const { execFileSync } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');
for (const locale of ['ko-KR', 'en-US', 'zh-CN', 'ja-JP', 'de-DE']) {
  execFileSync(electron, ['tests/workspace-ui-smoke.cjs'], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, MMDCONV_LOCALE: locale,
      ...(locale === 'ko-KR' ? {} : { MMDCONV_WORKSPACE_START: path.resolve('tests/out/workspace-ko-KR.canvas') }) },
  });
}
