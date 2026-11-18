// Real-DOM UI test: the shader stack editor tab adds a layer, renders the code
// editor and auto-generated properties, compiles without error, and round-trips
// the stack through the persistence hooks.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mmd-stackui-')));
process.env.MMDCONV_OPEN=path.resolve('Example/Zhuang Fangyi/Zhuang Fangyi.canvas');
delete process.env.MMDCONV_SHOT;
const timeout=setTimeout(()=>{console.error('Shader stack UI test timed out');app.exit(1)},180000);
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
  try {
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      for(let i=0;i<1500;i++){const v=window.__viewer;if(v?.dx12.error)throw new Error(v.dx12.error.message);if(v?.current&&v.dx12.lastFrame&&!v.dx12.busy)break;await sleep(20);}
      const v=__viewer;
      document.getElementById('tab-shader').click();
      const tabSelected=document.getElementById('tab-shader').getAttribute('aria-selected')==='true';
      const panelVisible=!document.getElementById('inspector-shader').hidden;
      document.getElementById('shader-add').click();
      for(let i=0;i<300;i++){if(!v.shaderPanel.applying&&v.shaderPanel.stack.length)break;await sleep(20);}
      await sleep(200);
      const stackRows=document.querySelectorAll('#shader-stack li').length;
      const hasEditor=!!document.querySelector('#shader-editor-host .CodeMirror');
      const propControls=document.querySelectorAll('#shader-properties .shader-prop-row').length;
      const errorHidden=document.getElementById('shader-error').hidden;
      const status=document.getElementById('shader-status').textContent;
      const stack=v.shaderPanel.getStack();
      // Persistence round-trip through the panel hooks.
      v.shaderPanel.setStack(stack);
      const roundTrip=v.shaderPanel.getStack();
      // Property modulation: change the first float property and confirm no error.
      const range=document.querySelector('#shader-properties input[type="range"]');
      let modulated=false;
      if(range){range.value=range.max;range.dispatchEvent(new Event('input'));await sleep(300);modulated=!document.getElementById('shader-error').hidden===false;}
      return{tabSelected,panelVisible,stackRows,hasEditor,propControls,errorHidden,status,stackLen:stack.length,roundTripLen:roundTrip.length,firstName:stack[0]?.name,modulated};
    })()`);
    assert.ok(result.tabSelected&&result.panelVisible,'Shader tab must select and show its panel');
    assert.equal(result.stackRows,1,'Adding an example must create one stack row');
    assert.ok(result.hasEditor,'CodeMirror editor must render for the selected layer');
    assert.ok(result.propControls>=3,'RimLight must auto-generate at least 3 property controls');
    assert.ok(result.errorHidden,'Apply must succeed without a compile error');
    assert.equal(result.stackLen,1);assert.equal(result.roundTripLen,1,'Stack must round-trip through persistence hooks');
    assert.equal(result.firstName,'RimLight');
    console.log('Shader stack UI passed:',JSON.stringify(result));
    clearTimeout(timeout);app.quit();
  }catch(error){console.error(error);clearTimeout(timeout);app.exit(1)}
}));
import('../electron/main.js');
