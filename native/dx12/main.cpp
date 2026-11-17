#include <windows.h>
#include <d3d12.h>
#include <d3d12sdklayers.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <iostream>
#include <string>
#include <stdexcept>
#include <vector>
#include <cstdint>
#include <sstream>
#include <cmath>
#include <io.h>
#include <fcntl.h>

using Microsoft::WRL::ComPtr;
static void check(HRESULT hr, const char* what) {
    if (FAILED(hr)) { std::ostringstream s; s << what << " (HRESULT 0x" << std::hex << uint32_t(hr) << ")"; throw std::runtime_error(s.str()); }
}
static std::string utf8(const wchar_t* s) {
    int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, nullptr, 0, nullptr, nullptr);
    std::string result(n, '\0'); WideCharToMultiByte(CP_UTF8, 0, s, -1, result.data(), n, nullptr, nullptr); result.pop_back(); return result;
}
static std::string quoted(const std::string& s) {
    std::string r = "\""; for (char c : s) { if (c == '\\' || c == '"') r += '\\'; if (c == '\n') r += "\\n"; else r += c; } return r + '"';
}
struct Device {
    ComPtr<IDXGIFactory6> factory;
    ComPtr<IDXGIAdapter1> adapter;
    ComPtr<ID3D12Device5> device;
    ComPtr<ID3D12CommandQueue> queue;
    ComPtr<ID3D12CommandAllocator> allocator;
    ComPtr<ID3D12GraphicsCommandList4> list;
    ComPtr<ID3D12Fence> fence;
    HANDLE event = nullptr;
    uint64_t fenceValue = 0;
    std::string name;
    D3D12_FEATURE_DATA_D3D12_OPTIONS5 rt{};
    D3D12_FEATURE_DATA_D3D12_OPTIONS6 vrs{};
    D3D12_FEATURE_DATA_D3D12_OPTIONS7 ultimate{};
    Device() {
        if (GetEnvironmentVariableW(L"MMDCONV_DX12_VALIDATION", nullptr, 0)) {
            ComPtr<ID3D12Debug> debug;
            if (SUCCEEDED(D3D12GetDebugInterface(IID_PPV_ARGS(&debug)))) debug->EnableDebugLayer();
        }
        struct Version { ULONG size, major, minor, build, platform; WCHAR service[128]; } os{sizeof(Version)};
        auto getVersion = reinterpret_cast<LONG(WINAPI*)(Version*)>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
        if (!getVersion || getVersion(&os) != 0 || os.build < 22000) throw std::runtime_error("Windows 11 is required.");
        check(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)), "Create DXGI factory");
        for (UINT i = 0; factory->EnumAdapterByGpuPreference(i, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IID_PPV_ARGS(&adapter)) != DXGI_ERROR_NOT_FOUND; ++i) {
            DXGI_ADAPTER_DESC1 desc{}; adapter->GetDesc1(&desc);
            if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) { adapter.Reset(); continue; }
            if (SUCCEEDED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_12_2, IID_PPV_ARGS(&device)))) { name = utf8(desc.Description); break; }
            adapter.Reset();
        }
        if (!device) throw std::runtime_error("A DirectX 12 Ultimate (feature level 12_2) GPU is required.");
        check(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS5, &rt, sizeof(rt)), "Query DXR");
        check(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS6, &vrs, sizeof(vrs)), "Query VRS");
        check(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS7, &ultimate, sizeof(ultimate)), "Query mesh/sampler feedback");
        if (rt.RaytracingTier < D3D12_RAYTRACING_TIER_1_1) throw std::runtime_error("DXR 1.1 is required.");
        D3D12_COMMAND_QUEUE_DESC q{}; q.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
        check(device->CreateCommandQueue(&q, IID_PPV_ARGS(&queue)), "Create queue");
        check(device->CreateCommandAllocator(q.Type, IID_PPV_ARGS(&allocator)), "Create allocator");
        check(device->CreateCommandList(0, q.Type, allocator.Get(), nullptr, IID_PPV_ARGS(&list)), "Create command list");
        check(list->Close(), "Close initial list");
        check(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence)), "Create fence");
        event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!event) throw std::runtime_error("Create fence event failed");
    }
    ~Device() { if (event) CloseHandle(event); }
    void begin() { check(allocator->Reset(), "Reset allocator"); check(list->Reset(allocator.Get(), nullptr), "Reset command list"); }
    void submit() {
        check(list->Close(), "Close list"); ID3D12CommandList* lists[]{list.Get()}; queue->ExecuteCommandLists(1, lists);
        check(queue->Signal(fence.Get(), ++fenceValue), "Signal fence");
        if (fence->GetCompletedValue() < fenceValue) { check(fence->SetEventOnCompletion(fenceValue, event), "Wait fence"); if (WaitForSingleObject(event, 10000) != WAIT_OBJECT_0) { check(device->GetDeviceRemovedReason(), "GPU wait failed"); throw std::runtime_error("GPU timed out"); } }
        ComPtr<ID3D12InfoQueue> info;
        if (SUCCEEDED(device.As(&info))) {
            for (UINT64 i=0;i<info->GetNumStoredMessagesAllowedByRetrievalFilter();i++) { SIZE_T size=0; info->GetMessage(i,nullptr,&size); std::vector<uint8_t> data(size); auto message=reinterpret_cast<D3D12_MESSAGE*>(data.data()); info->GetMessage(i,message,&size); if(message->Severity<=D3D12_MESSAGE_SEVERITY_WARNING)std::cerr<<message->pDescription<<std::endl; }
            info->ClearStoredMessages();
        }
        check(device->GetDeviceRemovedReason(), "Device removed");
    }
    std::string capabilities() const {
        std::ostringstream s; s << "{\"backend\":\"DirectX 12 Ultimate\",\"gpu\":" << quoted(name)
            << ",\"featureLevel\":\"12_2\",\"dxrTier\":" << int(rt.RaytracingTier)
            << ",\"meshShaderTier\":" << int(ultimate.MeshShaderTier) << ",\"vrsTier\":" << int(vrs.VariableShadingRateTier)
            << ",\"samplerFeedbackTier\":" << int(ultimate.SamplerFeedbackTier) << '}'; return s.str();
    }
};
#include "renderer.h"
int main(int argc, char** argv) {
    try {
        Device device;
        if (argc > 2 && std::string(argv[1]) == "--serve") {
            _setmode(_fileno(stdin), _O_BINARY);
            auto directory=std::filesystem::absolute(argv[0]).parent_path();
            NativeRenderer renderer(device,directory,DWORD(std::stoul(argv[2])));
            std::cout << "{\"type\":\"ready\",\"capabilities\":" << device.capabilities() << "}" << std::endl;
            uint32_t header[2];
            while(std::cin.read(reinterpret_cast<char*>(header),sizeof(header))) {
                if(header[1]>512u*1024u*1024u)throw std::runtime_error("Native packet too large");
                std::vector<uint8_t> payload(header[1]);if(!std::cin.read(reinterpret_cast<char*>(payload.data()),payload.size()))break;
                if(header[0]==1) {renderer.loadModel(payload);std::cout<<"{\"type\":\"model\"}"<<std::endl;}
                else if(header[0]==2)std::cout<<renderer.render(payload)<<std::endl;
                else if(header[0]==3){Reader r{payload};renderer.release(r.u32());}
                else if(header[0]==5){renderer.updatePose(payload);std::cout<<"{\"type\":\"pose\"}"<<std::endl;}
                else if(header[0]==4)break;
                else if(header[0]!=3)throw std::runtime_error("Unknown native command");
            }
        } else if (argc > 2 && std::string(argv[1]) == "--share-test") {
            HANDLE parent = OpenProcess(PROCESS_DUP_HANDLE, FALSE, DWORD(std::stoul(argv[2])));
            if (!parent) throw std::runtime_error("Open parent process failed");
            D3D12_HEAP_PROPERTIES heap{}; heap.Type = D3D12_HEAP_TYPE_DEFAULT;
            D3D12_RESOURCE_DESC desc{}; desc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D; desc.Width = 64; desc.Height = 64;
            desc.DepthOrArraySize = 1; desc.MipLevels = 1; desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 1;
            desc.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET | D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
            ComPtr<ID3D12Resource> texture;
            check(device.device->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_SHARED, &desc, D3D12_RESOURCE_STATE_RENDER_TARGET, nullptr, IID_PPV_ARGS(&texture)), "Create shared output");
            D3D12_DESCRIPTOR_HEAP_DESC hd{}; hd.NumDescriptors = 1; hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
            ComPtr<ID3D12DescriptorHeap> rtvs; check(device.device->CreateDescriptorHeap(&hd, IID_PPV_ARGS(&rtvs)), "Create RTV heap");
            device.device->CreateRenderTargetView(texture.Get(), nullptr, rtvs->GetCPUDescriptorHandleForHeapStart());
            device.begin(); float color[]{0.2f, 0.4f, 0.8f, 1.0f};
            device.list->ClearRenderTargetView(rtvs->GetCPUDescriptorHandleForHeapStart(), color, 0, nullptr);
            D3D12_RESOURCE_BARRIER barrier{}; barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
            barrier.Transition = {texture.Get(), D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES, D3D12_RESOURCE_STATE_RENDER_TARGET, D3D12_RESOURCE_STATE_COMMON};
            device.list->ResourceBarrier(1, &barrier); device.submit();
            HANDLE local = nullptr, remote = nullptr;
            check(device.device->CreateSharedHandle(texture.Get(), nullptr, GENERIC_ALL, nullptr, &local), "Create shared handle");
            if (!DuplicateHandle(GetCurrentProcess(), local, parent, &remote, 0, FALSE, DUPLICATE_SAME_ACCESS)) throw std::runtime_error("Duplicate shared handle failed");
            CloseHandle(local);
            std::cout << "{\"handle\":\"" << uint64_t(remote) << "\",\"width\":64,\"height\":64}" << std::endl;
            std::string release; std::getline(std::cin, release);
            HANDLE reclaimed = nullptr;
            if (DuplicateHandle(parent, remote, GetCurrentProcess(), &reclaimed, 0, FALSE, DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE)) CloseHandle(reclaimed);
            CloseHandle(parent);
        } else { std::cout << device.capabilities() << std::endl; }
        return 0;
    }
    catch (const std::exception& e) { std::cerr << e.what() << std::endl; return 1; }
}
