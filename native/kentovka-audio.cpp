// kentovka-audio.exe — захват звука системы БЕЗ звука самой Кентовки.
// Использует Windows Process Loopback (Windows 10 2004+ / Windows 11) в режиме
// EXCLUDE_TARGET_PROCESS_TREE: пишется всё, что играет на компе, кроме дерева процессов Кентовки
// (голоса кентов туда не попадут).
//
// Запуск: kentovka-audio.exe <pid Кентовки>                 — весь звук компа, кроме Кентовки
//         kentovka-audio.exe <pid Кентовки> window <hwnd>    — только звук программы, чьё это окно
//           (игра, браузер…): так в демку не попадут голоса из Discord и других звонилок
// Выход:  в stdout сырые PCM 16 бит, 48000 Гц, стерео. Ошибки — в stderr и код выхода != 0.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <propidl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

// из audioclientactivationparams.h (в MinGW его нет)
enum MY_ACTIVATION_TYPE { MY_ACTIVATION_TYPE_DEFAULT = 0, MY_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 };
enum MY_LOOPBACK_MODE { MY_LOOPBACK_INCLUDE_TREE = 0, MY_LOOPBACK_EXCLUDE_TREE = 1 };
struct MY_LOOPBACK_PARAMS { DWORD TargetProcessId; MY_LOOPBACK_MODE ProcessLoopbackMode; };
struct MY_ACTIVATION_PARAMS { MY_ACTIVATION_TYPE ActivationType; MY_LOOPBACK_PARAMS ProcessLoopbackParams; };

typedef HRESULT (WINAPI *PFN_ActivateAudioInterfaceAsync)(
    LPCWSTR, REFIID, PROPVARIANT *, IActivateAudioInterfaceCompletionHandler *, IActivateAudioInterfaceAsyncOperation **);

static void fail(const char *what, HRESULT hr) {
  fprintf(stderr, "kentovka-audio: %s failed, hr=0x%08lx\n", what, (unsigned long)hr);
  fflush(stderr);
  exit(2);
}

class ActivationHandler : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  LONG ref_ = 1;
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient *client = nullptr;

  STDMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (riid == IID_IUnknown || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
    } else if (riid == IID_IAgileObject) {
      *ppv = static_cast<IAgileObject *>(this);
    } else {
      *ppv = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref_); }
  STDMETHODIMP_(ULONG) Release() override {
    LONG r = InterlockedDecrement(&ref_);
    if (r == 0) delete this;
    return r;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation *op) override {
    HRESULT hrActivate = E_FAIL;
    IUnknown *unk = nullptr;
    result = op->GetActivateResult(&hrActivate, &unk);
    if (SUCCEEDED(result)) result = hrActivate;
    if (SUCCEEDED(result) && unk) result = unk->QueryInterface(__uuidof(IAudioClient), (void **)&client);
    if (unk) unk->Release();
    SetEvent(done);
    return S_OK;
  }
};

static bool writeAll(HANDLE out, const void *data, DWORD size) {
  const BYTE *p = (const BYTE *)data;
  while (size) {
    DWORD written = 0;
    if (!WriteFile(out, p, size, &written, nullptr) || written == 0) return false;
    p += written;
    size -= written;
  }
  return true;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: kentovka-audio <pid> [window <hwnd>]\n"); return 1; }
  DWORD pid = (DWORD)strtoul(argv[1], nullptr, 10);
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, pid);
  DWORD target = pid;
  MY_LOOPBACK_MODE mode = MY_LOOPBACK_EXCLUDE_TREE;
  if (argc >= 4 && strcmp(argv[2], "window") == 0) {
    HWND hwnd = (HWND)(uintptr_t)_strtoui64(argv[3], nullptr, 10);
    DWORD wpid = 0;
    if (hwnd && GetWindowThreadProcessId(hwnd, &wpid) && wpid && wpid != pid) { target = wpid; mode = MY_LOOPBACK_INCLUDE_TREE; }
    else fprintf(stderr, "kentovka-audio: window not found, capturing everything except Kentovka\n");
  }
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) fail("CoInitializeEx", hr);

  HMODULE mmdev = LoadLibraryW(L"Mmdevapi.dll");
  auto activate = mmdev ? (PFN_ActivateAudioInterfaceAsync)GetProcAddress(mmdev, "ActivateAudioInterfaceAsync") : nullptr;
  if (!activate) fail("ActivateAudioInterfaceAsync lookup", E_NOTIMPL);

  MY_ACTIVATION_PARAMS params = {};
  params.ActivationType = MY_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = target;
  params.ProcessLoopbackParams.ProcessLoopbackMode = mode;

  PROPVARIANT pv;
  PropVariantInit(&pv);
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = (BYTE *)&params;

  auto *handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation *op = nullptr;
  hr = activate(L"VAD\\Process_Loopback", __uuidof(IAudioClient), &pv, handler, &op);
  if (FAILED(hr)) fail("ActivateAudioInterfaceAsync", hr);
  if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) fail("activation timeout", E_FAIL);
  if (FAILED(handler->result) || !handler->client) fail("activation", handler->result);
  IAudioClient *client = handler->client;

  WAVEFORMATEX wf = {};
  wf.wFormatTag = WAVE_FORMAT_PCM;
  wf.nChannels = 2;
  wf.nSamplesPerSec = 48000;
  wf.wBitsPerSample = 16;
  wf.nBlockAlign = wf.nChannels * wf.wBitsPerSample / 8;
  wf.nAvgBytesPerSec = wf.nSamplesPerSec * wf.nBlockAlign;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                              AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                          200000 /* 20 мс */, 0, &wf, nullptr);
  if (FAILED(hr)) fail("IAudioClient::Initialize", hr);

  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(ready);
  if (FAILED(hr)) fail("SetEventHandle", hr);

  IAudioCaptureClient *capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), (void **)&capture);
  if (FAILED(hr)) fail("GetService", hr);

  hr = client->Start();
  if (FAILED(hr)) fail("Start", hr);
  fprintf(stderr, mode == MY_LOOPBACK_INCLUDE_TREE ? "kentovka-audio: started (window %lu)\n" : "kentovka-audio: started\n", (unsigned long)target);
  fflush(stderr);

  static BYTE zeros[48000 * 4];
  for (;;) {
    WaitForSingleObject(ready, 100);
    if (parent && WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) break; // Кентовка закрылась
    UINT32 packet = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE *data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) fail("GetBuffer", hr);
      DWORD bytes = frames * wf.nBlockAlign;
      bool ok = (flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data
                    ? writeAll(out, zeros, bytes < sizeof(zeros) ? bytes : (DWORD)sizeof(zeros))
                    : writeAll(out, data, bytes);
      capture->ReleaseBuffer(frames);
      if (!ok) goto done; // приложение закрыло трубу
    }
  }
done:
  client->Stop();
  return 0;
}
