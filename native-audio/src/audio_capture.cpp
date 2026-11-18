#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <tlhelp32.h>
#include <string>
#include <thread>
#include <atomic>
#include <vector>
#include <set>
#include <map>
#include <algorithm>
#include <cwctype>

template <class T> void SafeRelease(T **ppT) {
    if (*ppT) {
        (*ppT)->Release();
        *ppT = NULL;
    }
}

struct AudioPacket {
    std::vector<uint8_t> data;
    int channels;
    int sampleRate;
    int bitsPerSample;
};

// Completion Handler para ActivateAudioInterfaceAsync (requer IAgileObject)
class ActivateAudioInterfaceCompletionHandler : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
private:
    LONG _refCount = 1;
    HANDLE _hEvent = NULL;
    HRESULT _hrActivate = E_FAIL;
    IAudioClient *_pAudioClient = NULL;

public:
    ActivateAudioInterfaceCompletionHandler() {
        _hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
    }

    ~ActivateAudioInterfaceCompletionHandler() {
        if (_hEvent) CloseHandle(_hEvent);
        SafeRelease(&_pAudioClient);
    }

    // IUnknown
    IFACEMETHODIMP QueryInterface(REFIID riid, void **ppvObject) override {
        if (!ppvObject) return E_POINTER;
        if (riid == __uuidof(IUnknown) ||
            riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppvObject = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        if (riid == __uuidof(IAgileObject)) {
            *ppvObject = static_cast<IAgileObject*>(this);
            AddRef();
            return S_OK;
        }
        *ppvObject = NULL;
        return E_NOINTERFACE;
    }

    IFACEMETHODIMP_(ULONG) AddRef() override {
        return InterlockedIncrement(&_refCount);
    }

    IFACEMETHODIMP_(ULONG) Release() override {
        ULONG ref = InterlockedDecrement(&_refCount);
        if (ref == 0) delete this;
        return ref;
    }

    // IActivateAudioInterfaceCompletionHandler
    IFACEMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation *activateOperation) override {
        HRESULT hrActivateResult = E_FAIL;
        IUnknown *punkAudioInterface = NULL;

        HRESULT hr = activateOperation->GetActivateResult(&hrActivateResult, &punkAudioInterface);
        if (SUCCEEDED(hr) && SUCCEEDED(hrActivateResult) && punkAudioInterface) {
            punkAudioInterface->QueryInterface(__uuidof(IAudioClient), (void**)&_pAudioClient);
            _hrActivate = (_pAudioClient != NULL) ? S_OK : E_FAIL;
        } else {
            _hrActivate = FAILED(hrActivateResult) ? hrActivateResult : hr;
        }

        SafeRelease(&punkAudioInterface);
        SetEvent(_hEvent);
        return S_OK;
    }

    HRESULT WaitAndGetClient(IAudioClient **ppClient, DWORD timeoutMs = 5000) {
        DWORD waitResult = WaitForSingleObject(_hEvent, timeoutMs);
        if (waitResult != WAIT_OBJECT_0) return E_ABORT;
        if (SUCCEEDED(_hrActivate) && _pAudioClient) {
            *ppClient = _pAudioClient;
            _pAudioClient->AddRef();
            return S_OK;
        }
        return _hrActivate;
    }
};

static std::wstring ToLowerW(const std::wstring &str) {
    std::wstring res = str;
    std::transform(res.begin(), res.end(), res.begin(), [](wchar_t c) { return std::towlower(c); });
    return res;
}

// Busca o PID raiz (processo pai principal) de um executável como Discord.exe
static DWORD FindRootProcessByName(const std::vector<std::wstring> &targetNames) {
    HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnap == INVALID_HANDLE_VALUE) return 0;

    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(PROCESSENTRY32W);

    std::map<DWORD, DWORD> pidToParent;
    std::map<DWORD, std::wstring> pidToName;

    if (Process32FirstW(hSnap, &pe)) {
        do {
            std::wstring exeName = ToLowerW(pe.szExeFile);
            for (const auto &target : targetNames) {
                if (exeName == target) {
                    pidToParent[pe.th32ProcessID] = pe.th32ParentProcessID;
                    pidToName[pe.th32ProcessID] = exeName;
                    break;
                }
            }
        } while (Process32NextW(hSnap, &pe));
    }
    CloseHandle(hSnap);

    // Encontra o processo cujo pai NÃO está na mesma lista de processos (ou seja, é o processo raiz!)
    for (const auto &pair : pidToParent) {
        DWORD pid = pair.first;
        DWORD parentPid = pair.second;
        if (pidToParent.find(parentPid) == pidToParent.end()) {
            return pid;
        }
    }

    // Fallback para o primeiro encontrado
    if (!pidToParent.empty()) {
        return pidToParent.begin()->first;
    }
    return 0;
}

// Dado um PID qualquer (ex: vindo de uma janela HWND), sobe até o processo raiz do mesmo .exe
static DWORD GetRootProcessForPid(DWORD startPid) {
    if (startPid == 0) return 0;
    HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnap == INVALID_HANDLE_VALUE) return startPid;

    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(PROCESSENTRY32W);

    std::map<DWORD, DWORD> pidToParent;
    std::map<DWORD, std::wstring> pidToName;

    if (Process32FirstW(hSnap, &pe)) {
        do {
            pidToParent[pe.th32ProcessID] = pe.th32ParentProcessID;
            pidToName[pe.th32ProcessID] = ToLowerW(pe.szExeFile);
        } while (Process32NextW(hSnap, &pe));
    }
    CloseHandle(hSnap);

    if (pidToName.find(startPid) == pidToName.end()) return startPid;
    std::wstring targetExe = pidToName[startPid];

    DWORD current = startPid;
    std::set<DWORD> visited;
    while (visited.find(current) == visited.end()) {
        visited.insert(current);
        auto itParent = pidToParent.find(current);
        if (itParent == pidToParent.end()) break;
        DWORD parentPid = itParent->second;
        if (parentPid == 0 || pidToName.find(parentPid) == pidToName.end()) break;
        if (pidToName[parentPid] == targetExe) {
            current = parentPid;
        } else {
            break;
        }
    }
    return current;
}

class AudioCapturer {
private:
    IMMDeviceEnumerator *pEnumerator = NULL;
    IMMDevice *pDevice = NULL;
    IAudioClient *pAudioClient = NULL;
    IAudioCaptureClient *pCaptureClient = NULL;
    WAVEFORMATEX *pwfx = NULL;
    WAVEFORMATEX customFormat = {};
    bool usingCustomFormat = false;

    std::thread captureThread;
    std::atomic<bool> isRunning{false};
    Napi::ThreadSafeFunction tsfn;

    void CaptureLoop() {
        CoInitializeEx(NULL, COINIT_MULTITHREADED);

        WAVEFORMATEX *activeFormat = usingCustomFormat ? &customFormat : pwfx;
        UINT32 packetLength = 0;
        BYTE *pData = NULL;
        UINT32 numFramesAvailable = 0;
        DWORD flags = 0;

        // Acumulador de ~20ms para evitar excesso de chamadas IPC
        std::vector<uint8_t> accumBuffer;
        const size_t targetChunkBytes = activeFormat->nSamplesPerSec * activeFormat->nBlockAlign / 50; // 20ms
        accumBuffer.reserve(targetChunkBytes * 2);

        while (isRunning) {
            Sleep(5);

            HRESULT hr = pCaptureClient->GetNextPacketSize(&packetLength);
            if (FAILED(hr)) continue;

            while (packetLength != 0 && isRunning) {
                hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable, &flags, NULL, NULL);
                if (FAILED(hr)) break;

                if (numFramesAvailable > 0) {
                    size_t bytesToCopy = numFramesAvailable * activeFormat->nBlockAlign;
                    size_t oldSize = accumBuffer.size();
                    accumBuffer.resize(oldSize + bytesToCopy);

                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                        memset(accumBuffer.data() + oldSize, 0, bytesToCopy);
                    } else {
                        memcpy(accumBuffer.data() + oldSize, pData, bytesToCopy);
                    }

                    if (accumBuffer.size() >= targetChunkBytes) {
                        AudioPacket *packet = new AudioPacket();
                        packet->data = std::move(accumBuffer);
                        accumBuffer.clear();
                        accumBuffer.reserve(targetChunkBytes * 2);

                        packet->channels = activeFormat->nChannels;
                        packet->sampleRate = activeFormat->nSamplesPerSec;
                        packet->bitsPerSample = activeFormat->wBitsPerSample;

                        tsfn.NonBlockingCall(packet, [](Napi::Env env, Napi::Function jsCallback, AudioPacket *pkt) {
                            Napi::Buffer<uint8_t> nodeBuffer = Napi::Buffer<uint8_t>::Copy(env, pkt->data.data(), pkt->data.size());
                            jsCallback.Call({
                                env.Null(),
                                nodeBuffer,
                                Napi::Number::New(env, pkt->channels),
                                Napi::Number::New(env, pkt->sampleRate),
                                Napi::Number::New(env, pkt->bitsPerSample)
                            });
                            delete pkt;
                        });
                    }
                }

                hr = pCaptureClient->ReleaseBuffer(numFramesAvailable);
                if (FAILED(hr)) break;

                hr = pCaptureClient->GetNextPacketSize(&packetLength);
                if (FAILED(hr)) break;
            }
        }

        CoUninitialize();
    }

    HRESULT InitProcessLoopback(DWORD targetPid, PROCESS_LOOPBACK_MODE mode) {
        AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
        activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        activationParams.ProcessLoopbackParams.TargetProcessId = targetPid;
        activationParams.ProcessLoopbackParams.ProcessLoopbackMode = mode;

        PROPVARIANT activateParams = {};
        activateParams.vt = VT_BLOB;
        activateParams.blob.cbSize = sizeof(activationParams);
        activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

        ActivateAudioInterfaceCompletionHandler *pHandler = new ActivateAudioInterfaceCompletionHandler();
        IActivateAudioInterfaceAsyncOperation *pAsyncOp = NULL;

        HRESULT hr = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            __uuidof(IAudioClient),
            &activateParams,
            pHandler,
            &pAsyncOp
        );

        if (SUCCEEDED(hr)) {
            hr = pHandler->WaitAndGetClient(&pAudioClient, 5000);
        }

        SafeRelease(&pAsyncOp);
        pHandler->Release();

        if (FAILED(hr) || !pAudioClient) return FAILED(hr) ? hr : E_FAIL;

        // Formato padrão WebRTC: Float32, 2 canais (estéreo), 48000 Hz
        ZeroMemory(&customFormat, sizeof(customFormat));
        customFormat.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        customFormat.nChannels = 2;
        customFormat.nSamplesPerSec = 48000;
        customFormat.wBitsPerSample = 32;
        customFormat.nBlockAlign = (customFormat.nChannels * customFormat.wBitsPerSample) / 8;
        customFormat.nAvgBytesPerSec = customFormat.nSamplesPerSec * customFormat.nBlockAlign;
        customFormat.cbSize = 0;

        hr = pAudioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            200000, // 20ms buffer
            0,
            &customFormat,
            NULL
        );

        if (SUCCEEDED(hr)) {
            usingCustomFormat = true;
        }
        return hr;
    }

    HRESULT InitStandardEndpointLoopback() {
        HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&pEnumerator);
        if (FAILED(hr)) return hr;

        hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
        if (FAILED(hr)) return hr;

        hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&pAudioClient);
        if (FAILED(hr)) return hr;

        // Forçamos Float32 48kHz Estéreo com AUTOCONVERTPCM para consistência total no JS
        ZeroMemory(&customFormat, sizeof(customFormat));
        customFormat.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        customFormat.nChannels = 2;
        customFormat.nSamplesPerSec = 48000;
        customFormat.wBitsPerSample = 32;
        customFormat.nBlockAlign = 8;
        customFormat.nAvgBytesPerSec = 48000 * 8;
        customFormat.cbSize = 0;

        hr = pAudioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            200000,
            0,
            &customFormat,
            NULL
        );

        if (SUCCEEDED(hr)) {
            usingCustomFormat = true;
            return S_OK;
        }

        // Se AUTOCONVERTPCM falhar, usa GetMixFormat nativo
        hr = pAudioClient->GetMixFormat(&pwfx);
        if (FAILED(hr)) return hr;
        usingCustomFormat = false;
        return pAudioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200000, 0, pwfx, NULL);
    }

public:
    AudioCapturer() {}
    ~AudioCapturer() {
        Stop();
        Cleanup();
    }

    void Stop() {
        isRunning = false;
        if (captureThread.joinable()) {
            captureThread.join();
        }
        if (pAudioClient) {
            pAudioClient->Stop();
        }
        if (tsfn) {
            tsfn.Release();
            tsfn = NULL;
        }
    }

    void Cleanup() {
        if (pwfx) {
            CoTaskMemFree(pwfx);
            pwfx = NULL;
        }
        usingCustomFormat = false;
        SafeRelease(&pCaptureClient);
        SafeRelease(&pAudioClient);
        SafeRelease(&pDevice);
        SafeRelease(&pEnumerator);
    }

    std::string Start(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        Stop();
        Cleanup();

        // Suporta:
        // startCapture(callback)
        // startCapture(optionsObj, callback) -> optionsObj: { mode: "exclude-discord" | "window-only" | "all", windowHandle?: number }
        Napi::Function jsCallback;
        std::string mode = "exclude-discord";
        uint64_t windowHandleVal = 0;

        if (info.Length() >= 2 && info[0].IsObject() && info[1].IsFunction()) {
            Napi::Object opts = info[0].As<Napi::Object>();
            if (opts.Has("mode") && opts.Get("mode").IsString()) {
                mode = opts.Get("mode").As<Napi::String>().Utf8Value();
            }
            if (opts.Has("windowHandle") && opts.Get("windowHandle").IsNumber()) {
                windowHandleVal = opts.Get("windowHandle").As<Napi::Number>().Int64Value();
            }
            jsCallback = info[1].As<Napi::Function>();
        } else if (info.Length() >= 1 && info[0].IsFunction()) {
            jsCallback = info[0].As<Napi::Function>();
        } else {
            return "ERROR: Callback ausente";
        }

        CoInitializeEx(NULL, COINIT_MULTITHREADED);

        HRESULT hr = E_FAIL;
        std::string activeStrategy = "";

        if (mode == "window-only" && windowHandleVal != 0) {
            HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(windowHandleVal));
            DWORD winPid = 0;
            GetWindowThreadProcessId(hwnd, &winPid);
            DWORD rootPid = GetRootProcessForPid(winPid);
            if (rootPid != 0) {
                hr = InitProcessLoopback(rootPid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE);
                if (SUCCEEDED(hr)) {
                    activeStrategy = "window-only (PID " + std::to_string(rootPid) + ")";
                }
            }
        }

        if (FAILED(hr) && mode != "all") {
            // Procura se o Discord ou app de voz está aberto para excluir sua árvore de processos
            DWORD discordPid = FindRootProcessByName({
                L"discord.exe",
                L"discordptb.exe",
                L"discordcanary.exe",
                L"ts3client_win64.exe"
            });

            if (discordPid != 0) {
                hr = InitProcessLoopback(discordPid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE);
                if (SUCCEEDED(hr)) {
                    activeStrategy = "exclude-discord (PID " + std::to_string(discordPid) + ")";
                }
            } else {
                // Se o Discord não está aberto, exclui o próprio processo do nosso app para evitar eco interno
                DWORD selfRootPid = GetRootProcessForPid(GetCurrentProcessId());
                hr = InitProcessLoopback(selfRootPid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE);
                if (SUCCEEDED(hr)) {
                    activeStrategy = "exclude-self (PID " + std::to_string(selfRootPid) + ")";
                }
            }
        }

        // Fallback garantido: se Process Loopback falhar ou modo == "all", usa Endpoint Loopback padrão
        if (FAILED(hr)) {
            Cleanup();
            hr = InitStandardEndpointLoopback();
            if (SUCCEEDED(hr)) {
                activeStrategy = "standard-loopback";
            } else {
                return "ERROR: Falha ao inicializar loopback (" + std::to_string(hr) + ")";
            }
        }

        hr = pAudioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&pCaptureClient);
        if (FAILED(hr)) {
            Cleanup();
            return "ERROR: IAudioCaptureClient falhou";
        }

        tsfn = Napi::ThreadSafeFunction::New(env, jsCallback, "AudioCaptureLoop", 0, 1);

        hr = pAudioClient->Start();
        if (FAILED(hr)) {
            Cleanup();
            return "ERROR: pAudioClient->Start falhou";
        }

        isRunning = true;
        captureThread = std::thread(&AudioCapturer::CaptureLoop, this);

        WAVEFORMATEX *activeFormat = usingCustomFormat ? &customFormat : pwfx;
        char infoStr[256];
        sprintf_s(infoStr, "OK:%s [%dch %luHz %dbit]",
            activeStrategy.c_str(),
            activeFormat->nChannels,
            activeFormat->nSamplesPerSec,
            activeFormat->wBitsPerSample);

        return std::string(infoStr);
    }
};

AudioCapturer capturer;

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string result = capturer.Start(info);
    return Napi::String::New(env, result);
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    capturer.Stop();
    capturer.Cleanup();
    return Napi::String::New(env, "OK:Stopped");
}

// ─── Simulação Nativa de Mouse e Teclado (SendInput) ─────────────────────────
Napi::Value SendMouseInput(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) return env.Null();

    Napi::Object obj = info[0].As<Napi::Object>();
    std::string type = obj.Get("type").As<Napi::String>().Utf8Value();

    INPUT input = {0};
    input.type = INPUT_MOUSE;

    if (type == "move") {
        double normX = obj.Get("x").As<Napi::Number>().DoubleValue();
        double normY = obj.Get("y").As<Napi::Number>().DoubleValue();
        input.mi.dx = static_cast<LONG>(normX * 65535.0);
        input.mi.dy = static_cast<LONG>(normY * 65535.0);
        input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
        SendInput(1, &input, sizeof(INPUT));
    } else if (type == "down" || type == "up") {
        int button = obj.Get("button").As<Napi::Number>().Int32Value();
        bool isDown = (type == "down");
        DWORD flag = 0;
        if (button == 0) flag = isDown ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        else if (button == 1) flag = isDown ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        else if (button == 2) flag = isDown ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;

        if (flag != 0) {
            input.mi.dwFlags = flag;
            SendInput(1, &input, sizeof(INPUT));
        }
    } else if (type == "wheel") {
        int deltaY = obj.Get("deltaY").As<Napi::Number>().Int32Value();
        input.mi.dwFlags = MOUSEEVENTF_WHEEL;
        input.mi.mouseData = static_cast<DWORD>(-deltaY * 120);
        SendInput(1, &input, sizeof(INPUT));
    }
    return env.Null();
}

Napi::Value SendKeyboardInput(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) return env.Null();

    Napi::Object obj = info[0].As<Napi::Object>();
    std::string type = obj.Get("type").As<Napi::String>().Utf8Value();
    int vk = obj.Get("vk").As<Napi::Number>().Int32Value();

    INPUT input = {0};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = static_cast<WORD>(vk);
    input.ki.wScan = static_cast<WORD>(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC));
    input.ki.dwFlags = 0;

    if (vk == VK_RIGHT || vk == VK_LEFT || vk == VK_UP || vk == VK_DOWN ||
        vk == VK_HOME || vk == VK_END || vk == VK_PRIOR || vk == VK_NEXT ||
        vk == VK_INSERT || vk == VK_DELETE) {
        input.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
    }

    if (type == "up") {
        input.ki.dwFlags |= KEYEVENTF_KEYUP;
    }

    SendInput(1, &input, sizeof(INPUT));
    return env.Null();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "startCapture"), Napi::Function::New(env, StartCapture));
    exports.Set(Napi::String::New(env, "stopCapture"), Napi::Function::New(env, StopCapture));
    exports.Set(Napi::String::New(env, "sendMouseInput"), Napi::Function::New(env, SendMouseInput));
    exports.Set(Napi::String::New(env, "sendKeyboardInput"), Napi::Function::New(env, SendKeyboardInput));
    return exports;
}

NODE_API_MODULE(native_audio, Init)
