/* Diagnostic: load a 32-bit VST2 DLL, log every audioMaster opcode the plugin
 * issues during its entry call, and report what the entry returned.
 * Build (x86): cl /nologo probe32.c ole32.lib
 * Usage: probe32.exe <plugin.dll> [--com] [--cwd]
 */
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <objbase.h>

typedef intptr_t(__cdecl* AM)(void* eff, int32_t op, int32_t idx, intptr_t val, void* ptr, float opt);
typedef void* (__cdecl* Entry)(AM);

static intptr_t __cdecl master(void* eff, int32_t op, int32_t idx, intptr_t val, void* ptr, float opt) {
  uint32_t resvd1 = 0, magic = 0;
  if (eff && !IsBadReadPtr(eff, 48)) { magic = *(uint32_t*)eff; resvd1 = *(uint32_t*)((char*)eff + 40); }
  printf("  audioMaster op=%d idx=%d val=%lld ptr=%p eff=%p magic=0x%08X resvd1=0x%08X\n",
         op, idx, (long long)val, ptr, eff, magic, resvd1);
  fflush(stdout);
  switch (op) {
    case 1: return 2400;                 /* audioMasterVersion */
    case 2: return 0;                    /* currentId */
    case 6: return 1;                    /* wantMidi */
    case 16: return 44100;               /* getSampleRate */
    case 17: return 512;                 /* getBlockSize */
    case 32: strcpy((char*)ptr, "MyDAWProbe"); return 1; /* vendor */
    case 33: strcpy((char*)ptr, "MyDAWProbe"); return 1; /* product */
    case 34: return 1000;                /* vendorVersion */
    case 37: { const char* s = (const char*)ptr; printf("    canDo: %s\n", s ? s : "?"); return 0; }
    case 42: return 1;                   /* updateDisplay */
  }
  return 0;
}

int main(int argc, char** argv) {
  int useCom = 0, useCwd = 0, i;
  if (argc < 2) { printf("usage: probe32 <dll> [--com] [--cwd]\n"); return 2; }
  for (i = 2; i < argc; i++) {
    if (!strcmp(argv[i], "--com")) useCom = 1;
    if (!strcmp(argv[i], "--cwd")) useCwd = 1;
  }
  if (useCom) { CoInitialize(NULL); OleInitialize(NULL); printf("COM+OLE initialized (STA)\n"); }
  if (useCwd) {
    char dir[MAX_PATH]; strcpy(dir, argv[1]);
    char* s = strrchr(dir, '\\'); if (s) { *s = 0; SetCurrentDirectoryA(dir); printf("cwd=%s\n", dir); }
  }
  printf("LoadLibrary(%s)\n", argv[1]);
  HMODULE m = LoadLibraryA(argv[1]);
  if (!m) { printf("LoadLibrary FAILED err=%lu\n", GetLastError()); return 1; }
  Entry e = (Entry)GetProcAddress(m, "VSTPluginMain");
  const char* which = "VSTPluginMain";
  if (!e) { e = (Entry)GetProcAddress(m, "main"); which = "main"; }
  if (!e) { printf("no entry export\n"); return 1; }
  printf("calling %s...\n", which);
  void* fx = e(master);
  printf("entry returned %p\n", fx);
  if (fx) {
    uint32_t magic = *(uint32_t*)fx;
    printf("magic = 0x%08X (%s)\n", magic, magic == 0x56737450 ? "VstP OK" : "BAD");
    int32_t numPrograms = *(int32_t*)((char*)fx + 12);
    int32_t numParams = *(int32_t*)((char*)fx + 16);
    int32_t numIn = *(int32_t*)((char*)fx + 20);
    int32_t numOut = *(int32_t*)((char*)fx + 24);
    int32_t flags = *(int32_t*)((char*)fx + 28);
    int32_t uid = *(int32_t*)((char*)fx + 64);
    printf("programs=%d params=%d io=%d/%d flags=0x%X uniqueID=0x%08X\n",
           numPrograms, numParams, numIn, numOut, flags, uid);
  }
  return fx ? 0 : 1;
}
