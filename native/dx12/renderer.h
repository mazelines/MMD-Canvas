#pragma once
#include <fstream>
#include <filesystem>
#include <array>
#include <chrono>
#include <algorithm>
#include <cstring>
#include <limits>
#include <unordered_map>
#include "dlss.h"
#include "NIS_Config.h"

struct NativeVertex { float p[3], n[3], uv[2]; };
struct NativeTriangle { uint32_t a,b,c,material; };
struct NativeMaterial { float color[4], emission[4]; int32_t maps[4]; float options[4], uv[4], extra[4], normals[4], mapFlags[4]; };
static_assert(sizeof(NativeVertex) == 32 && sizeof(NativeMaterial) == 128);
struct Reader {
    const std::vector<uint8_t>& data; size_t offset = 0;
    const uint8_t* take(size_t size) { if (size > data.size() - offset) throw std::runtime_error("Truncated native packet"); auto p = data.data()+offset; offset += size; return p; }
    uint32_t u32() { uint32_t v; memcpy(&v, take(4), 4); return v; }
};
struct NativeRenderer {
    Device& d; std::filesystem::path directory; HANDLE parent = nullptr, remoteHandle = nullptr;
    Dlss dlss;
    ComPtr<ID3D12RootSignature> root, nisRoot;
    ComPtr<ID3D12DescriptorHeap> descriptors, rtvs, dsvs;
    ComPtr<ID3D12PipelineState> normalPso, colorPso, transparentPso, outlinePso, wirePso, packPso, mipPso, aoPso, outputPso, sharpenPso;
    ComPtr<ID3D12PipelineState> shadowTracePso, shadowTemporalPso, shadowSpatialPso, shadowFinalPso;
    ComPtr<ID3D12PipelineState> aaColorPso, aaTransparentPso, aaOutlinePso, aaPreparePso;
    // Per-material shader stacks: a stackId -> PSO-set library plus a per-material
    // stackId assignment. stackId 0 uses the base (global) color PSOs above.
    struct PsoSet { ComPtr<ID3D12PipelineState> color, transparent, wire, aaColor, aaTransparent; };
    std::unordered_map<uint32_t, PsoSet> stackPsos;
    std::unordered_map<uint32_t, bool> stackOutline;
    std::vector<uint32_t> materialStackIds;
    ComPtr<ID3D12Resource> aaOutput, aaMotion, aaDepth, aaExposure, composite, nisConfig, userParams;
    ComPtr<ID3D12Resource> vertexBuffer, triangleBuffer, materialBuffer, indexBuffer, blas, tlas, scratch, instances, constants;
    ComPtr<ID3D12Resource> normal, depth, hdr, hdrMs, depthMs, packedBuffer, aoTexture, sharedOutput, lut;
    ComPtr<ID3D12Resource> previousVertexBuffer, motion, shadowRawTexture, shadowGuideTexture;
    std::array<ComPtr<ID3D12Resource>,2> surfaces, shadowHistories, shadowFilters;
    std::array<float,76> previousFrame{};
    uint32_t shadowIndex=0, samplingFrame=0, stableFrames=0;
    bool historyValid=false, poseChanged=false;
    bool aaHistoryValid=false;
    uint32_t outputWidth=0,outputHeight=0,colorSamples=4,aaStableFrames=0,aaSampleFrame=0;
    float previousJitter[2]{};
    std::chrono::steady_clock::time_point lastRender=std::chrono::steady_clock::now();
    std::vector<ComPtr<ID3D12Resource>> images, uploads;
    std::vector<NativeTriangle> triangles;
    std::vector<NativeMaterial> materials;
    struct SharedFrame { ComPtr<ID3D12Resource> texture; HANDLE handle=nullptr; uint32_t w=0,h=0,id=0; bool busy=false; };
    std::vector<SharedFrame> sharedFrames;
    uint32_t vertexCount = 0, width = 0, height = 0, descriptorSize = 0, rtvSize = 0;
    std::array<uint32_t, 32> mipInfo{};
    bool hasModel = false;
    bool outlines = false;
    bool wireframe = false;
    bool userShaderActive = false;
    explicit NativeRenderer(Device& device, const std::filesystem::path& dir, DWORD parentPid) : d(device), directory(dir), dlss(device,dir) {
        parent = OpenProcess(PROCESS_DUP_HANDLE, FALSE, parentPid);
        if (!parent) throw std::runtime_error("Cannot share textures with the host process");
        D3D12_DESCRIPTOR_HEAP_DESC h{}; h.NumDescriptors = 174; h.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV; h.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
        check(d.device->CreateDescriptorHeap(&h, IID_PPV_ARGS(&descriptors)), "Create descriptors");
        descriptorSize = d.device->GetDescriptorHandleIncrementSize(h.Type);
        h = {}; h.NumDescriptors = 7; h.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
        check(d.device->CreateDescriptorHeap(&h, IID_PPV_ARGS(&rtvs)), "Create render target views"); rtvSize = d.device->GetDescriptorHandleIncrementSize(h.Type);
        h.NumDescriptors = 2; h.Type = D3D12_DESCRIPTOR_HEAP_TYPE_DSV;
        check(d.device->CreateDescriptorHeap(&h, IID_PPV_ARGS(&dsvs)), "Create depth view");
        D3D12_DESCRIPTOR_RANGE ranges[2]{};
        ranges[0] = {D3D12_DESCRIPTOR_RANGE_TYPE_SRV,150,0,0,0}; ranges[1] = {D3D12_DESCRIPTOR_RANGE_TYPE_UAV,14,0,0,0};
        D3D12_ROOT_PARAMETER params[4]{};
        params[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_CBV; params[0].Descriptor.ShaderRegister = 0;
        params[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS; params[1].Constants = {1,0,4};
        for (int i=0;i<2;i++) { params[i+2].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE; params[i+2].DescriptorTable = {1,&ranges[i]}; }
        D3D12_STATIC_SAMPLER_DESC samplers[2]{};
        for (int i=0;i<2;i++) { auto& s=samplers[i]; s.ShaderRegister=i; s.Filter=i?D3D12_FILTER_MIN_MAG_MIP_POINT:D3D12_FILTER_MIN_MAG_MIP_LINEAR;
            s.AddressU=s.AddressV=s.AddressW=i?D3D12_TEXTURE_ADDRESS_MODE_CLAMP:D3D12_TEXTURE_ADDRESS_MODE_WRAP; s.MaxLOD=D3D12_FLOAT32_MAX; s.MaxAnisotropy=1; s.ComparisonFunc=D3D12_COMPARISON_FUNC_ALWAYS; }
        D3D12_ROOT_SIGNATURE_DESC sig{4,params,2,samplers,D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT};
        ComPtr<ID3DBlob> blob,error; check(D3D12SerializeRootSignature(&sig,D3D_ROOT_SIGNATURE_VERSION_1,&blob,&error),"Serialize root signature");
        check(d.device->CreateRootSignature(0,blob->GetBufferPointer(),blob->GetBufferSize(),IID_PPV_ARGS(&root)),"Create root signature");
        // NVSharpen (NIS SDK, MIT) keeps its own b0/t0/u0/s0 layout. A dedicated
        // root signature reuses the shared descriptor heap: t0 -> composite SRV
        // (slot 148), u0 -> shared output UAV (slot 162), plus a linear-clamp
        // sampler the main signature does not have. Block geometry is fixed at
        // the SDK's NVSharpen defaults and must match the build defines.
        D3D12_DESCRIPTOR_RANGE nisRanges[2]{};
        nisRanges[0]={D3D12_DESCRIPTOR_RANGE_TYPE_SRV,1,0,0,0};nisRanges[1]={D3D12_DESCRIPTOR_RANGE_TYPE_UAV,1,0,0,0};
        D3D12_ROOT_PARAMETER nisParams[3]{};
        nisParams[0].ParameterType=D3D12_ROOT_PARAMETER_TYPE_CBV;nisParams[0].Descriptor.ShaderRegister=0;
        nisParams[1].ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;nisParams[1].DescriptorTable={1,&nisRanges[0]};
        nisParams[2].ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;nisParams[2].DescriptorTable={1,&nisRanges[1]};
        D3D12_STATIC_SAMPLER_DESC nisSampler{};
        nisSampler.Filter=D3D12_FILTER_MIN_MAG_MIP_LINEAR;nisSampler.AddressU=nisSampler.AddressV=nisSampler.AddressW=D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
        nisSampler.MaxAnisotropy=1;nisSampler.ComparisonFunc=D3D12_COMPARISON_FUNC_ALWAYS;nisSampler.MaxLOD=D3D12_FLOAT32_MAX;nisSampler.ShaderVisibility=D3D12_SHADER_VISIBILITY_ALL;
        D3D12_ROOT_SIGNATURE_DESC nisSig{3,nisParams,1,&nisSampler,D3D12_ROOT_SIGNATURE_FLAG_NONE};
        ComPtr<ID3DBlob> nisBlob,nisError;check(D3D12SerializeRootSignature(&nisSig,D3D_ROOT_SIGNATURE_VERSION_1,&nisBlob,&nisError),"Serialize NIS root signature");
        check(d.device->CreateRootSignature(0,nisBlob->GetBufferPointer(),nisBlob->GetBufferSize(),IID_PPV_ARGS(&nisRoot)),"Create NIS root signature");
        {auto code=shader("nis-sharpen");D3D12_COMPUTE_PIPELINE_STATE_DESC p{};p.pRootSignature=nisRoot.Get();p.CS={code.data(),code.size()};check(d.device->CreateComputePipelineState(&p,IID_PPV_ARGS(&sharpenPso)),"nis-sharpen");}
        nisConfig=buffer(sizeof(NISConfig),D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);
        normalPso = graphics("normalMain", false, true); colorPso = graphics("colorMain", true, true); transparentPso = graphics("colorMain", true, false);
        outlinePso = graphics("outlineMain", true, false, "outlineVertex");
        wirePso = graphics("colorMain", true, true, "vertexMain", true);
        aaColorPso=graphics("aaColorMain",true,true);aaTransparentPso=graphics("aaColorMain",true,false);aaOutlinePso=graphics("aaOutlineMain",true,false,"outlineVertex");
        aaPreparePso=compute("aaPrepareMain");
        packPso = compute("packMain"); mipPso = compute("mipMain"); aoPso = compute("cortaoMain"); outputPso = compute("outputMain");
        shadowTracePso=compute("shadowTraceMain");shadowTemporalPso=compute("shadowTemporalMain");shadowSpatialPso=compute("shadowSpatialMain");shadowFinalPso=compute("shadowSpatialFinalMain");
        constants = buffer(768,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);
        // Populate unused descriptors, including texture slots, with safe null resources.
        for(uint32_t i=0;i<150;i++) { D3D12_SHADER_RESOURCE_VIEW_DESC v{}; v.Format=DXGI_FORMAT_R8G8B8A8_UNORM; v.ViewDimension=D3D12_SRV_DIMENSION_TEXTURE2D; v.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING; v.Texture2D.MipLevels=1; d.device->CreateShaderResourceView(nullptr,&v,cpu(i)); }
        // User shader-stack parameters: persistent upload-heap structured buffer at
        // t149 (slot 149). The runtime color shader reads float4 property slots from
        // it; the default shader never reads t149, so binding it always is harmless.
        userParams = buffer(65536,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ);
        structured(userParams.Get(),149,4096,16);
        std::ifstream in(directory / "32x32x24x32_R32_UINT.bin",std::ios::binary);
        std::vector<uint8_t> table((std::istreambuf_iterator<char>(in)),{}); if(table.size()!=98304) throw std::runtime_error("CORTAO lookup table is missing");
        d.begin(); lut = texture(32,32,DXGI_FORMAT_R32_UINT,D3D12_RESOURCE_FLAG_NONE,D3D12_RESOURCE_STATE_COPY_DEST,24);
        uploadTexture(lut.Get(),table.data(),32*4,32,24); transition(lut.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        D3D12_SHADER_RESOURCE_VIEW_DESC lv{}; lv.Format=DXGI_FORMAT_R32_UINT; lv.ViewDimension=D3D12_SRV_DIMENSION_TEXTURE3D; lv.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING; lv.Texture3D.MipLevels=1;
        d.device->CreateShaderResourceView(lut.Get(),&lv,cpu(7)); d.submit(); uploads.clear();
    }
    ~NativeRenderer() { closeRemote(); if(parent) CloseHandle(parent); }
    void closeHandle(HANDLE handle) { if(handle) { HANDLE reclaimed=nullptr; if(DuplicateHandle(parent,handle,GetCurrentProcess(),&reclaimed,0,FALSE,DUPLICATE_SAME_ACCESS|DUPLICATE_CLOSE_SOURCE)) CloseHandle(reclaimed); } }
    void closeRemote() { for(auto& frame:sharedFrames)closeHandle(frame.handle);sharedFrames.clear();remoteHandle=nullptr; }
    void release(uint32_t id) { for(auto& frame:sharedFrames)if(frame.id==id)frame.busy=false; }
    void acquireOutput(uint32_t id) {
        SharedFrame* frame=nullptr;
        // Rotate released surfaces so Chromium's compositor does not keep sampling
        // the resource it displayed for the preceding frame.
        if(sharedFrames.size()>=3) {
            for(auto& f:sharedFrames)if(!f.busy&&f.w==outputWidth&&f.h==outputHeight&&(!frame||f.id<frame->id))frame=&f;
            if(!frame)for(auto& f:sharedFrames)if(!f.busy&&(!frame||f.id<frame->id))frame=&f;
        }
        if(!frame){if(sharedFrames.size()>=8)throw std::runtime_error("Shared texture consumer has not released frames");sharedFrames.emplace_back();frame=&sharedFrames.back();}
        if(!frame->texture||frame->w!=outputWidth||frame->h!=outputHeight){
            closeHandle(frame->handle);frame->handle=nullptr;
            frame->texture=texture(outputWidth,outputHeight,DXGI_FORMAT_R8G8B8A8_UNORM,D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET|D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS|D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS,D3D12_RESOURCE_STATE_COMMON,1,true);
            HANDLE local=nullptr;check(d.device->CreateSharedHandle(frame->texture.Get(),nullptr,GENERIC_ALL,nullptr,&local),"Export shared texture");
            BOOL ok=DuplicateHandle(GetCurrentProcess(),local,parent,&frame->handle,0,FALSE,DUPLICATE_SAME_ACCESS);CloseHandle(local);if(!ok)throw std::runtime_error("Export texture handle failed");
            frame->w=outputWidth;frame->h=outputHeight;
        }
        frame->id=id;frame->busy=true;sharedOutput=frame->texture;remoteHandle=frame->handle;textureView(sharedOutput.Get(),162,true);
    }
    D3D12_CPU_DESCRIPTOR_HANDLE cpu(uint32_t i) { auto h=descriptors->GetCPUDescriptorHandleForHeapStart(); h.ptr+=size_t(i)*descriptorSize; return h; }
    D3D12_GPU_DESCRIPTOR_HANDLE gpu(uint32_t i) { auto h=descriptors->GetGPUDescriptorHandleForHeapStart(); h.ptr+=uint64_t(i)*descriptorSize; return h; }
    D3D12_CPU_DESCRIPTOR_HANDLE rtv(uint32_t i) { auto h=rtvs->GetCPUDescriptorHandleForHeapStart(); h.ptr+=size_t(i)*rtvSize; return h; }
    ComPtr<ID3D12Resource> buffer(uint64_t size,D3D12_HEAP_TYPE type,D3D12_RESOURCE_STATES state,D3D12_RESOURCE_FLAGS flags=D3D12_RESOURCE_FLAG_NONE) {
        D3D12_HEAP_PROPERTIES heap{}; heap.Type=type;
        D3D12_RESOURCE_DESC desc{}; desc.Dimension=D3D12_RESOURCE_DIMENSION_BUFFER; desc.Width=std::max(uint64_t(256),size); desc.Height=1; desc.DepthOrArraySize=1; desc.MipLevels=1; desc.SampleDesc.Count=1; desc.Layout=D3D12_TEXTURE_LAYOUT_ROW_MAJOR; desc.Flags=flags;
        ComPtr<ID3D12Resource> result; check(d.device->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,&desc,state,nullptr,IID_PPV_ARGS(&result)),"Create buffer"); return result;
    }
    ComPtr<ID3D12Resource> texture(uint32_t w,uint32_t h,DXGI_FORMAT format,D3D12_RESOURCE_FLAGS flags,D3D12_RESOURCE_STATES state,uint16_t slices=1,bool shared=false,uint16_t mips=1,uint32_t samples=1,float clearColor=0) {
        D3D12_HEAP_PROPERTIES heap{}; heap.Type=D3D12_HEAP_TYPE_DEFAULT;
        D3D12_RESOURCE_DESC desc{}; desc.Dimension=slices>1?D3D12_RESOURCE_DIMENSION_TEXTURE3D:D3D12_RESOURCE_DIMENSION_TEXTURE2D; desc.Width=w; desc.Height=h; desc.DepthOrArraySize=slices; desc.MipLevels=mips; desc.Format=format; desc.SampleDesc.Count=samples; desc.Flags=flags;
        D3D12_CLEAR_VALUE clear{};clear.Format=format;for(float& c:clear.Color)c=clearColor;if(flags&D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL)clear.DepthStencil={1,0};
        auto clearPtr=(flags&(D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET|D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL))?&clear:nullptr;
        ComPtr<ID3D12Resource> result; check(d.device->CreateCommittedResource(&heap,shared?D3D12_HEAP_FLAG_SHARED:D3D12_HEAP_FLAG_NONE,&desc,state,clearPtr,IID_PPV_ARGS(&result)),"Create texture"); return result;
    }
    void transition(ID3D12Resource* res,D3D12_RESOURCE_STATES before,D3D12_RESOURCE_STATES after) { if(before==after)return; D3D12_RESOURCE_BARRIER b{}; b.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION; b.Transition={res,D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,before,after}; d.list->ResourceBarrier(1,&b); }
    void uavBarrier(ID3D12Resource* res) { D3D12_RESOURCE_BARRIER b{}; b.Type=D3D12_RESOURCE_BARRIER_TYPE_UAV; b.UAV.pResource=res; d.list->ResourceBarrier(1,&b); }
    void uploadTexture(ID3D12Resource* target,const void* data,uint32_t rowBytes,uint32_t rows,uint32_t slices=1,uint32_t mip=0) {
        auto desc=target->GetDesc(); D3D12_PLACED_SUBRESOURCE_FOOTPRINT fp{}; UINT64 bytes=0; d.device->GetCopyableFootprints(&desc,mip,1,0,&fp,nullptr,nullptr,&bytes);
        auto upload=buffer(bytes,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ); void* mapped=nullptr; check(upload->Map(0,nullptr,&mapped),"Map texture upload");
        for(uint32_t z=0;z<slices;z++) for(uint32_t y=0;y<rows;y++) memcpy((uint8_t*)mapped+fp.Offset+(size_t(z)*rows+y)*fp.Footprint.RowPitch,(const uint8_t*)data+(size_t(z)*rows+y)*rowBytes,rowBytes);
        upload->Unmap(0,nullptr); D3D12_TEXTURE_COPY_LOCATION from{},to{}; from.pResource=upload.Get(); from.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT; from.PlacedFootprint=fp; to.pResource=target; to.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;to.SubresourceIndex=mip;
        d.list->CopyTextureRegion(&to,0,0,0,&from,nullptr); uploads.push_back(upload);
    }
    ComPtr<ID3D12Resource> uploadBuffer(const void* data,size_t bytes) {
        auto upload=buffer(bytes,D3D12_HEAP_TYPE_UPLOAD,D3D12_RESOURCE_STATE_GENERIC_READ); void* mapped=nullptr; check(upload->Map(0,nullptr,&mapped),"Map buffer upload"); memcpy(mapped,data,bytes); upload->Unmap(0,nullptr);
        auto result=buffer(bytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_COPY_DEST); d.list->CopyBufferRegion(result.Get(),0,upload.Get(),0,bytes); transition(result.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_GENERIC_READ); uploads.push_back(upload); return result;
    }
    void structured(ID3D12Resource* res,uint32_t slot,uint32_t count,uint32_t stride,bool write=false) {
        if(write) { D3D12_UNORDERED_ACCESS_VIEW_DESC v{}; v.ViewDimension=D3D12_UAV_DIMENSION_BUFFER; v.Buffer.NumElements=count; v.Buffer.StructureByteStride=stride; d.device->CreateUnorderedAccessView(res,nullptr,&v,cpu(slot)); }
        else { D3D12_SHADER_RESOURCE_VIEW_DESC v{}; v.ViewDimension=D3D12_SRV_DIMENSION_BUFFER; v.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING; v.Buffer.NumElements=count; v.Buffer.StructureByteStride=stride; d.device->CreateShaderResourceView(res,&v,cpu(slot)); }
    }
    void textureView(ID3D12Resource* res,uint32_t slot,bool write=false) {
        if(write) { D3D12_UNORDERED_ACCESS_VIEW_DESC v{}; v.ViewDimension=D3D12_UAV_DIMENSION_TEXTURE2D; v.Format=res->GetDesc().Format; d.device->CreateUnorderedAccessView(res,nullptr,&v,cpu(slot)); }
        else { D3D12_SHADER_RESOURCE_VIEW_DESC v{}; v.ViewDimension=D3D12_SRV_DIMENSION_TEXTURE2D; v.Format=res->GetDesc().Format; v.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING; v.Texture2D.MipLevels=res->GetDesc().MipLevels; d.device->CreateShaderResourceView(res,&v,cpu(slot)); }
    }
    std::vector<char> shader(const char* name) { std::ifstream f(directory/(std::string(name)+".cso"),std::ios::binary); std::vector<char> data((std::istreambuf_iterator<char>(f)),{}); if(data.empty()) throw std::runtime_error(std::string("Missing shader ")+name); return data; }
    ComPtr<ID3D12PipelineState> compute(const char* name) { auto code=shader(name); D3D12_COMPUTE_PIPELINE_STATE_DESC p{}; p.pRootSignature=root.Get(); p.CS={code.data(),code.size()}; ComPtr<ID3D12PipelineState> result; check(d.device->CreateComputePipelineState(&p,IID_PPV_ARGS(&result)),name); return result; }
    ComPtr<ID3D12PipelineState> graphicsFromBlobs(const char* pixel,const std::vector<char>& vs,const std::vector<char>& ps,bool blend,bool depthWrite,bool wire=false) {
        D3D12_GRAPHICS_PIPELINE_STATE_DESC p{}; p.pRootSignature=root.Get(); p.VS={vs.data(),vs.size()}; p.PS={ps.data(),ps.size()};
        p.RasterizerState.FillMode=wire?D3D12_FILL_MODE_WIREFRAME:D3D12_FILL_MODE_SOLID; p.RasterizerState.CullMode=D3D12_CULL_MODE_NONE; p.RasterizerState.FrontCounterClockwise=TRUE; p.RasterizerState.DepthClipEnable=TRUE;
        auto& b=p.BlendState.RenderTarget[0]; b.BlendEnable=blend; b.SrcBlend=D3D12_BLEND_SRC_ALPHA; b.DestBlend=D3D12_BLEND_INV_SRC_ALPHA; b.BlendOp=D3D12_BLEND_OP_ADD; b.SrcBlendAlpha=D3D12_BLEND_ONE; b.DestBlendAlpha=D3D12_BLEND_INV_SRC_ALPHA; b.BlendOpAlpha=D3D12_BLEND_OP_ADD; b.RenderTargetWriteMask=D3D12_COLOR_WRITE_ENABLE_ALL;
        p.DepthStencilState.DepthEnable=TRUE; p.DepthStencilState.DepthWriteMask=depthWrite?D3D12_DEPTH_WRITE_MASK_ALL:D3D12_DEPTH_WRITE_MASK_ZERO; p.DepthStencilState.DepthFunc=D3D12_COMPARISON_FUNC_LESS_EQUAL;
        p.PrimitiveTopologyType=D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE; p.NumRenderTargets=1; p.RTVFormats[0]=DXGI_FORMAT_R16G16B16A16_FLOAT; p.DSVFormat=DXGI_FORMAT_D32_FLOAT; p.SampleDesc.Count=blend?4:1; p.SampleMask=UINT_MAX;
        if(std::strcmp(pixel,"normalMain")==0) {
            p.NumRenderTargets=3;p.RTVFormats[0]=p.RTVFormats[1]=p.RTVFormats[2]=DXGI_FORMAT_R32G32B32A32_FLOAT;
        }
        if(std::strcmp(pixel,"aaColorMain")==0||std::strcmp(pixel,"aaOutlineMain")==0) {
            p.SampleDesc.Count=1;p.NumRenderTargets=3;p.RTVFormats[1]=DXGI_FORMAT_R16G16_FLOAT;p.RTVFormats[2]=DXGI_FORMAT_R32_FLOAT;
            p.BlendState.IndependentBlendEnable=TRUE;
            for(int i=1;i<3;i++){p.BlendState.RenderTarget[i]=b;p.BlendState.RenderTarget[i].BlendEnable=FALSE;}
        }
        ComPtr<ID3D12PipelineState> result; check(d.device->CreateGraphicsPipelineState(&p,IID_PPV_ARGS(&result)),pixel); return result;
    }
    ComPtr<ID3D12PipelineState> graphics(const char* pixel,bool blend,bool depthWrite,const char* vertex="vertexMain",bool wire=false) {
        return graphicsFromBlobs(pixel,shader(vertex),shader(pixel),blend,depthWrite,wire);
    }
    // Hot-swap the character color PSOs with a runtime-compiled user shader stack.
    // The vertex stage and all non-color passes stay unchanged. New PSOs are built
    // into locals first so a failure leaves the current set intact. Runs between
    // commands on the single-threaded loop, so swapping members is race-free.
    PsoSet buildPsoSet(const std::vector<char>& color,const std::vector<char>& aa,const std::vector<char>& vs) {
        PsoSet s;
        s.color=graphicsFromBlobs("colorMain",vs,color,true,true);
        s.transparent=graphicsFromBlobs("colorMain",vs,color,true,false);
        s.wire=graphicsFromBlobs("colorMain",vs,color,true,true,true);
        s.aaColor=graphicsFromBlobs("aaColorMain",vs,aa,true,true);
        s.aaTransparent=graphicsFromBlobs("aaColorMain",vs,aa,true,false);
        return s;
    }
    void loadShader(const std::vector<uint8_t>& packet) {
        if(packet.empty()){resetShader();return;}
        Reader r{packet};uint32_t colorLen=r.u32();const uint8_t* colorData=r.take(colorLen);uint32_t aaLen=r.u32();const uint8_t* aaData=r.take(aaLen);
        std::vector<char> color(colorData,colorData+colorLen),aa(aaData,aaData+aaLen),vs=shader("vertexMain");
        PsoSet s=buildPsoSet(color,aa,vs);
        colorPso=s.color;transparentPso=s.transparent;wirePso=s.wire;aaColorPso=s.aaColor;aaTransparentPso=s.aaTransparent;userShaderActive=true;
        // The surface shading changed: discard temporal history so DLAA converges
        // to the new result instead of blending it away against stale frames.
        aaHistoryValid=false;aaStableFrames=0;
    }
    void resetShader() {
        colorPso=graphics("colorMain",true,true);transparentPso=graphics("colorMain",true,false);
        wirePso=graphics("colorMain",true,true,"vertexMain",true);
        aaColorPso=graphics("aaColorMain",true,true);aaTransparentPso=graphics("aaColorMain",true,false);
        userShaderActive=false;aaHistoryValid=false;aaStableFrames=0;
    }
    // Load a library of per-material shader stacks (stackId -> PSO set). Built into
    // a local map first so a compile failure leaves the current library intact.
    void loadShaderLibrary(const std::vector<uint8_t>& packet) {
        Reader r{packet};uint32_t count=r.u32();
        std::unordered_map<uint32_t,PsoSet> next;
        std::unordered_map<uint32_t,bool> nextOutline;
        std::vector<char> vs=shader("vertexMain");
        for(uint32_t i=0;i<count;i++){
            uint32_t stackId=r.u32();uint32_t outline=r.u32();uint32_t colorLen=r.u32();const uint8_t* cd=r.take(colorLen);uint32_t aaLen=r.u32();const uint8_t* ad=r.take(aaLen);
            if(!stackId)throw std::runtime_error("stackId 0 is reserved for the base shader");
            std::vector<char> color(cd,cd+colorLen),aa(ad,ad+aaLen);
            next.emplace(stackId,buildPsoSet(color,aa,vs));
            nextOutline[stackId]=outline!=0;
        }
        stackPsos=std::move(next);stackOutline=std::move(nextOutline);
        aaHistoryValid=false;aaStableFrames=0;
    }
    // Per-material stackId assignment (indexed by native materialId; 0 = base).
    void setMaterialStacks(const std::vector<uint8_t>& packet) {
        Reader r{packet};uint32_t count=r.u32();
        materialStackIds.resize(count);
        for(uint32_t i=0;i<count;i++)materialStackIds[i]=r.u32();
    }
    void setParams(const std::vector<uint8_t>& packet) {
        void* mapped=nullptr;check(userParams->Map(0,nullptr,&mapped),"Map user params");
        memcpy(mapped,packet.data(),std::min<size_t>(packet.size(),65536));userParams->Unmap(0,nullptr);
    }
    void loadModel(const std::vector<uint8_t>& packet) {
        Reader r{packet}; vertexCount=r.u32(); uint32_t triangleCount=r.u32(), materialCount=r.u32(), textureCount=r.u32();
        if(vertexCount>5000000 || triangleCount>5000000 || materialCount>65536 || textureCount>128 || !triangleCount || !materialCount) throw std::runtime_error("Model exceeds native renderer limits");
        auto vertexData=r.take(size_t(vertexCount)*sizeof(NativeVertex)); auto triData=r.take(size_t(triangleCount)*sizeof(NativeTriangle)); auto matData=r.take(size_t(materialCount)*sizeof(NativeMaterial));
        triangles.resize(triangleCount); memcpy(triangles.data(),triData,size_t(triangleCount)*sizeof(NativeTriangle)); materials.resize(materialCount); memcpy(materials.data(),matData,size_t(materialCount)*sizeof(NativeMaterial));
        std::vector<uint32_t> indices; indices.reserve(size_t(triangleCount)*3);
        for(const auto& t:triangles) { if(t.a>=vertexCount||t.b>=vertexCount||t.c>=vertexCount||t.material>=materialCount) throw std::runtime_error("Invalid model indices"); indices.insert(indices.end(),{t.a,t.b,t.c}); }
        d.begin(); images.clear(); vertexBuffer=uploadBuffer(vertexData,size_t(vertexCount)*sizeof(NativeVertex)); triangleBuffer=uploadBuffer(triData,size_t(triangleCount)*sizeof(NativeTriangle)); materialBuffer=uploadBuffer(matData,size_t(materialCount)*sizeof(NativeMaterial)); indexBuffer=uploadBuffer(indices.data(),indices.size()*4);
        structured(vertexBuffer.Get(),0,vertexCount,32); structured(triangleBuffer.Get(),1,triangleCount,16); structured(materialBuffer.Get(),2,materialCount,sizeof(NativeMaterial));
        static const auto srgbLinear=[](){std::array<uint32_t,256>a{};for(uint32_t i=0;i<256;i++){double c=i/255.0;a[i]=uint32_t(std::round((c<=0.04045?c/12.92:std::pow((c+0.055)/1.055,2.4))*65535));}return a;}();
        static const auto linearSrgb=[](){std::array<uint8_t,65536>a{};for(uint32_t i=0;i<65536;i++){double c=i/65535.0;a[i]=uint8_t(std::round((c<=0.0031308?c*12.92:1.055*std::pow(c,1/2.4)-0.055)*255));}return a;}();
        for(uint32_t i=0;i<textureCount;i++) {
            uint32_t w=r.u32(),h=r.u32();bool srgb=r.u32()!=0;uint32_t encoding=r.u32(),suppliedMips=r.u32();
            if(!w||!h||w>8192||h>8192||!suppliedMips||suppliedMips>uint32_t(std::floor(std::log2(std::max(w,h)))+1))throw std::runtime_error("Invalid texture size/mips");
            if(encoding) {
                const DXGI_FORMAT formats[]{DXGI_FORMAT_UNKNOWN,DXGI_FORMAT_BC1_UNORM,DXGI_FORMAT_BC2_UNORM,DXGI_FORMAT_BC3_UNORM,DXGI_FORMAT_BC6H_SF16,DXGI_FORMAT_BC6H_UF16,DXGI_FORMAT_BC7_UNORM};
                if(encoding>=std::size(formats))throw std::runtime_error("Unsupported block texture format");
                auto tex=texture(w,h,formats[encoding],D3D12_RESOURCE_FLAG_NONE,D3D12_RESOURCE_STATE_COPY_DEST,1,false,uint16_t(suppliedMips));
                uint32_t mw=w,mh=h,blockBytes=encoding==1?8:16;
                for(uint32_t level=0;level<suppliedMips;level++) {
                    uint32_t rowBytes=((mw+3)/4)*blockBytes,rows=(mh+3)/4,bytes=r.u32();
                    if(bytes!=rowBytes*rows)throw std::runtime_error("Invalid block texture payload");
                    uploadTexture(tex.Get(),r.take(bytes),rowBytes,rows,1,level);mw=std::max(1u,mw/2);mh=std::max(1u,mh/2);
                }
                transition(tex.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_GENERIC_READ);textureView(tex.Get(),8+i);images.push_back(tex);continue;
            }
            if(suppliedMips!=1||r.u32()!=size_t(w)*h*4)throw std::runtime_error("Invalid RGBA texture payload");
            auto pixels=r.take(size_t(w)*h*4);
            uint16_t mipCount=uint16_t(std::floor(std::log2(std::max(w,h)))+1);
            auto tex=texture(w,h,DXGI_FORMAT_R8G8B8A8_UNORM,D3D12_RESOURCE_FLAG_NONE,D3D12_RESOURCE_STATE_COPY_DEST,1,false,mipCount);
            std::vector<uint8_t> previous(pixels,pixels+size_t(w)*h*4);uint32_t mw=w,mh=h;
            for(uint32_t level=0;level<mipCount;level++) {
                uploadTexture(tex.Get(),previous.data(),mw*4,mh,1,level);if(level+1==mipCount)break;
                uint32_t nw=std::max(1u,mw/2),nh=std::max(1u,mh/2);std::vector<uint8_t> next(size_t(nw)*nh*4);
                for(uint32_t y=0;y<nh;y++)for(uint32_t x=0;x<nw;x++)for(uint32_t c=0;c<4;c++){
                    uint32_t sum=0;for(uint32_t dy=0;dy<2;dy++)for(uint32_t dx=0;dx<2;dx++){auto value=previous[(size_t(std::min(y*2+dy,mh-1))*mw+std::min(x*2+dx,mw-1))*4+c];sum+=srgb&&c<3?srgbLinear[value]:value;}
                    next[(size_t(y)*nw+x)*4+c]=srgb&&c<3?linearSrgb[(sum+2)/4]:uint8_t((sum+2)/4);
                }previous=std::move(next);mw=nw;mh=nh;
            }
            transition(tex.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_GENERIC_READ);textureView(tex.Get(),8+i);images.push_back(tex); }
        buildAcceleration(); d.submit(); uploads.clear(); hasModel=true;
        previousVertexBuffer=vertexBuffer;historyValid=false;stableFrames=0;poseChanged=false;aaHistoryValid=false;aaStableFrames=0;
        materialStackIds.clear(); // stale per-material assignments; JS resends after load
    }
    void updatePose(const std::vector<uint8_t>& packet) {
        if(!hasModel || packet.size()!=size_t(vertexCount)*sizeof(NativeVertex))throw std::runtime_error("Invalid pose vertex count");
        d.begin();vertexBuffer=uploadBuffer(packet.data(),packet.size());structured(vertexBuffer.Get(),0,vertexCount,32);buildAcceleration();d.submit();uploads.clear();poseChanged=true;
    }
    void buildAcceleration() {
        D3D12_RAYTRACING_GEOMETRY_DESC geom{}; geom.Type=D3D12_RAYTRACING_GEOMETRY_TYPE_TRIANGLES;
        geom.Triangles.VertexBuffer={vertexBuffer->GetGPUVirtualAddress(),32}; geom.Triangles.VertexCount=vertexCount; geom.Triangles.VertexFormat=DXGI_FORMAT_R32G32B32_FLOAT;
        geom.Triangles.IndexBuffer=indexBuffer->GetGPUVirtualAddress(); geom.Triangles.IndexCount=UINT(triangles.size()*3); geom.Triangles.IndexFormat=DXGI_FORMAT_R32_UINT;
        D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_INPUTS in{}; in.Type=D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL; in.DescsLayout=D3D12_ELEMENTS_LAYOUT_ARRAY; in.NumDescs=1; in.pGeometryDescs=&geom; in.Flags=D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PREFER_FAST_TRACE;
        D3D12_RAYTRACING_ACCELERATION_STRUCTURE_PREBUILD_INFO sizes{}; d.device->GetRaytracingAccelerationStructurePrebuildInfo(&in,&sizes);
        blas=buffer(sizes.ResultDataMaxSizeInBytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        auto bottomScratch=buffer(sizes.ScratchDataSizeInBytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC build{}; build.Inputs=in; build.DestAccelerationStructureData=blas->GetGPUVirtualAddress(); build.ScratchAccelerationStructureData=bottomScratch->GetGPUVirtualAddress(); d.list->BuildRaytracingAccelerationStructure(&build,0,nullptr); uavBarrier(blas.Get()); uploads.push_back(bottomScratch);
        D3D12_RAYTRACING_INSTANCE_DESC instance{}; instance.Transform[0][0]=instance.Transform[1][1]=instance.Transform[2][2]=1; instance.InstanceMask=255; instance.AccelerationStructure=blas->GetGPUVirtualAddress(); instance.Flags=D3D12_RAYTRACING_INSTANCE_FLAG_TRIANGLE_FRONT_COUNTERCLOCKWISE;
        instances=uploadBuffer(&instance,sizeof(instance)); in={}; in.Type=D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL; in.DescsLayout=D3D12_ELEMENTS_LAYOUT_ARRAY; in.NumDescs=1; in.InstanceDescs=instances->GetGPUVirtualAddress(); in.Flags=D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PREFER_FAST_TRACE;
        d.device->GetRaytracingAccelerationStructurePrebuildInfo(&in,&sizes); tlas=buffer(sizes.ResultDataMaxSizeInBytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        scratch=buffer(sizes.ScratchDataSizeInBytes,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        build={}; build.Inputs=in; build.DestAccelerationStructureData=tlas->GetGPUVirtualAddress(); build.ScratchAccelerationStructureData=scratch->GetGPUVirtualAddress(); d.list->BuildRaytracingAccelerationStructure(&build,0,nullptr); uavBarrier(tlas.Get());
        D3D12_SHADER_RESOURCE_VIEW_DESC srv{}; srv.ViewDimension=D3D12_SRV_DIMENSION_RAYTRACING_ACCELERATION_STRUCTURE; srv.Shader4ComponentMapping=D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING; srv.RaytracingAccelerationStructure.Location=tlas->GetGPUVirtualAddress(); d.device->CreateShaderResourceView(nullptr,&srv,cpu(3));
    }
    void resize(uint32_t w,uint32_t h,uint32_t ow,uint32_t oh,uint32_t samples) {
        if(w==width&&h==height&&ow==outputWidth&&oh==outputHeight&&samples==colorSamples)return;
        if(!w||!h||w>4096||h>4096)throw std::runtime_error("Unsupported viewport size");width=w;height=h;outputWidth=ow;outputHeight=oh;colorSamples=samples;
        // Linear view depth must retain fp32 precision before CORTAO packs it.
        // Half depth turns sloped surfaces into steps at close/high-res views.
        normal=texture(w,h,DXGI_FORMAT_R32G32B32A32_FLOAT,D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,D3D12_RESOURCE_STATE_GENERIC_READ);
        hdr=texture(w,h,DXGI_FORMAT_R16G16B16A16_FLOAT,D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,D3D12_RESOURCE_STATE_GENERIC_READ);
        hdrMs.Reset();if(samples==4)hdrMs=texture(w,h,DXGI_FORMAT_R16G16B16A16_FLOAT,D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,D3D12_RESOURCE_STATE_RESOLVE_SOURCE,1,false,1,4);
        depthMs=texture(w,h,DXGI_FORMAT_D32_FLOAT,D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL,D3D12_RESOURCE_STATE_DEPTH_WRITE,1,false,1,samples);
        depth=texture(w,h,DXGI_FORMAT_D32_FLOAT,D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL,D3D12_RESOURCE_STATE_DEPTH_WRITE);
        aoTexture=texture(w,h,DXGI_FORMAT_R16G16B16A16_FLOAT,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_GENERIC_READ);
        const auto rw=D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
        for(uint32_t i=0;i<2;i++) {
            surfaces[i]=texture(w,h,DXGI_FORMAT_R32G32B32A32_FLOAT,rw|D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,D3D12_RESOURCE_STATE_GENERIC_READ);
            shadowHistories[i]=texture(w,h,DXGI_FORMAT_R16G16B16A16_FLOAT,rw,D3D12_RESOURCE_STATE_GENERIC_READ);
            shadowFilters[i]=texture(w,h,DXGI_FORMAT_R16G16B16A16_FLOAT,rw,D3D12_RESOURCE_STATE_GENERIC_READ);
            d.device->CreateRenderTargetView(surfaces[i].Get(),nullptr,rtv(2+i));
        }
        motion=texture(w,h,DXGI_FORMAT_R32G32B32A32_FLOAT,rw|D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,D3D12_RESOURCE_STATE_GENERIC_READ);
        shadowRawTexture=texture(w,h,DXGI_FORMAT_R16G16B16A16_FLOAT,rw,D3D12_RESOURCE_STATE_GENERIC_READ);
        shadowGuideTexture=texture(w,h,DXGI_FORMAT_R16G16B16A16_FLOAT,rw,D3D12_RESOURCE_STATE_GENERIC_READ);
        d.device->CreateRenderTargetView(motion.Get(),nullptr,rtv(4));
        textureView(motion.Get(),139);textureView(shadowRawTexture.Get(),140);textureView(shadowFilters[1].Get(),144);textureView(shadowGuideTexture.Get(),145);
        textureView(motion.Get(),164,true);textureView(shadowRawTexture.Get(),165,true);textureView(shadowGuideTexture.Get(),168,true);
        textureView(shadowFilters[0].Get(),146);textureView(shadowFilters[0].Get(),166,true);textureView(shadowFilters[1].Get(),169,true);
        aaOutput=texture(ow,oh,DXGI_FORMAT_R16G16B16A16_FLOAT,rw,D3D12_RESOURCE_STATE_GENERIC_READ);
        composite=texture(ow,oh,DXGI_FORMAT_R8G8B8A8_UNORM,rw,D3D12_RESOURCE_STATE_GENERIC_READ);
        textureView(composite.Get(),148);textureView(composite.Get(),173,true);
        aaMotion=texture(w,h,DXGI_FORMAT_R16G16_FLOAT,rw|D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,D3D12_RESOURCE_STATE_GENERIC_READ);
        aaDepth=texture(w,h,DXGI_FORMAT_R32_FLOAT,rw|D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,D3D12_RESOURCE_STATE_GENERIC_READ,1,false,1,1,1);
        aaExposure=texture(1,1,DXGI_FORMAT_R32_FLOAT,rw,D3D12_RESOURCE_STATE_GENERIC_READ);
        textureView(aaOutput.Get(),147);
        textureView(aaMotion.Get(),170,true);textureView(aaDepth.Get(),171,true);textureView(aaExposure.Get(),172,true);
        d.device->CreateRenderTargetView(aaMotion.Get(),nullptr,rtv(5));d.device->CreateRenderTargetView(aaDepth.Get(),nullptr,rtv(6));
        historyValid=false;stableFrames=0;aaHistoryValid=false;aaStableFrames=0;
        uint32_t total=0; for(uint32_t i=0;i<8;i++) { uint32_t mw=std::max(1u,w>>i),mh=std::max(1u,h>>i); mipInfo[i*4]=mw;mipInfo[i*4+1]=mh;mipInfo[i*4+2]=total;total+=mw*mh; }
        packedBuffer=buffer(size_t(total)*4,D3D12_HEAP_TYPE_DEFAULT,D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
        structured(packedBuffer.Get(),5,total,4);structured(packedBuffer.Get(),160,total,4,true);
        textureView(normal.Get(),4);textureView(aoTexture.Get(),6);textureView(hdr.Get(),136);textureView(aoTexture.Get(),161,true);
        d.device->CreateRenderTargetView(normal.Get(),nullptr,rtv(0));d.device->CreateRenderTargetView(samples==1?hdr.Get():hdrMs.Get(),nullptr,rtv(1));d.device->CreateDepthStencilView(depth.Get(),nullptr,dsvs->GetCPUDescriptorHandleForHeapStart());
        auto z=dsvs->GetCPUDescriptorHandleForHeapStart();z.ptr+=d.device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_DSV);d.device->CreateDepthStencilView(depthMs.Get(),nullptr,z);
    }
    void bindings(bool graphicsPass) {
        ID3D12DescriptorHeap* heaps[]{descriptors.Get()};d.list->SetDescriptorHeaps(1,heaps);
        if(graphicsPass) { d.list->SetGraphicsRootSignature(root.Get());d.list->SetGraphicsRootConstantBufferView(0,constants->GetGPUVirtualAddress());d.list->SetGraphicsRootDescriptorTable(2,gpu(0));d.list->SetGraphicsRootDescriptorTable(3,gpu(160)); }
        else { d.list->SetComputeRootSignature(root.Get());d.list->SetComputeRootConstantBufferView(0,constants->GetGPUVirtualAddress());d.list->SetComputeRootDescriptorTable(2,gpu(0));d.list->SetComputeRootDescriptorTable(3,gpu(160)); }
    }
    void draw(bool normals) {
        bindings(true); D3D12_VIEWPORT vp{0,0,float(width),float(height),0,1};D3D12_RECT rect{0,0,LONG(width),LONG(height)};d.list->RSSetViewports(1,&vp);d.list->RSSetScissorRects(1,&rect);
        auto target=rtv(normals?0:1),z=dsvs->GetCPUDescriptorHandleForHeapStart();if(!normals)z.ptr+=d.device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_DSV);d.list->OMSetRenderTargets(1,&target,FALSE,&z);float clear[4]{};d.list->ClearRenderTargetView(target,clear,0,nullptr);d.list->ClearDepthStencilView(z,D3D12_CLEAR_FLAG_DEPTH,1,0,0,nullptr);
        if(normals) {
            D3D12_CPU_DESCRIPTOR_HANDLE targets[]{target,rtv(2+shadowIndex),rtv(4)};
            d.list->OMSetRenderTargets(3,targets,FALSE,&z);d.list->ClearRenderTargetView(targets[1],clear,0,nullptr);d.list->ClearRenderTargetView(targets[2],clear,0,nullptr);
        }
        else if(colorSamples==1) {
            D3D12_CPU_DESCRIPTOR_HANDLE targets[]{target,rtv(5),rtv(6)};float farDepth[4]{1,1,1,1};
            d.list->OMSetRenderTargets(3,targets,FALSE,&z);d.list->ClearRenderTargetView(targets[1],clear,0,nullptr);d.list->ClearRenderTargetView(targets[2],farDepth,0,nullptr);
        }
        D3D12_INDEX_BUFFER_VIEW ib{indexBuffer->GetGPUVirtualAddress(),UINT(triangles.size()*12),DXGI_FORMAT_R32_UINT};d.list->IASetIndexBuffer(&ib);d.list->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        for(int pass=0;pass<(normals?1:2);pass++) for(size_t start=0;start<triangles.size();) {
            size_t end=start+1;uint32_t mat=triangles[start].material;while(end<triangles.size()&&triangles[end].material==mat)end++;
            bool transparent=materials[mat].options[1]>0;
            if(normals||int(transparent)==pass) {
                ID3D12PipelineState* pso=normalPso.Get();
                if(!normals){
                    uint32_t sid=mat<materialStackIds.size()?materialStackIds[mat]:0;
                    auto it=sid?stackPsos.find(sid):stackPsos.end();
                    const PsoSet* set=it!=stackPsos.end()?&it->second:nullptr;
                    bool dw=materials[mat].extra[3]>0;
                    if(wireframe)pso=set?set->wire.Get():wirePso.Get();
                    else if(colorSamples==1)pso=set?(dw?set->aaColor.Get():set->aaTransparent.Get()):(dw?aaColorPso.Get():aaTransparentPso.Get());
                    else pso=set?(dw?set->color.Get():set->transparent.Get()):(dw?colorPso.Get():transparentPso.Get());
                }
                d.list->SetPipelineState(pso);uint32_t values[4]{mat,0,UINT(start),0};d.list->SetGraphicsRoot32BitConstants(1,4,values,0);d.list->DrawIndexedInstanced(UINT((end-start)*3),1,UINT(start*3),0,0);
            }
            start=end;
        }
        if(!normals&&outlines){d.list->SetPipelineState(colorSamples==1?aaOutlinePso.Get():outlinePso.Get());for(size_t start=0;start<triangles.size();){size_t end=start+1;uint32_t mat=triangles[start].material;while(end<triangles.size()&&triangles[end].material==mat)end++;uint32_t sid=mat<materialStackIds.size()?materialStackIds[mat]:0;auto ot=stackOutline.find(sid);if(ot!=stackOutline.end()&&ot->second){uint32_t values[4]{mat,0,0,0};d.list->SetGraphicsRoot32BitConstants(1,4,values,0);d.list->DrawIndexedInstanced(UINT((end-start)*3),1,UINT(start*3),0,0);}start=end;}}
    }
    void denoiseShadows() {
        bindings(false);
        for(auto* resource:{surfaces[shadowIndex].Get(),motion.Get(),shadowRawTexture.Get(),shadowGuideTexture.Get()})transition(resource,D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        d.list->SetPipelineState(shadowTracePso.Get());d.list->Dispatch((width+7)/8,(height+7)/8,1);
        for(auto* resource:{surfaces[shadowIndex].Get(),motion.Get(),shadowRawTexture.Get(),shadowGuideTexture.Get()})transition(resource,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_GENERIC_READ);
        transition(shadowHistories[shadowIndex].Get(),D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        d.list->SetPipelineState(shadowTemporalPso.Get());d.list->Dispatch((width+7)/8,(height+7)/8,1);
        transition(shadowHistories[shadowIndex].Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_GENERIC_READ);
        for(uint32_t i=0;i<2;i++) {
            transition(shadowFilters[i].Get(),D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
            d.list->SetPipelineState(i?shadowFinalPso.Get():shadowSpatialPso.Get());d.list->Dispatch((width+7)/8,(height+7)/8,1);
            transition(shadowFilters[i].Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_GENERIC_READ);
        }
    }
    void reconstructAA(float jitterX,float jitterY,bool reset,float milliseconds) {
        bindings(false);
        for(auto* resource:{aaExposure.Get(),aaDepth.Get(),aaMotion.Get()})transition(resource,D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        d.list->SetPipelineState(aaPreparePso.Get());d.list->Dispatch((width+7)/8,(height+7)/8,1);
        for(auto* resource:{aaExposure.Get(),aaDepth.Get(),aaMotion.Get()})transition(resource,D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_GENERIC_READ);
        transition(aaOutput.Get(),D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        dlss.evaluate(hdr.Get(),aaDepth.Get(),aaMotion.Get(),aaExposure.Get(),aaOutput.Get(),jitterX,jitterY,reset,milliseconds);
        transition(aaOutput.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_GENERIC_READ);
        // NGX changes root signatures/descriptor heaps; output must rebind all its state.
        bindings(false);
    }
    static float halton(uint32_t index,uint32_t base){float result=0,f=1;while(index){f/=float(base);result+=f*(index%base);index/=base;}return result;}
    std::string render(const std::vector<uint8_t>& packet) {
        if(!hasModel)throw std::runtime_error("Load a model before rendering");Reader r{packet};uint32_t id=r.u32();float frame[76];memcpy(frame,r.take(sizeof(frame)),sizeof(frame));
        wireframe=frame[55]>0;outlines=frame[63]>0&&!wireframe;
        for(float f:frame)if(!std::isfinite(f))throw std::runtime_error("Invalid frame constants");
        frame[72]=std::clamp(frame[72],0.0f,1.0f);
        if(frame[44]<1||frame[45]<1||frame[44]>4096||frame[45]>4096)throw std::runtime_error("Unsupported viewport size");
        uint32_t ow=uint32_t(frame[44]),oh=uint32_t(frame[45]);
        uint32_t requested=frame[53]>0||wireframe?0u:uint32_t(std::clamp(frame[67],0.0f,3.0f));
        bool modeChanged=dlss.configure(requested,ow,oh),aaActive=dlss.mode!=0;
        resize(dlss.inputWidth,dlss.inputHeight,ow,oh,aaActive?1:4);
        frame[44]=float(width);frame[45]=float(height);frame[63]*=float(width)/ow;
        acquireOutput(id);
        bool temporal=frame[50]>0&&frame[54]>=1&&frame[54]<=4&&frame[53]==0&&!wireframe;
        bool cameraChanged=std::memcmp(frame,previousFrame.data(),32*sizeof(float))!=0;
        // Sharpening (floats 72..75) is a pure post-process: deliberately outside
        // the appearance range so adjusting it never resets reconstruction history.
        bool appearanceChanged=std::memcmp(frame+32,previousFrame.data()+32,40*sizeof(float))!=0;
        bool aaReset=!aaHistoryValid||modeChanged||appearanceChanged;
        bool invalidate=!historyValid;
        for(int i:{32,33,34,46,50,54,60})if(std::abs(frame[i]-previousFrame[i])>0.000001f)invalidate=true;
        for(int i=16;i<32;i++)if(std::abs(frame[i]-previousFrame[i])>0.0001f)invalidate=aaReset=true;
        // Large camera cuts do not borrow unrelated history. Normal orbit/pan uses reprojection.
        for(int i=0;i<12;i++)if(std::abs(frame[i]-previousFrame[i])>0.5f)invalidate=aaReset=true;
        for(int i=12;i<15;i++)if(std::abs(frame[i]-previousFrame[i])>std::max(frame[62]*0.5f,0.001f))aaReset=true;
        if(invalidate||cameraChanged||poseChanged||!temporal)stableFrames=0;
        if(aaReset||cameraChanged||poseChanged||!aaActive)aaStableFrames=0;
        if(aaReset)aaSampleFrame=0;
        uint32_t phases=uint32_t(std::ceil(8.0f*float(ow)*oh/(float(width)*height)));
        uint32_t phase=(aaSampleFrame++%phases)+1;
        float jitter[4]{aaActive?halton(phase,2)-0.5f:0,aaActive?halton(phase,3)-0.5f:0,aaActive?previousJitter[0]:0,aaActive?previousJitter[1]:0};
        float aaParams[4]{float(ow),float(oh),aaActive?1.0f:0.0f,aaActive?std::log2(float(width)/ow):0.0f};
        uint32_t info[4]{samplingFrame++,invalidate?0u:1u,poseChanged?4u:32u,temporal?1u:0u};
        structured(previousVertexBuffer.Get(),137,vertexCount,32);
        textureView(surfaces[shadowIndex].Get(),138);textureView(surfaces[1-shadowIndex].Get(),142);textureView(surfaces[shadowIndex].Get(),163,true);
        textureView(shadowHistories[1-shadowIndex].Get(),141);textureView(shadowHistories[shadowIndex].Get(),143);textureView(shadowHistories[shadowIndex].Get(),167,true);
        void* mapped=nullptr;check(constants->Map(0,nullptr,&mapped),"Map constants");memcpy(mapped,frame,sizeof(frame));memcpy((uint8_t*)mapped+sizeof(frame),mipInfo.data(),sizeof(mipInfo));
        memcpy((uint8_t*)mapped+432,previousFrame.data(),128);memcpy((uint8_t*)mapped+560,info,sizeof(info));
        memcpy((uint8_t*)mapped+576,aaParams,sizeof(aaParams));memcpy((uint8_t*)mapped+592,jitter,sizeof(jitter));constants->Unmap(0,nullptr);
        auto began=std::chrono::steady_clock::now();d.begin();
        for(auto* resource:{normal.Get(),surfaces[shadowIndex].Get(),motion.Get()})transition(resource,D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_RENDER_TARGET);
        draw(true);
        for(auto* resource:{normal.Get(),surfaces[shadowIndex].Get(),motion.Get()})transition(resource,D3D12_RESOURCE_STATE_RENDER_TARGET,D3D12_RESOURCE_STATE_GENERIC_READ);
        if(temporal)denoiseShadows();
        bindings(false);transition(packedBuffer.Get(),D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);d.list->SetPipelineState(packPso.Get());d.list->Dispatch((width+7)/8,(height+7)/8,1);uavBarrier(packedBuffer.Get());
        for(uint32_t i=1;i<8;i++) {uint32_t values[4]{0,i,0,0};d.list->SetComputeRoot32BitConstants(1,4,values,0);d.list->SetPipelineState(mipPso.Get());d.list->Dispatch((mipInfo[i*4]+7)/8,(mipInfo[i*4+1]+7)/8,1);uavBarrier(packedBuffer.Get());}
        transition(packedBuffer.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_GENERIC_READ);transition(aoTexture.Get(),D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);d.list->SetPipelineState(aoPso.Get());d.list->Dispatch((width+7)/8,(height+7)/8,1);transition(aoTexture.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_GENERIC_READ);
        if(aaActive) {
            for(auto* resource:{hdr.Get(),aaMotion.Get(),aaDepth.Get()})transition(resource,D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_RENDER_TARGET);
            draw(false);
            for(auto* resource:{hdr.Get(),aaMotion.Get(),aaDepth.Get()})transition(resource,D3D12_RESOURCE_STATE_RENDER_TARGET,D3D12_RESOURCE_STATE_GENERIC_READ);
            float milliseconds=std::clamp(std::chrono::duration<float,std::milli>(began-lastRender).count(),1.0f,100.0f);
            reconstructAA(jitter[0],jitter[1],aaReset,milliseconds);
        } else {
            transition(hdrMs.Get(),D3D12_RESOURCE_STATE_RESOLVE_SOURCE,D3D12_RESOURCE_STATE_RENDER_TARGET);draw(false);transition(hdrMs.Get(),D3D12_RESOURCE_STATE_RENDER_TARGET,D3D12_RESOURCE_STATE_RESOLVE_SOURCE);transition(hdr.Get(),D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_RESOLVE_DEST);d.list->ResolveSubresource(hdr.Get(),0,hdrMs.Get(),0,DXGI_FORMAT_R16G16B16A16_FLOAT);transition(hdr.Get(),D3D12_RESOURCE_STATE_RESOLVE_DEST,D3D12_RESOURCE_STATE_GENERIC_READ);
        }
        bindings(false);
        // NVSharpen reads the finished sRGB composite, so outputMain targets an
        // intermediate surface and the NIS pass writes the shared output. AO debug
        // bypasses it; with amount 0 outputMain writes the shared output directly.
        bool sharpen=frame[72]>0&&frame[53]==0;
        if(sharpen) {
            NISConfig config{};
            NVSharpenUpdateConfig(config,frame[72],0,0,ow,oh,ow,oh,0,0,NISHDRMode::None);
            void* nisMapped=nullptr;check(nisConfig->Map(0,nullptr,&nisMapped),"Map NIS config");memcpy(nisMapped,&config,sizeof(config));nisConfig->Unmap(0,nullptr);
            transition(composite.Get(),D3D12_RESOURCE_STATE_GENERIC_READ,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
            transition(sharedOutput.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
            d.list->SetPipelineState(outputPso.Get());d.list->Dispatch((ow+7)/8,(oh+7)/8,1);
            transition(composite.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_GENERIC_READ);
            d.list->SetComputeRootSignature(nisRoot.Get());
            d.list->SetComputeRootConstantBufferView(0,nisConfig->GetGPUVirtualAddress());
            d.list->SetComputeRootDescriptorTable(1,gpu(148));
            d.list->SetComputeRootDescriptorTable(2,gpu(162));
            d.list->SetPipelineState(sharpenPso.Get());d.list->Dispatch((ow+31)/32,(oh+31)/32,1);
            transition(sharedOutput.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COMMON);
        } else {
            transition(sharedOutput.Get(),D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
            d.list->SetPipelineState(outputPso.Get());d.list->Dispatch((ow+7)/8,(oh+7)/8,1);
            transition(sharedOutput.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COMMON);
        }
        d.submit();
        historyValid=temporal;previousVertexBuffer=vertexBuffer;std::copy(std::begin(frame),std::end(frame),previousFrame.begin());poseChanged=false;shadowIndex=1-shadowIndex;
        aaHistoryValid=aaActive;previousJitter[0]=jitter[0];previousJitter[1]=jitter[1];lastRender=began;
        if(temporal)stableFrames=std::min(stableFrames+1,32u);
        if(aaActive)aaStableFrames=std::min(aaStableFrames+1,32u);
        const char* aaName=dlss.mode==1?"DLAA":dlss.mode==2?"DLSS Quality":dlss.mode==3?"DLSS Balanced":"MSAA 4x";
        double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-began).count();std::ostringstream s;s<<"{\"type\":\"frame\",\"id\":"<<id<<",\"handle\":\""<<uint64_t(remoteHandle)<<"\",\"width\":"<<ow<<",\"height\":"<<oh<<",\"renderWidth\":"<<width<<",\"renderHeight\":"<<height<<",\"antialiasing\":\""<<aaName<<"\",\"sharpen\":"<<uint32_t(std::lround(frame[72]*100))<<",\"aaReset\":"<<(aaReset?"true":"false")<<",\"renderMs\":"<<ms<<",\"aaAccumulating\":"<<(aaActive&&aaStableFrames<32?"true":"false")<<",\"shadowAccumulating\":"<<(temporal&&frame[46]>0&&stableFrames<32?"true":"false")<<'}';return s.str();
    }
};
