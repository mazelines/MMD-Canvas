// Low-ray DXR visibility, motion reprojection, temporal moments and two guided
// spatial passes. This is our native filter, not an integration of NRD/SIGMA.
static const float GROUND_KEY = 16777215.0;
uint shadowHash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; return x ^ (x >> 16); }
float pixelWorldSize(float depth) { return max(2 * depth / (projection[1][1] * viewport.y), 1e-8); }
float3 keyNormal(float key, bool previous) {
    if (key == GROUND_KEY) return float3(0,1,0);
    uint3 ids = triangles[uint(abs(key))-1].xyz;
    float3 a = previous ? previousVertices[ids.x].position : vertices[ids.x].position;
    float3 b = previous ? previousVertices[ids.y].position : vertices[ids.y].position;
    float3 c = previous ? previousVertices[ids.z].position : vertices[ids.z].position;
    float3 e1=b-a,e2=c-a,m=max(abs(e1),abs(e2));
    float scale=max(max(m.x,m.y),max(m.z,1e-30));
    return normalize(cross(e1/scale,e2/scale)) * (key>0?1:-1);
}
bool sameShadowMaterial(float a, float b) {
    if (a == 0 || b == 0) return false;
    if (a == GROUND_KEY || b == GROUND_KEY) return a == b;
    return triangles[uint(abs(a))-1].w == triangles[uint(abs(b))-1].w;
}
float4 traceShadow(float3 origin, float3 normal, float2 pixel) {
    float3 l=normalize(sun.xyz);
    float3 tangent=normalize(cross(abs(l.y)<0.95?float3(0,1,0):float3(1,0,0),l)),bitangent=cross(l,tangent);
    uint seed=shadowHash(uint(pixel.x)+uint(pixel.y)*uint(viewport.x));
    float2 rotation=float2(seed&65535u,seed>>16)/65536.0;
    uint samples=viewport.z==0?1:clamp(uint(ao.z),1u,4u);
    float visible=0,closest=1e30;
    for(uint i=0;i<samples;i++) {
        float index=float((temporalInfo.x&255u)*samples+i)+0.5;
        float2 xi=frac(rotation+index*float2(0.754877666,0.569840296));
        float a=6.283185307*xi.y,r=sqrt(xi.x)*viewport.z;
        float3 direction=normalize(l+r*(cos(a)*tangent+sin(a)*bitangent));
        if(dot(normal,direction)<=0){closest=0;continue;}
        float hit=shadowHitDistance(origin,direction);
        if(hit<0)visible+=1;else closest=min(closest,hit);
    }
    visible/=samples;
    float penumbra=closest<1e29?min(65504.0,closest*viewport.z/max(abs(dot(normal,l)),0.15)):-1;
    return float4(visible,visible*visible,1,penumbra);
}
[numthreads(8,8,1)] void shadowTraceMain(uint3 tid:SV_DispatchThreadID) {
    if(any(tid.xy>=uint2(viewport.xy)))return;
    float4 surface=surfaceOut[tid.xy],motion=motionOut[tid.xy];
    ShadowSurface receiver;
    if(surface.w==0) {
        float3 camera=-mul(transpose((float3x3)view),float3(view[0][3],view[1][3],view[2][3]));
        float2 uv=(float2(tid.xy)+0.5)/viewport.xy;
        float3 direction=mul(transpose((float3x3)view),normalize(float3((uv.x*2-1)/projection[0][0],(1-uv.y*2)/projection[1][1],-1)));
        float t=(misc.x-camera.y)/direction.y;
        float3 p=camera+direction*t;p.y=misc.x;
        if(direction.y>=-0.00001||t<=0||length(p.xz-grid.xy)>=misc.z*0.65) {
            shadowRawOut[tid.xy]=float4(1,1,0,0);shadowGuideOut[tid.xy]=0;motionOut[tid.xy]=0;return;
        }
        surface=float4(p,GROUND_KEY);motion=float4(p,1);
        receiver.origin=float3(p.x,roundAway(p.y,1),p.z);receiver.normal=float3(0,1,0);
    } else receiver=triangleShadowSurface(surface.xyz,uint(abs(surface.w))-1,surface.w>0);
    surfaceOut[tid.xy]=surface;
    float4 oldView=mul(previousView,float4(motion.xyz,1));
    float4 oldClip=mul(previousProjection,oldView);
    float2 oldPixel=(oldClip.xy/max(oldClip.w,1e-8)*float2(0.5,-0.5)+0.5)*viewport.xy;
    // Current-to-previous motion in pixels, expected previous linear depth, validity.
    motionOut[tid.xy]=float4(oldPixel-(float2(tid.xy)+0.5),-oldView.z,oldClip.w>0?1:0);
    shadowGuideOut[tid.xy]=float4(receiver.normal,-mul(view,float4(surface.xyz,1)).z);
    shadowRawOut[tid.xy]=traceShadow(receiver.origin,receiver.normal,float2(tid.xy));
}
[numthreads(8,8,1)] void shadowTemporalMain(uint3 tid:SV_DispatchThreadID) {
    if(any(tid.xy>=uint2(viewport.xy)))return;
    int2 p=int2(tid.xy);float4 surface=shadowSurface[p],raw=shadowRaw[p],guide=shadowGuide[p],motion=shadowMotion[p];
    if(surface.w==0||raw.z==0){shadowHistoryOut[p]=float4(1,1,0,0);return;}
    if(viewport.z==0){shadowHistoryOut[p]=float4(raw.xy,1,0);return;}
    float4 history=0;float total=0;
    [branch] if(temporalInfo.y!=0&&motion.w>0) {
        float2 oldPixel=float2(p)+motion.xy,uv=(oldPixel+0.5)/viewport.xy;
        int2 base=int2(floor(oldPixel));float2 fraction=frac(oldPixel);
        float oldPixelWorld=max(2*motion.z/(previousProjection[1][1]*viewport.y),1e-8);
        float3 expectedView=float3((uv.x*2-1)*motion.z/previousProjection[0][0],(1-uv.y*2)*motion.z/previousProjection[1][1],-motion.z);
        float3 expectedWorld=mul(transpose((float3x3)previousView),expectedView-float3(previousView[0][3],previousView[1][3],previousView[2][3]));
        float3 oldNormal=keyNormal(surface.w,true);
        for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
            int2 q=base+int2(x,y);if(any(q<0)||any(q>=int2(viewport.xy)))continue;
            float4 candidate=previousSurface[q];
            if(!sameShadowMaterial(surface.w,candidate.w))continue;
            if(dot(oldNormal,keyNormal(candidate.w,true))<0.8)continue;
            float3 difference=candidate.xyz-expectedWorld;
            if(abs(dot(difference,oldNormal))>oldPixelWorld*0.75||length(difference)>oldPixelWorld*3)continue;
            float4 h=shadowHistory[q];if(h.z<1)continue;
            float weight=(x?fraction.x:1-fraction.x)*(y?fraction.y:1-fraction.y);
            history+=h*weight;total+=weight;
        }
    }
    float count=1;
    if(total>0.5) {
        history/=total;
        // Reject stale lit/umbra history when a moving occluder changes a region.
        float minimum=raw.x,maximum=raw.x;
        for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++) {
            int2 q=clamp(p+int2(x,y),int2(0,0),int2(viewport.xy)-1);
            if(!sameShadowMaterial(surface.w,shadowSurface[q].w))continue;
            if(dot(guide.xyz,shadowGuide[q].xyz)<0.8)continue;
            minimum=min(minimum,shadowRaw[q].x);maximum=max(maximum,shadowRaw[q].x);
        }
        history.x=clamp(history.x,minimum,maximum);history.y=max(history.y,history.x*history.x);
        count=min(history.z+1,float(temporalInfo.z));
        raw.xy=lerp(history.xy,raw.xy,1/count);
        if(raw.w<0)raw.w=history.w;
    }
    if(raw.w<0)raw.w=pixelWorldSize(guide.w)*2;
    shadowHistoryOut[p]=float4(raw.xy,count,raw.w);
}
float4 filterShadow(int2 p, bool finalPass) {
    float4 center=finalPass?shadowSpatialIntermediate[p]:shadowSpatialInput[p];
    float4 surface=shadowSurface[p],guide=shadowGuide[p];
    if(surface.w==0||viewport.z==0)return center;
    float pixelSize=pixelWorldSize(guide.w),radius=min(center.w/pixelSize,8.0);
    if(radius<0.5)return center;
    float variance=max(center.y-center.x*center.x,0.25/max(center.z,1));
    float sigma=max(0.08,3*sqrt(variance));
    float sum=0,total=0;int step=finalPass?2:1;
    for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++) {
        if(length(float2(x,y))*step>max(radius,1.0))continue;
        int2 q=clamp(p+int2(x,y)*step,int2(0,0),int2(viewport.xy)-1);
        float4 otherSurface=shadowSurface[q],otherGuide=shadowGuide[q];
        if(otherSurface.w==0||(surface.w==GROUND_KEY)!=(otherSurface.w==GROUND_KEY))continue;
        float4 other=finalPass?shadowSpatialIntermediate[q]:shadowSpatialInput[q];
        float w=exp(-0.5*(x*x+y*y))*pow(saturate(dot(guide.xyz,otherGuide.xyz)),32);
        w*=saturate(1-abs(dot(otherSurface.xyz-surface.xyz,guide.xyz))/(pixelSize*0.75));
        w*=exp(-abs(other.x-center.x)/sigma);
        sum+=other.x*w;total+=w;
    }
    center.x=total>0?sum/total:center.x;return center;
}
[numthreads(8,8,1)] void shadowSpatialMain(uint3 tid:SV_DispatchThreadID) {
    if(any(tid.xy>=uint2(viewport.xy)))return;
    shadowSpatialOut[tid.xy]=filterShadow(int2(tid.xy),false);
}
[numthreads(8,8,1)] void shadowSpatialFinalMain(uint3 tid:SV_DispatchThreadID) {
    if(any(tid.xy>=uint2(viewport.xy)))return;
    shadowFinalOut[tid.xy]=filterShadow(int2(tid.xy),true);
}
