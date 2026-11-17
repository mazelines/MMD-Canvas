// Single-sample color pass also supplies guides for transparent surfaces and Toon hulls.
struct AAColorOutput { float4 color:SV_Target0; float2 motion:SV_Target1; float depth:SV_Target2; };
AAColorOutput aaGuides(Varying v,float4 color) {
    AAColorOutput o;o.color=color;o.depth=v.position.z;
    float2 previousPixel=(v.previousClip.xy/max(v.previousClip.w,1e-8)*float2(0.5,-0.5)+0.5)*viewport.xy;
    // NGX expects current-to-previous, unjittered motion in render pixel units.
    o.motion=v.previousClip.w>0?previousPixel-(v.position.xy+aaJitter.xy):0;
    return o;
}
AAColorOutput aaColorMain(Varying v,bool front:SV_IsFrontFace,uint primitive:SV_PrimitiveID){return aaGuides(v,colorMain(v,front,primitive));}
AAColorOutput aaOutlineMain(Varying v,bool front:SV_IsFrontFace){return aaGuides(v,outlineMain(v,front));}

// NGX reconstructs premultiplied scene-linear RGBA. The editor background/grid is
// composed at output resolution after GT7, preserving its exact exposure-independent color.
[numthreads(8,8,1)] void aaPrepareMain(uint3 tid:SV_DispatchThreadID) {
    if(any(tid.xy>=uint2(viewport.xy)))return;
    if(all(tid.xy==0))aaExposureOut[uint2(0,0)]=settings.x;
    int2 p=int2(tid.xy);
    if(aaDepthOut[p]>=1) {
        float2 uv=(float2(p)+0.5+aaJitter.xy)/viewport.xy;
        float3 ray=mul(transpose((float3x3)view),float3((uv.x*2-1)/projection[0][0],(1-uv.y*2)/projection[1][1],-1));
        float4 oldClip=mul(previousProjection,float4(mul((float3x3)previousView,ray),0));
        float2 oldPixel=(oldClip.xy/max(oldClip.w,1e-8)*float2(0.5,-0.5)+0.5)*viewport.xy;
        aaMotionOut[p]=oldClip.w>0?oldPixel-(float2(p)+0.5+aaJitter.xy):0;
    }
}
