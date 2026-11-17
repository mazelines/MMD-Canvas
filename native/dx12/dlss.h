#pragma once
#include <nvsdk_ngx_helpers.h>
#include <wintrust.h>
#include <softpub.h>

// Direct NGX integration: the renderer has no swapchain; Electron presents GPU copies.
struct Dlss {
    Device& d;
    NVSDK_NGX_Parameter* parameters=nullptr;
    NVSDK_NGX_Handle* feature=nullptr;
    bool initialized=false, supported=false;
    std::string reason;
    uint32_t mode=0, inputWidth=0, inputHeight=0, outputWidth=0, outputHeight=0;
    explicit Dlss(Device& device,const std::filesystem::path& directory):d(device) {
        DXGI_ADAPTER_DESC1 adapter{};d.adapter->GetDesc1(&adapter);
        if(adapter.VendorId!=0x10de){reason="NVIDIA RTX GPU required";return;}
        auto runtime=(directory/L"nvngx_dlss.dll").wstring();
        WINTRUST_FILE_INFO file{sizeof(file)};file.pcwszFilePath=runtime.c_str();
        WINTRUST_DATA trust{sizeof(trust)};trust.dwUIChoice=WTD_UI_NONE;trust.fdwRevocationChecks=WTD_REVOKE_NONE;
        trust.dwUnionChoice=WTD_CHOICE_FILE;trust.pFile=&file;trust.dwStateAction=WTD_STATEACTION_VERIFY;
        trust.dwProvFlags=WTD_CACHE_ONLY_URL_RETRIEVAL;
        GUID policy=WINTRUST_ACTION_GENERIC_VERIFY_V2;
        LONG signature=WinVerifyTrust(nullptr,&policy,&trust);trust.dwStateAction=WTD_STATEACTION_CLOSE;WinVerifyTrust(nullptr,&policy,&trust);
        if(signature!=ERROR_SUCCESS){reason="NVIDIA DLSS runtime missing or signature invalid";return;}
        wchar_t local[MAX_PATH]{};GetEnvironmentVariableW(L"LOCALAPPDATA",local,MAX_PATH);
        auto logs=std::filesystem::path(local)/L"MMD Canvas"/L"NGX";
        std::error_code ec;std::filesystem::create_directories(logs,ec);
        auto dir=directory.wstring();const wchar_t* paths[]{dir.c_str()};
        NVSDK_NGX_FeatureCommonInfo info{};info.PathListInfo={paths,1};
        auto result=NVSDK_NGX_D3D12_Init_with_ProjectID("6283746c-c9ef-48cf-9767-95b146519b52",NVSDK_NGX_ENGINE_TYPE_CUSTOM,"MMD Canvas DX12",logs.c_str(),d.device.Get(),&info);
        if(NVSDK_NGX_FAILED(result)){reason=error("NGX initialization",result);return;}
        initialized=true;
        result=NVSDK_NGX_D3D12_GetCapabilityParameters(&parameters);
        if(NVSDK_NGX_FAILED(result)){reason=error("NGX capabilities",result);return;}
        int available=0,driver=0;parameters->Get(NVSDK_NGX_Parameter_SuperSampling_Available,&available);
        parameters->Get(NVSDK_NGX_Parameter_SuperSampling_NeedsUpdatedDriver,&driver);
        supported=available!=0;reason=supported?"":driver?"Update the NVIDIA graphics driver":"DLSS is unavailable on this GPU/driver";
    }
    static std::string error(const char* action,NVSDK_NGX_Result result){std::ostringstream s;s<<action<<" failed (NGX 0x"<<std::hex<<uint32_t(result)<<')';return s.str();}
    static void require(NVSDK_NGX_Result result,const char* action){if(NVSDK_NGX_FAILED(result))throw std::runtime_error(error(action,result));}
    void release(){if(feature){NVSDK_NGX_D3D12_ReleaseFeature(feature);feature=nullptr;}mode=0;}
    ~Dlss(){release();if(parameters)NVSDK_NGX_D3D12_DestroyParameters(parameters);if(initialized)NVSDK_NGX_D3D12_Shutdown1(d.device.Get());}
    static NVSDK_NGX_PerfQuality_Value quality(uint32_t value){return value==1?NVSDK_NGX_PerfQuality_Value_DLAA:value==2?NVSDK_NGX_PerfQuality_Value_MaxQuality:NVSDK_NGX_PerfQuality_Value_Balanced;}
    bool configure(uint32_t requested,uint32_t w,uint32_t h){
        if(!supported||requested==0){bool changed=feature!=nullptr;release();inputWidth=outputWidth=w;inputHeight=outputHeight=h;return changed;}
        if(feature&&mode==requested&&outputWidth==w&&outputHeight==h)return false;
        release();unsigned minW=0,minH=0,maxW=0,maxH=0;float sharpness=0;
        require(NGX_DLSS_GET_OPTIMAL_SETTINGS(parameters,w,h,quality(requested),&inputWidth,&inputHeight,&maxW,&maxH,&minW,&minH,&sharpness),"DLSS resolution query");
        outputWidth=w;outputHeight=h;
        if(requested==1){inputWidth=w;inputHeight=h;}
        for(auto name:{NVSDK_NGX_Parameter_DLSS_Hint_Render_Preset_DLAA,NVSDK_NGX_Parameter_DLSS_Hint_Render_Preset_Quality,NVSDK_NGX_Parameter_DLSS_Hint_Render_Preset_Balanced})parameters->Set(name,unsigned(NVSDK_NGX_DLSS_Hint_Render_Preset_K));
        NVSDK_NGX_DLSS_Create_Params create{};create.Feature={inputWidth,inputHeight,w,h,quality(requested)};
        create.InFeatureCreateFlags=NVSDK_NGX_DLSS_Feature_Flags_IsHDR|NVSDK_NGX_DLSS_Feature_Flags_MVLowRes|NVSDK_NGX_DLSS_Feature_Flags_AlphaUpscaling;
        d.begin();auto result=NGX_D3D12_CREATE_DLSS_EXT(d.list.Get(),1,1,&feature,parameters,&create);d.submit();require(result,"DLSS feature creation");
        mode=requested;return true;
    }
    void evaluate(ID3D12Resource* color,ID3D12Resource* depth,ID3D12Resource* motion,ID3D12Resource* exposure,ID3D12Resource* output,float jitterX,float jitterY,bool reset,float milliseconds){
        NVSDK_NGX_D3D12_DLSS_Eval_Params eval{};eval.Feature.pInColor=color;eval.Feature.pInOutput=output;
        eval.pInDepth=depth;eval.pInMotionVectors=motion;eval.pInExposureTexture=exposure;
        // Our jitter is the sample/camera offset; NGX takes the raster displacement.
        eval.InJitterOffsetX=-jitterX;eval.InJitterOffsetY=-jitterY;eval.InRenderSubrectDimensions={inputWidth,inputHeight};
        eval.InReset=reset?1:0;eval.InMVScaleX=eval.InMVScaleY=1;eval.InPreExposure=eval.InExposureScale=1;
        eval.InFrameTimeDeltaInMsec=milliseconds;
        require(NGX_D3D12_EVALUATE_DLSS_EXT(d.list.Get(),feature,parameters,&eval),"DLSS evaluation");
    }
};
