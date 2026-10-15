#define UNICODE
#define _UNICODE
#define SECURITY_WIN32
#include <windows.h>
#include <objbase.h>
#include <wincred.h>
#include <security.h>
#include <cstdio>
#include <string>
#include <vector>

// Password buffers never leave this process; no argv/stdin password input,
// credential storage, network submission, impersonation or process creation.
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value) CloseHandle(value); }
};
struct Secret {
  std::vector<wchar_t> value;
  explicit Secret(size_t size) : value(size, 0) {}
  ~Secret() { SecureZeroMemory(value.data(), value.size() * sizeof(wchar_t)); }
};
struct AuthBuffer {
  void* value = nullptr;
  ULONG size = 0;
  ~AuthBuffer() {
    if (value) { SecureZeroMemory(value, size); CoTaskMemFree(value); }
  }
};

int result(const char* outcome, DWORD code = 0) {
  std::printf("{\"schemaVersion\":1,\"platform\":\"win32\",\"strategy\":\"current-user-password\",\"outcome\":\"%s\",\"code\":%lu}\n", outcome, code);
  return std::string(outcome) == "authenticated" || std::string(outcome) == "available" ? 0 : 1;
}

bool tokenUser(HANDLE token, std::vector<BYTE>& storage) {
  DWORD bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes == 0 || bytes > 65536) return false;
  storage.resize(bytes);
  return GetTokenInformation(token, TokenUser, storage.data(), bytes, &bytes) != FALSE;
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2 || (std::wstring(argv[1]) != L"--check" && std::wstring(argv[1]) != L"--authenticate"))
    return result("invalid-request");
  DWORD sessionID = 0, returned = 0;
  USEROBJECTFLAGS stationFlags{};
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &sessionID) || sessionID == 0 ||
      !GetUserObjectInformationW(GetProcessWindowStation(), UOI_FLAGS, &stationFlags, sizeof(stationFlags), &returned) ||
      !(stationFlags.dwFlags & WSF_VISIBLE)) return result("unavailable");
  Handle current;
  std::vector<BYTE> currentUser;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &current.value) || !tokenUser(current.value, currentUser))
    return result("unavailable", GetLastError());
  if (std::wstring(argv[1]) == L"--check") return result("available");

  wchar_t account[512]{};
  ULONG accountLength = 512;
  if (!GetUserNameExW(NameSamCompatible, account, &accountLength)) return result("unavailable", GetLastError());
  DWORD packedBytes = 0;
  CredPackAuthenticationBufferW(CRED_PACK_GENERIC_CREDENTIALS, account, const_cast<wchar_t*>(L""), nullptr, &packedBytes);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || packedBytes == 0 || packedBytes > 65536)
    return result("unavailable", GetLastError());
  std::vector<BYTE> packed(packedBytes);
  if (!CredPackAuthenticationBufferW(CRED_PACK_GENERIC_CREDENTIALS, account, const_cast<wchar_t*>(L""), packed.data(), &packedBytes))
    return result("unavailable", GetLastError());

  CREDUI_INFOW ui{};
  ui.cbSize = sizeof(ui);
  ui.pszCaptionText = L"即我电脑密码验证";
  ui.pszMessageText = L"请输入当前 Windows 用户的登录密码。此验证不接受其他用户的密码，也不会保存密码。";
  AuthBuffer output;
  ULONG package = 0;
  BOOL save = FALSE;
  // GENERIC intentionally requests username/password rather than accepting a
  // Windows Hello/PIN blob as password-path evidence. The dialog is not proof:
  // LogonUser + equality with the process token's SID are both mandatory.
  DWORD status = CredUIPromptForWindowsCredentialsW(&ui, 0, &package, packed.data(), packedBytes,
                                                   &output.value, &output.size, &save, CREDUIWIN_GENERIC);
  SecureZeroMemory(packed.data(), packed.size());
  if (status == ERROR_CANCELLED) return result("cancelled", status);
  if (status != ERROR_SUCCESS) return result("failed", status);
  if (!output.value || output.size == 0 || output.size > 1024 * 1024) return result("failed", ERROR_INVALID_DATA);

  DWORD userLength = 0, domainLength = 0, passwordLength = 0;
  CredUnPackAuthenticationBufferW(0, output.value, output.size, nullptr, &userLength,
                                nullptr, &domainLength, nullptr, &passwordLength);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || userLength == 0 || passwordLength == 0 ||
      userLength > 4096 || domainLength > 4096 || passwordLength > 4096)
    return result("failed", ERROR_INVALID_DATA);
  Secret user(userLength), domain(domainLength ? domainLength : 1), password(passwordLength);
  if (!CredUnPackAuthenticationBufferW(0, output.value, output.size, user.value.data(), &userLength,
                                      domain.value.data(), &domainLength, password.value.data(), &passwordLength))
    return result("failed", GetLastError());
  // An empty password is not acceptable proof for unlocking protected content.
  if (password.value[0] == L'\0') return result("failed", ERROR_LOGON_FAILURE);
  std::wstring userName(user.value.data()), domainName(domain.value.data());
  const auto slash = userName.find(L'\\');
  if (slash != std::wstring::npos) {
    domainName = userName.substr(0, slash);
    userName = userName.substr(slash + 1);
  }
  Handle verified;
  if (!LogonUserW(userName.c_str(), domainName.empty() ? nullptr : domainName.c_str(), password.value.data(),
                  LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, &verified.value))
    return result("failed", GetLastError());
  std::vector<BYTE> verifiedUser;
  if (!tokenUser(verified.value, verifiedUser) ||
      !EqualSid(reinterpret_cast<TOKEN_USER*>(currentUser.data())->User.Sid,
                reinterpret_cast<TOKEN_USER*>(verifiedUser.data())->User.Sid))
    return result("identity-mismatch");
  return result("authenticated");
}
